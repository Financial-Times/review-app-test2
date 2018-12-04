console.log('From Worker')
setTimeout(() => {
  console.log('Inside timeout4')
  process.exit(0)
}, 10000)