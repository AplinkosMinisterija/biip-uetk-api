'use strict';

import moleculer from 'moleculer';
import { Service } from 'moleculer-decorators';

import DbConnection from '../mixins/database.mixin';
import {
  COMMON_DEFAULT_SCOPES,
  COMMON_SCOPES,
  COMMON_HIDDEN_FIELDS,
} from '../types';

export const RequestHistoryType = {
  CREATED: 'CREATED',
  UPDATED: 'UPDATED',
  REJECTED: 'REJECTED',
  RETURNED: 'RETURNED',
  APPROVED: 'APPROVED',
  FILE_GENERATED: 'FILE_GENERATED',
};

@Service({
  name: 'requests.histories',

  mixins: [
    DbConnection({
      collection: 'requestHistories',
      rest: false,
    }),
  ],

  settings: {
    fields: {
      id: {
        type: 'string',
        columnType: 'integer',
        primaryKey: true,
        secure: true,
      },

      type: {
        type: 'string',
        enum: Object.values(RequestHistoryType),
      },

      request: {
        type: 'number',
        columnType: 'integer',
        columnName: 'requestId',
        required: true,
        immutable: true,
        populate: 'request.resolve',
      },

      comment: 'string',

      ...COMMON_HIDDEN_FIELDS,
    },

    scopes: {
      ...COMMON_SCOPES,
    },

    defaultScopes: [...COMMON_DEFAULT_SCOPES],
  },
})
export default class RequestHistoriesService extends moleculer.Service {}
