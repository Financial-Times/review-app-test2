const knex = require('knex');
knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
})
console.log(knex)
console.log('Done4!')
console.log(process.env.FOO)