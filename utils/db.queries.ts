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

export async function getFishPassagesQuery(filter?: {
  cadastralIds?: number[] | string[];
  limit?: number;
}) {
  const adapter = getGisAdapter();
  const query = adapter
    .select('*')
    .select(adapter.client.raw("'zuvu_pralaida' as object_subtype"))
    .from('uetk.israsaiZuvuPralaidos');

  if (filter?.cadastralIds?.length) {
    query.whereIn('hidrostatinioKodas', filter.cadastralIds);
  }

  if (filter?.limit) {
    query.limit(filter.limit);
  }

  return query;
}

export async function getHidroPowerPlantsQuery(filter?: {
  cadastralIds?: number[] | string[];
  limit?: number;
}) {
  const adapter = getGisAdapter();
  const query = adapter
    .select('*')
    .select(adapter.client.raw("'hidroelektrine' as object_subtype"))
    .from('uetk.israsaiHidroelektrines');

  if (filter?.cadastralIds?.length) {
    query.whereIn('hidrostatinioKodas', filter.cadastralIds);
  }

  if (filter?.limit) {
    query.limit(filter.limit);
  }

  return query;
}

export async function getDamOfLandsQuery(filter?: {
  cadastralIds?: number[] | string[];
  limit?: number;
}) {
  const adapter = getGisAdapter();
  const query = adapter
    .select('*')
    .select(adapter.client.raw("'zemiu_uztvanka' as object_subtype"))
    .from('uetk.israsaiZemiuUztvankos');

  if (filter?.cadastralIds?.length) {
    query.whereIn('hidrostatinioKodas', filter.cadastralIds);
  }

  if (filter?.limit) {
    query.limit(filter.limit);
  }

  return query;
}

export async function getExcessWaterCulvertQuery(filter?: {
  cadastralIds?: number[] | string[];
  limit?: number;
}) {
  const adapter = getGisAdapter();
  const query = adapter
    .select('*')
    .select(
      adapter.client.raw("'vandens_pertekliaus_pralaida' as object_subtype")
    )
    .from('uetk.israsaiVandensPertekliausPralaidos');

  if (filter?.cadastralIds?.length) {
    query.whereIn('hidrostatinioKodas', filter.cadastralIds);
  }

  if (filter?.limit) {
    query.limit(filter.limit);
  }

  return query;
}
