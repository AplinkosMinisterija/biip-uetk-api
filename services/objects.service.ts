'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';

import DbConnection from '../mixins/database.mixin';
import { gisConfig } from '../knexfile';
import GeometriesMixin from '../mixins/geometries.mixin';
import { throwNotFoundError } from '../types';
import { GeomFeatureCollection } from '../modules/geometry';

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
      collection: 'publishing.uetkMerged',
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
}
