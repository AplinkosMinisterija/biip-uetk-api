'use strict';

import _ from 'lodash';
const DbService = require('@moleculer/database').Service;
import { config } from '../knexfile';
import filtersMixin from 'moleculer-knex-filters';
import { Context } from 'moleculer';

export default function (opts: any = {}) {
  const adapter: any = {
    type: 'Knex',
    options: {
      knex: opts.config || config,
      tableName: opts.collection,
    },
  };

  const cache = {
    enabled: false,
  };

  opts.entityChangedOldEntity = true;

  opts = _.defaultsDeep(opts, { adapter }, { cache: opts.cache || cache });

  const removeRestActions: any = {};

  if (opts?.createActions === undefined || opts?.createActions !== false) {
    removeRestActions.replace = {
      rest: null as any,
    };
  }

  const schema = {
    mixins: [DbService(opts), filtersMixin()],

    async started() {},

    actions: {
      ...removeRestActions,

      async findOne(ctx: any) {
        const result: any[] = await this.actions.find(ctx.params);
        if (result.length) return result[0];
        return;
      },

      async removeAllEntities(ctx: any) {
        return await this.clearEntities(ctx);
      },
    },

    methods: {
      filterQueryIds(ids: number[], queryIds?: any) {
        if (!queryIds) return ids;

        queryIds = (Array.isArray(queryIds) ? queryIds : [queryIds]).map(
          (id: any) => parseInt(id)
        );

        return ids.filter((id) => queryIds.indexOf(id) >= 0);
      },
    },
    hooks: {
      after: {
        find: [
          async function (
            ctx: Context<{
              mapping: string;
              mappingMulti: boolean;
              mappingField: string;
            }>,
            data: any[]
          ) {
            if (ctx.params.mapping) {
              const { mapping, mappingMulti, mappingField } = ctx.params;
              return data?.reduce((acc: any, item) => {
                let value: any = item;

                if (mappingField) {
                  value = item[mappingField];
                }

                if (mappingMulti) {
                  return {
                    ...acc,
                    [`${item[mapping]}`]: [
                      ...(acc[`${item[mapping]}`] || []),
                      value,
                    ],
                  };
                }

                return { ...acc, [`${item[mapping]}`]: value };
              }, {});
            }
            return data;
          },
        ],
      },
    },

    merged(schema: any) {
      if (schema.actions) {
        for (const action in schema.actions) {
          const params = schema.actions[action].additionalParams;
          if (typeof params === 'object') {
            schema.actions[action].params = {
              ...schema.actions[action].params,
              ...params,
            };
          }
        }
      }
    },
  };

  return schema;
}
