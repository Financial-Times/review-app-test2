require('isomorphic-fetch');
const pRetry = require('p-retry');

//const herokuAuthToken = require('../lib/heroku-auth-token');
const herokuAuthToken = () => Promise.resolve('HEROKU_TOKEN')
//const { info: pipelineInfo } = require('../lib/pipelines');

const herokuToken = '5e5f321b-6dfb-4d36-9ea2-caf9096db362'

const pipelineInfo = async (pipelineName) => {
  const res = await fetch(`https://api.heroku.com/pipelines/${pipelineName}`, {
		headers: {
      Accept: 'Accept: application/vnd.heroku+json; version=3',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${herokuToken}`
    }
	});
  const json = await res.json();
  return json;
}

const REVIEW_APPS_URL = 'https://api.heroku.com/review-apps';

const DEFAULT_HEADERS = {
	'Accept': 'application/vnd.heroku+json; version=3',
	'Content-Type': 'application/json'
};

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
const getPipelineReviewAppsUrl = pipelineId => `https://api.heroku.com/pipelines/${pipelineId}/review-apps`;
const getAppUrl = appId => `https://api.heroku.com/apps/${appId}`;
const getGithubArchiveUrl = ({ repoName, branch }) => `https://api.github.com/repos/Financial-Times/${repoName}/tarball/${branch}`;

function herokuHeaders ({ useReviewAppApi } = {}) {
	const defaultHeaders = useReviewAppApi
		? Object.assign({}, DEFAULT_HEADERS, {
			Accept: 'application/vnd.heroku+json; version=3.review-apps',
		})
		: DEFAULT_HEADERS;
	return herokuAuthToken()
		.then(key => {
			return {
				...defaultHeaders,
				Authorization: `Bearer ${key}`
			};
		});
}

const throwIfNotOk = async res => {
	const { ok, status, url } = res;
	if (!ok) {
		const errorBody = await res.json();

		console.error('Fetch error:', status, url, errorBody); // eslint-disable-line no-console
		throw errorBody;
	}
	return res;
};

const getGithubArchiveRedirectUrl = ({ repoName, branch, githubToken }) => {
	const url = getGithubArchiveUrl({ repoName, branch });

	return fetch(url, {
		headers: {
			Authorization: `token ${githubToken}`
		},
		redirect: 'manual' // Don't follow redirect, just want the URL
	}).then(res => {
		if (res.status !== 302) {
			throw new Error(`Unexpected response for ${url} (${status})`);
		}

		const { headers: { _headers: { location } } } = res;
		const [ redirectUrl ] = location || [];

		return redirectUrl;
	});
};

const waitTillReviewAppCreated = (data) => {
	const { id } = data;
	const checkForCreatedStatus = async () => {
		const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.heroku+json; version=3.review-apps',
      Authorization: `Bearer ${herokuToken}`
    }
		const result = await fetch(getReviewAppUrl(id), {
			headers
		})
			.then(throwIfNotOk)
			.then(res => res.json())
			.then(data => {
				const { status, message, app } = data;

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

const getAppName = async (appId) => {
	const headers = await herokuHeaders();
	return fetch(getAppUrl(appId), {
		headers
	})
		.then(throwIfNotOk)
		.then(res => res.json())
		.then((result) => {
			const { name } = result;
			return name;
		});
};

const deleteGitBranchReviewApp = ({ pipelineId, branch, headers }) => {
	const getReviewAppId = (pipelineId) => fetch(getPipelineReviewAppsUrl(pipelineId), {
		headers
	})
		.then(throwIfNotOk)
		.then(res => res.json())
		.then((reviewApps = []) =>
			reviewApps.find(
				({ branch: reviewAppBranch }) => branch === reviewAppBranch)
			)
		.then(({ id }) => id);
	const deleteReviewApp = (reviewAppId) => fetch(getReviewAppUrl(reviewAppId), {
		headers,
		method: 'delete'
	}).then(throwIfNotOk);

	return getReviewAppId(pipelineId).then(deleteReviewApp);
};

async function task (app, options) {
	const { repoName, branch, commit, githubToken } = options;

	const { id: pipelineId } = await pipelineInfo(app);
	const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/vnd.heroku+json; version=3.review-apps',
    Authorization: `Bearer ${herokuToken}`
  }
	const body = {
		pipeline: pipelineId,
		branch,
		source_blob: {
			url: await getGithubArchiveRedirectUrl({ repoName, branch, githubToken }),
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
			if (status === 409) {
				console.error(`Review app already created for ${branch} branch. Deleting existing review app first.`); // eslint-disable-line no-console
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
			console.log(appName); // eslint-disable-line no-console
		});
}

(async () => {
  // try {
  //   const res = await pipelineInfo('my-pipeline')
  //   const json = await res.json()
  //   console.log(res)
  // } catch (err) {
  //   console.log(err)
  // }
  await task('ys-pipeline', { 
    repoName: 'review-app-test2',
    branch: 'branch2',
    commit: '63bab90957e024468ff28e2151b4e00ad295891e',
    githubToken: 'e696faeeec6127e22bacbe24b8a55466f18fb7ba'
  })
})();

/**
* Assume
* 	* app is VAULT_SOURCE, and is package.json name (could assume it's the package.json name, like `nht configure`)
*/
// module.exports = function (program) {
// 	program
// 		.command('review-app [app]')
// 		.description('Create a heroku review app and print out the app name created')
// 		.option('-r, --repo-name <name>', 'github repository name')
// 		.option('-b, --branch <name>', 'branch of the review app')
// 		.option('-c, --commit <commit>', 'commit SHA-1')
// 		.option('-g, --github-token <token>', 'github personal token to access source code (generate from https://github.com/settings/tokens)')
// 		.action(async function (app, options) {
// 			try {
// 				await task(app, options);
// 			} catch (error) {
// 				console.error(error); // eslint-disable-line no-console
// 				process.exit(1);
// 				return;
// 			}
// 		});
// };