'use strict';

import moleculer, { Context, RestSchema } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';

import { FeatureCollection } from 'geojsonjs';
import { gisConfig } from '../knexfile';
import DbConnection from '../mixins/database.mixin';
import { throwBadRequestError } from '../types';

import { snakeCase } from 'lodash';
import PostgisMixin from 'moleculer-postgis';
import {
  getDamOfLandsQuery,
  getExcessWaterCulvertQuery,
  getFishPassagesQuery,
  getHidroPowerPlantsQuery,
  getLakesAndPondsQuery,
  getRiversQuery,
  parseToJsonIfNeeded,
} from '../utils';
import { AuthType } from './api.service';
const tableName = 'publishing.uetkMerged';

export type UETKObject = {
  id: string;
  name: string;
  cadastralId: string;
  category: string;
  categoryTranslate: string;
  municipality: string;
  municipalityCode: number;
  area: number;
  length: number;
  lat: number;
  lng: number;
  geom: FeatureCollection;
};
export const UETKObjectType = {
  RIVER: 'RIVER',
  CANAL: 'CANAL',
  INTERMEDIATE_WATER_BODY: 'INTERMEDIATE_WATER_BODY',
  TERRITORIAL_WATER_BODY: 'TERRITORIAL_WATER_BODY',
  NATURAL_LAKE: 'NATURAL_LAKE',
  PONDED_LAKE: 'PONDED_LAKE',
  POND: 'POND',
  ISOLATED_WATER_BODY: 'ISOLATED_WATER_BODY',
  EARTH_DAM: 'EARTH_DAM',
  WATER_EXCESS_CULVERT: 'WATER_EXCESS_CULVERT',
  HYDRO_POWER_PLANT: 'HYDRO_POWER_PLANT',
  FISH_PASS: 'FISH_PASS',
};

export const UETKObjectTypeTranslates = {
  [UETKObjectType.RIVER]: 'Upė',
  [UETKObjectType.CANAL]: 'Kanalas',
  [UETKObjectType.INTERMEDIATE_WATER_BODY]: 'Tarpinis vandens telkinys',
  [UETKObjectType.TERRITORIAL_WATER_BODY]: 'Teritorinis vandens telkinys',
  [UETKObjectType.NATURAL_LAKE]: 'Natūralus ežeras',
  [UETKObjectType.PONDED_LAKE]: 'Patvenktas ežeras',
  [UETKObjectType.POND]: 'Tvenkinys',
  [UETKObjectType.ISOLATED_WATER_BODY]:
    'Nepratekamas dirbtinis paviršinis vandens telkinys',
  [UETKObjectType.EARTH_DAM]: 'Žemių užtvanka',
  [UETKObjectType.WATER_EXCESS_CULVERT]: 'Vandens pertekliaus pralaida',
  [UETKObjectType.HYDRO_POWER_PLANT]: 'Hidroelektrinė',
  [UETKObjectType.FISH_PASS]: 'Žuvų pralaida',
};

// Kategoriju ID
// 1	Upė
// 2	Kanalas
// 3	Natūralus ežeras +
// 4	Patvenktas ežeras
// 5	Tvenkinys
// 6	Nepratekamas dirbtinis paviršinis vandens telkinys
// 7	Tarpinis vandens telkinys

@Service({
  name: 'objects',

  mixins: [
    DbConnection({
      collection: tableName,
      config: gisConfig,
      rest: false,
      createActions: {
        create: false,
        update: false,
        remove: false,
        get: false,
        createMany: false,
        removeAllEntities: false,
      },
    }),
    PostgisMixin({
      srid: 3346,
    }),
  ],

  settings: {
    fields: {
      id: 'string',
      cadastralId: 'string',
      name: 'string',
      category: {
        type: 'string',
        columnName: 'assignedCategory',
      },
      categoryTranslate: {
        type: 'string',
        get({ entity }: any) {
          return UETKObjectTypeTranslates[entity.assignedCategory] || '';
        },
      },
      municipality: 'string',
      municipalityCode: 'number',
      area: {
        type: 'number',
        get: ({ value }: any) => Number(value),
      },
      length: {
        type: 'number',
        get: ({ value }: any) => Number(value),
      },
      lat: {
        type: 'number',
        get: ({ value }: any) => Number(value),
      },
      lng: {
        type: 'number',
        columnName: 'lon',
        get: ({ value }: any) => Number(value),
      },
      geom: {
        type: 'any',
        geom: {
          type: 'geom',
        },
      },
      extendedData: {
        virtual: true,
        type: 'object',
        async populate(ctx: any, _values: any, objects: any[]) {
          const riverTypes = [UETKObjectType.RIVER, UETKObjectType.CANAL];
          const lakesAndPondsTypes = [
            UETKObjectType.INTERMEDIATE_WATER_BODY,
            UETKObjectType.TERRITORIAL_WATER_BODY,
            UETKObjectType.NATURAL_LAKE,
            UETKObjectType.PONDED_LAKE,
            UETKObjectType.POND,
            UETKObjectType.ISOLATED_WATER_BODY,
          ];
          const fishPassagesTypes = [UETKObjectType.FISH_PASS];
          const hydroPowerPlantTypes = [UETKObjectType.HYDRO_POWER_PLANT];
          const earthDamTypes = [UETKObjectType.EARTH_DAM];
          const waterExcessCulvertTypes = [UETKObjectType.WATER_EXCESS_CULVERT];

          function getItemId(item: any) {
            return (
              item.cadastralId || item.kadastroId || item.hidrostatinioKodas
            );
          }
          function mapByCategoryIds(types: string[]) {
            return objects
              .filter((o) => types.includes(o.assignedCategory))
              .map((o) => getItemId(o));
          }
          async function getItemsByCadastralId(
            fn: Function,
            cadastralIds: string[]
          ) {
            if (!cadastralIds?.length) return {};

            const items: any[] = await fn(cadastralIds);
            return items?.reduce(
              (acc: any, item: any) => ({
                ...acc,
                [getItemId(item)]: item,
              }),
              {}
            );
          }

          const riversIds = mapByCategoryIds(riverTypes);
          const lakesAndPondsIds = mapByCategoryIds(lakesAndPondsTypes);
          const fishPassagesIds = mapByCategoryIds(fishPassagesTypes);
          const powerPlantsIds = mapByCategoryIds(hydroPowerPlantTypes);
          const earthDamsIds = mapByCategoryIds(earthDamTypes);
          const culvertsIds = mapByCategoryIds(waterExcessCulvertTypes);

          const result = await Promise.all([
            getItemsByCadastralId(getRiversQuery, riversIds),
            getItemsByCadastralId(getLakesAndPondsQuery, lakesAndPondsIds),
            getItemsByCadastralId(getFishPassagesQuery, fishPassagesIds),
            getItemsByCadastralId(getHidroPowerPlantsQuery, powerPlantsIds),
            getItemsByCadastralId(getDamOfLandsQuery, earthDamsIds),
            getItemsByCadastralId(getExcessWaterCulvertQuery, culvertsIds),
          ]);

          const itemsByCadastralId = Object.values(result).reduce(
            (acc: any, item: any) => ({ ...acc, ...item }),
            {}
          );

          return objects.map((o) => itemsByCadastralId[getItemId(o)]);
        },
      },
    },
  },
})
export default class ObjectsService extends moleculer.Service {
  @Action({
    rest: 'GET /',
    auth: AuthType.PUBLIC,
    params: {
      search: {
        type: 'string',
        optional: true,
      },
      searchFields: {
        type: 'array',
        optional: true,
        items: 'string',
        default: ['name', 'cadastralId'],
      },
    },
  })
  async search(
    ctx: Context<{
      search?: string;
      searchFields: string[];
      query: any;
    }>
  ) {
    const { search, searchFields } = ctx.params;
    const query = parseToJsonIfNeeded(ctx.params.query);
    delete ctx.params.search;
    delete ctx.params.searchFields;

    const searchValueFixed = search?.replace(
      /([-[\]{}()*+?.,%\\^$|#\s;])/gi,
      '\\$&'
    );

    if (/[;%]/gi.test(search)) {
      throwBadRequestError('Invalid search', { search });
    }

    const textQuery = searchFields
      .map((field) => {
        field = this.settings.fields?.[field]?.columnName || field;
        return `"${snakeCase(field)}" ilike '%${searchValueFixed}%'`;
      })
      .join(' OR ');

    return ctx.call('objects.list', {
      ...ctx.params,
      query: { ...(query || {}), ...(search ? { $raw: textQuery } : {}) },
      sort: 'name',
    });
  }

  @Action({
    rest: <RestSchema>{
      method: 'GET',
      basePath: '/public/statistics',
      path: '/',
    },
    auth: AuthType.PUBLIC,
    // todo cache
  })
  async publicStatistics(ctx: Context<{}>) {
    const UETKObjects: UETKObject[] = await ctx.call('objects.find');

    return UETKObjects.reduce((groupedUETKObjects, currentUETKObject) => {
      groupedUETKObjects[currentUETKObject?.category] =
        groupedUETKObjects?.[currentUETKObject?.category] || {};

      groupedUETKObjects[currentUETKObject?.category].count =
        (groupedUETKObjects[currentUETKObject.category]?.count || 0) + 1;

      if (currentUETKObject?.area) {
        groupedUETKObjects[currentUETKObject?.category].area = Number(
          (
            (groupedUETKObjects[currentUETKObject.category]?.area || 0) +
            currentUETKObject.area / 10000
          ).toFixed(2)
        ); // convert to ha
      }

      if (currentUETKObject?.length) {
        groupedUETKObjects[currentUETKObject?.category].length = Number(
          (
            (groupedUETKObjects[currentUETKObject.category]?.length || 0) +
            currentUETKObject.length / 1000
          ).toFixed(2)
        ); // convert to km
      }

      return groupedUETKObjects;
    }, {} as { [key: string]: { count?: number; length?: number; area?: number } });
  }
}
