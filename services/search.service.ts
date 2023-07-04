'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import { DBPagination } from '../types';
import { AuthType } from './api.service';

type GisFeature = {
  area: number;
  cadastral_id: string;
  category: string;
  lat: number;
  lon: number;
  municipality: string;
  name: string;
};

@Service({
  name: 'search',
})
export default class SearchService extends moleculer.Service {
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
        default: ['name', 'cadastral_id', 'municipality'],
      },
      pageSize: {
        type: 'number',
        convert: true,
        integer: true,
        optional: true,
        default: 10,
        min: 1,
      },
      page: {
        type: 'number',
        convert: true,
        integer: true,
        min: 1,
        optional: true,
        default: 1,
      },
    },
  })
  async search(
    ctx: Context<{
      search?: String;
      searchFields: string[];
      pageSize: number;
      page: number;
    }>
  ): Promise<DBPagination<GisFeature>> {
    const search = ctx.params.search || '';
    const { page, pageSize, searchFields } = ctx.params;

    let rows: any[] = await this.getGisData();

    if (!!search) {
      rows = rows.filter((f: any) => {
        const props = f.properties;

        return searchFields.some((sField) => {
          if (!props[sField]) return false;

          if (typeof props[sField] === 'string') {
            const regex = new RegExp(`${search}`, 'gi');
            return regex.test(props[sField]);
          }
        });
      });
    }

    const itemsStart = (page - 1) * pageSize;
    const itemsEnd = itemsStart + pageSize;
    const rowsInPage = rows.slice(itemsStart, itemsEnd);
    const total = rows.length;

    return {
      rows: rowsInPage,
      total,
      pageSize,
      page,
      totalPages: Math.floor((total + pageSize - 1) / pageSize),
    };
  }

  @Method
  async getGisData(): Promise<GisFeature[]> {
    const redisKey = 'search.gis.data';
    const cachedResult = await this.broker.cacher.get(redisKey);

    if (cachedResult) {
      return cachedResult as GisFeature[];
    }

    const host = process.env.QGIS_SERVER_HOST || 'https://gis.biip.lt';
    const url = `${host}/qgisserver/uetk_zuvinimas?SERVICE=WFS&REQUEST=GetFeature&TYPENAME=uetk_zuvinimas_info&OUTPUTFORMAT=application/json`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = await res.json();

    const result = data?.features || [];

    await this.broker.cacher.set(redisKey, result);

    return data?.features || [];
  }
}
