const { knexSnakeCaseMappers } = require('objection');
const path = require('path');

if (!process.env.DB_CONNECTION) {
  throw new Error('No DB_CONNECTION env variable!');
}

export const config = {
  client: 'pg',
  connection: process.env.DB_CONNECTION,
  migrations: {
    tableName: 'migrations',
    directory: path.resolve('./database/migrations'),
  },
  pool: { min: 0, max: 2 },
  ...knexSnakeCaseMappers(),
};

export const gisConfig = {
  client: 'pg',
  connection: process.env.GIS_DB_CONNECTION,
  ...knexSnakeCaseMappers(),
};
