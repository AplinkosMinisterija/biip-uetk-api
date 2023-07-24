import knex, { Knex } from 'knex';
import _ from 'lodash';
import { gisConfig } from '../knexfile';

let knexAdapter: Knex;
const getGisAdapter = () => {
  if (knexAdapter) return knexAdapter;

  knexAdapter = knex(gisConfig);
  return knexAdapter;
};

export async function getLakesAndPonds() {
  const adapter = getGisAdapter();
  const query = adapter.select('*').limit(50).from('uetk.israsaiEzeraiTvenkiniai');
  return query;
}
