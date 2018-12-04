require('isomorphic-fetch');
const pRetry = require('p-retry');
const denodeify = require('denodeify');

// ENV variables.
const pipeline = process.env.PIPELINE
const repo = process.env.REPO
const githubToken = process.env.GITHUB_TOKEN
const herokuToken = process.env.HEROKU_TOKEN

// API headers.
const githubHeaders =  {
  'Authorization': `token ${githubToken}`,
  'Accept': 'application/vnd.github.v3+json'
}
const herokuHeaders = {
  'Content-Type': 'application/json',
  'Accept': 'application/vnd.heroku+json; version=3.review-apps',
  'Authorization': `Bearer ${herokuToken}`
}

const NUM_RETRIES = 30;
const RETRY_EXP_BACK_OFF_FACTOR = 1;
const RETRY_INTERVAL = 10 * 1000;
const REVIEW_APP_STATUSES = {
	pending: 'pending',
	deleted: 'deleted',
	creating: 'creating',
	created: 'created'
};

const getReviewAppUrl = reviewAppId => `https://api.heroku.com/review-apps/${reviewAppId}`;
const getAppUrl = appId => `https://api.heroku.com/apps/${appId}`;
const REVIEW_APPS_URL = 'https://api.heroku.com/review-apps';
const exec = denodeify(require('child_process').exec, function (err, stdout) { return [err, stdout]; });

// Common error handling.
const throwIfNotOk = async res => {
	const { ok, status, url } = res;
	if (!ok) {
		const errorBody = await res.json();
		console.error('Fetch error:', status, url, errorBody);
		throw errorBody;
	}
	return res;
};

// TODO: could be a const.
const getPipelineId = async pipeline => {
  console.log(`Getting pipeline "${pipeline}" id...`);
  const res = await fetch(`https://api.heroku.com/pipelines/${pipeline}`, {
		headers: herokuHeaders
	});
  const json = await res.json();
  console.log(`Got id for pipeline: ${json.id}`)
  return json.id;
}

// Get current branch name by running shell command.
const getBranchName = async () => {
  console.log(`Getting branch name...`);
  const branches = await exec(`git branch`)
  const name = branches.split(/\n/)[0].replace('*', '').trim()
  console.log(`Got branch name: ${name}`);
  return name
}

// Get last commit name by running shell command.
const getLastCommit = async (branch) => {
  console.log(`API: Getting last commit for branch: ${branch}...`);
  // We can use github API as well.
  const res = await fetch(`https://api.github.com/repos/Financial-Times/${repo}/commits/${branch}`, {
    headers: githubHeaders
  });
  const json = await res.json();
  console.log(`API: Got last commit: ${json.sha}`);
  //return json.sha; // last commit.

  // Using the shell.
  console.log(`Shell: Getting last commit for branch: ${branch}...`);
  const lastCommit = await exec('git rev-parse HEAD')
  console.log(`Shell: Got last commit: ${lastCommit}`);
  return lastCommit;
}

// We need to set the 'source_blob' param in the create review-app api call.
// from the docs: "URL where gzipped tar archive of source code for build was downloaded."
const getGithubArchiveRedirectUrl = async (branch) => {
  console.log(`Getting github archived redirect url for branch: ${branch}...`);
  const url = `https://api.github.com/repos/Financial-Times/${repo}/tarball/${branch}`;
  const res = await fetch(url, {
		headers: githubHeaders,
		redirect: 'manual' // Don't follow redirect, just want the URL
  })
  if (res.status !== 302) {
    throw new Error(`Unexpected response for ${url} (${res.status})`);
  }
  const { headers: { _headers: { location } } } = res;
  const [ redirectUrl ] = location || [];
  console.log(`Github archived redirect url: ${redirectUrl}`)
  return redirectUrl;
}

// Check if the new review-app has been created in heroku,
// if not, we use the 'pRetry' npm module for retries.
const waitTillReviewAppCreated = (data) => {
  const { id } = data;
  const checkForCreatedStatus = async () => {
    const headers = herokuHeaders
    const result = await fetch(getReviewAppUrl(id), {
      headers
    })
      .then(throwIfNotOk)
      .then(res => res.json())
      .then(data => {
        const { status, message, app } = data;
        if (status == 'errored') console.log(data)
        if (status === REVIEW_APP_STATUSES.deleted) {
          throw new pRetry.AbortError(`Review app was deleted: ${message}`);
        }

        if (status !== REVIEW_APP_STATUSES.created) {
          const appIdOutput = (status === REVIEW_APP_STATUSES.creating)
            ? `, appId: ${app.id}`
            : '';
          throw new Error(`Review app not created yet. Current status: ${status}${appIdOutput}`);
        };

        return app.id;
      });
    return result;
  };

  return pRetry(checkForCreatedStatus, {
    factor: RETRY_EXP_BACK_OFF_FACTOR,
    retries: NUM_RETRIES,
    minTimeout: RETRY_INTERVAL,
    onFailedAttempt: (err) => {
      const { attemptNumber, message } = err;
      console.error(`${attemptNumber}/${NUM_RETRIES}: ${message}`); // eslint-disable-line no-console
    }
  });
};

// Get the new review-app name.
const getAppName = async (appId) => {
  const headers = herokuHeaders;
  return fetch(getAppUrl(appId), {
    headers
  })
    .then(throwIfNotOk)
    .then(res => res.json())
    .then((result) => {
      console.log('0000000000000000000000', result)
      const { name } = result;
      return name;
    });
};

const deleteGitBranchReviewApp = ({ pipelineId, branch, headers }) => {
	const getReviewAppId = (pipelineId) => fetch(`https://api.heroku.com/pipelines/${pipelineId}/review-apps`, {
		headers
	})
  .then(throwIfNotOk)
  .then(res => res.json())
  // Find the review app for the current branch.
  .then((reviewApps = []) => reviewApps.find(({ branch: reviewAppBranch }) => branch === reviewAppBranch)) 
  .then(({ id }) => id);
  
  // Delete API.
	const deleteReviewApp = (reviewAppId) => fetch(getReviewAppUrl(reviewAppId), {
		headers,
		method: 'delete'
	}).then((res) => {
    console.log(`Review-app: ${reviewAppId} was deleted`)
    throwIfNotOk(res)
  });

	return getReviewAppId(pipelineId).then(deleteReviewApp);
};

// Create the review-app.
// if its already exist, delete it and re-create it.
const createReviewApp = async (branch, commit, pipelineId) => {
  console.log(`Creating review app for branch: ${branch}, commit: ${commit} & pipelineId ${pipelineId}...`)
  const headers = herokuHeaders;
  const body = {
		pipeline: pipelineId,
		branch,
		source_blob: {
			url: await getGithubArchiveRedirectUrl(branch),
			version: commit
		}
  };
  const createReviewApp = () => fetch(REVIEW_APPS_URL, {
    headers,
    method: 'post',
    body: JSON.stringify(body)
  });
	return createReviewApp()
		.then(res => {
			const { status } = res;
			if (status === 409) { // conflict an old version of the review app is already exist.
        console.error(`Review app already created for ${branch} branch. Deleting existing review app first.`);
        // Delete and re-create it.
        return deleteGitBranchReviewApp({ pipelineId, branch, headers })
				  .then(createReviewApp);
			}
			return res;
		})
		.then(throwIfNotOk)
		.then(res => res.json())
		.then(waitTillReviewAppCreated)
		.then(getAppName)
		.then(appName => {
			console.log(`New review-app name: ${appName}`);
		});
}
  
const init = async () => {
  try {
    console.log('Starting process...')
    const pipelineId = await getPipelineId(pipeline); // const
    const branchName = await getBranchName(); // dynamic
    const lastCommit = await getLastCommit(branchName); // dynamic
    await createReviewApp(branchName, lastCommit, pipelineId);

    // TODO:
    // By now the newly creatd review-app is up and running,
    // we need to tell it to start the e2e tests and start pinging for the results
    // finally we need to exit with the right exit code.
  } catch (err) {
    console.log(err)
  }
}

init();