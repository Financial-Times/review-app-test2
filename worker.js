console.log('From Worker')
setTimeout(() => {
  console.log('Inside timeout3: branch4')
  process.exit(0)
}, 10000)