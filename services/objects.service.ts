'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';

import DbConnection from '../mixins/database.mixin';
import { gisConfig } from '../knexfile';
import GeometriesMixin from '../mixins/geometries.mixin';
import { throwNotFoundError } from '../types';
import {
  GeomFeatureCollection,
  geometriesToGeomCollection,
  geometryFromText,
} from '../modules/geometry';
import { snakeCase } from 'lodash';
import {
  getDamOfLandsQuery,
  getExcessWaterCulvertQuery,
  getFishPassagesQuery,
  getHidroPowerPlantsQuery,
  getLakesAndPondsQuery,
  getRiversQuery,
} from '../utils';
const tableName = 'publishing.uetkMerged';

export type UETKObject = {
  id: string;
  name: string;
  cadastralId: string;
  category: string;
  categoryTranslate: string;
  municipality: string;
  area: number;
  length: number;
  lat: number;
  lng: number;
  geom: GeomFeatureCollection;
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
  [UETKObjectType.FISH_PASS]: 'Žuvų perlaida',
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
    GeometriesMixin,
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
      area: 'number',
      length: 'number',
      lat: {
        type: 'number',
        convert: true,
      },
      lng: {
        type: 'number',
        columnName: 'lon',
      },
      geom: {
        type: 'any',
        raw: true,
        get({ value }: any) {
          if (typeof value === 'string') return;
          return value;
        },
        async populate(ctx: any, _values: any, objects: any[]) {
          const result = await ctx.call('objects.getGeometryJson', {
            id: objects.map((o) => o.id),
          });

          return objects.map((o) => result[`${o.id}`] || {});
        },
      },
      data: {
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

            const items: any[] = await fn({ cadastralIds });
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
    params: {
      id: [
        {
          type: 'array',
          items: {
            type: 'string',
            convert: true,
          },
        },
        {
          type: 'string',
          convert: true,
        },
      ],
      mapping: {
        type: 'boolean',
        default: false,
      },
    },
  })
  async findByCadastralId(
    ctx: Context<{ id: string | string[]; mapping?: boolean }>
  ) {
    const { id, mapping } = ctx.params;
    const multi = Array.isArray(id);

    const query: any = {
      cadastralId: id,
    };

    if (multi) {
      query.cadastralId = { $in: id };
    }

    const params: any = {};

    if (mapping) {
      params.mapping = 'cadastralId';
    }

    if (multi) {
      return ctx.call(`objects.find`, { query, ...params });
    }

    const obj: UETKObject = await ctx.call('objects.findOne', { query });

    if (!obj?.cadastralId) {
      return throwNotFoundError('Object not found');
    }

    if (mapping) {
      return {
        [obj.cadastralId]: obj,
      };
    }

    return obj;
  }

  @Action({
    params: {
      geom: {
        type: 'object',
        convert: true,
      },
    },
  })
  async findByGeom(ctx: Context<{ geom: GeomFeatureCollection }>) {
    const { geom } = ctx.params;
    if (!geom?.features?.length) return [];

    const geomItems = geom.features.map((i) => i.geometry).filter((i) => !!i);

    if (!geomItems?.length) return [];

    const value = geometriesToGeomCollection(geomItems);

    return ctx.call('objects.list', {
      query: {
        $raw: `st_intersects(geom, ${geometryFromText(value)})`,
      },
    });
  }
}
