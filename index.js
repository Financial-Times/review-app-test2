// Create server

try {
console.log('inside --------------------------------1')
const express = require('express')
const app = express()
const PORT = process.env.PORT || 3000;
console.log('inside --------------------------------2')
app.get('/', (req, res) => res.send('Hello World!'))
console.log('inside --------------------------------3')
app.listen(PORT, () => console.log(`Example app listening on port ${PORT}!`))
} catch (err) {
  console.log(err)
}