import knex, { Knex } from 'knex';
import _ from 'lodash';
import { gisConfig } from '../knexfile';

let knexAdapter: Knex;
const getGisAdapter = () => {
  if (knexAdapter) return knexAdapter;

  knexAdapter = knex(gisConfig);
  return knexAdapter;
};

export async function getLakesAndPondsQuery(cadastralIds?: string[]) {
  return getGisAdapter()
    .select('*')
    .whereIn('kadastroId', cadastralIds)
    .from('uetk.israsaiEzeraiTvenkiniai');
}

export async function getRiversQuery(cadastralIds?: string[]) {
  return getGisAdapter()
    .select('*')
    .whereIn('kadastroId', cadastralIds)
    .from('uetk.israsaiUpes');
}

export async function getFishPassagesQuery(cadastralIds?: string[]) {
  return getGisAdapter()
    .select('*')
    .whereIn('hidrostatinioKodas', cadastralIds)
    .from('uetk.israsaiZuvuPralaidos');
}

export async function getHidroPowerPlantsQuery(cadastralIds?: string[]) {
  return getGisAdapter()
    .select('*')
    .whereIn('hidrostatinioKodas', cadastralIds)
    .from('uetk.israsaiHidroelektrines');
}

export async function getDamOfLandsQuery(cadastralIds?: string[]) {
  return getGisAdapter()
    .select('*')
    .whereIn('hidrostatinioKodas', cadastralIds)
    .from('uetk.israsaiZemiuUztvankos');
}

export async function getExcessWaterCulvertQuery(cadastralIds?: string[]) {
  return getGisAdapter()
    .select('*')
    .whereIn('hidrostatinioKodas', cadastralIds)
    .from('uetk.israsaiVandensPertekliausPralaidos');
}
