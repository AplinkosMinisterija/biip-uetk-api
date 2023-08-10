import knex, { Knex } from 'knex';
import _ from 'lodash';
import { gisConfig } from '../knexfile';

let knexAdapter: Knex;
const getGisAdapter = () => {
  if (knexAdapter) return knexAdapter;

  knexAdapter = knex(gisConfig);
  return knexAdapter;
};

export async function getLakesAndPondsQuery(filter?: {
  kategorijaId?: number;
  cadastralIds?: number[] | string[];
  limit?: number;
}) {
  const adapter = getGisAdapter();
  const query = adapter.select('*').from('uetk.israsaiEzeraiTvenkiniai');

  if (filter?.kategorijaId) {
    query.where('kategorijaId', filter.kategorijaId);
  }

  if (filter?.cadastralIds?.length) {
    query.whereIn('kadastroId', filter.cadastralIds);
  }

  if (filter?.limit) {
    query.limit(filter.limit);
  }

  return query;
}

export async function getRiversQuery(filter?: {
  kategorijaId?: number;
  cadastralIds?: number[] | string[];
  limit?: number;
}) {
  const adapter = getGisAdapter();
  const query = adapter.select('*').from('uetk.israsaiUpes');

  if (filter?.kategorijaId) {
    query.where('kategorijaId', filter.kategorijaId);
  }

  if (filter?.cadastralIds?.length) {
    query.whereIn('kadastroId', filter.cadastralIds);
  }

  if (filter?.limit) {
    query.limit(filter.limit);
  }

  return query;
}
