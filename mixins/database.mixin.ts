'use strict';

import _ from 'lodash';
import { Context } from 'moleculer';
import filtersMixin from 'moleculer-knex-filters';
import { config } from '../knexfile';
import { parseToJsonIfNeeded } from '../utils';
const DbService = require('@moleculer/database').Service;

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

      async update(ctx: any) {
        return this.updateEntity(
          ctx,
          {
            ...ctx.params,
          },
          {
            ...ctx.options,
          }
        );
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
      async applyFilterFunction(
        ctx: Context<{ query: { [key: string]: any } }>
      ) {
        ctx.params.query = parseToJsonIfNeeded(ctx.params.query);

        if (!ctx.params?.query) {
          return ctx;
        }

        for (const key of Object.keys(ctx.params.query)) {
          if (this.settings?.fields?.[key]?.filterFn) {
            if (typeof this.settings?.fields?.[key]?.filterFn === 'function') {
              ctx.params.query[key] = await this.settings?.fields?.[
                key
              ]?.filterFn({
                value: ctx.params.query[key],
                query: ctx.params.query,
              });
            }
          }
        }

        return ctx;
      },
    },
    hooks: {
      before: {
        find: 'applyFilterFunction',
        list: 'applyFilterFunction',
      },
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
