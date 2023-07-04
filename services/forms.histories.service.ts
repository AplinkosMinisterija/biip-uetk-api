'use strict';

import moleculer from 'moleculer';
import { Service } from 'moleculer-decorators';

import DbConnection from '../mixins/database.mixin';
import {
  COMMON_DEFAULT_SCOPES,
  COMMON_SCOPES,
  COMMON_HIDDEN_FIELDS,
} from '../types';

export const FormHistoryTypes = {
  CREATED: 'CREATED',
  UPDATED: 'UPDATED',
  REJECTED: 'REJECTED',
  RETURNED: 'RETURNED',
  APPROVED: 'APPROVED',
};

@Service({
  name: 'forms.histories',

  mixins: [
    DbConnection({
      collection: 'formHistories',
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
        enum: Object.values(FormHistoryTypes),
      },

      form: {
        type: 'number',
        columnType: 'integer',
        columnName: 'formId',
        required: true,
        immutable: true,
        populate: 'forms.resolve',
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
export default class FormHistoriesService extends moleculer.Service {}
