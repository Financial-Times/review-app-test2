// Create server
let status = 'running'

setTimeout(() => {
  status = 'success'
}, 10000);

const express = require('express')
const app = express()
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.json({ status }))
app.listen(PORT, () => console.log(`Example app listening on port ${PORT}!`))
