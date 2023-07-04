const { knexSnakeCaseMappers } = require('objection');
const path = require("path")

if (!process.env.DB_CONNECTION) {
  throw new Error('No DB_CONNECTION env variable!');
}

const config = {
  client: "pg",
  connection: process.env.DB_CONNECTION,
  migrations: {
    tableName: 'migrations',
    directory: path.resolve('./database/migrations')
  },
  ...knexSnakeCaseMappers(),
};

export default config
module.exports = config