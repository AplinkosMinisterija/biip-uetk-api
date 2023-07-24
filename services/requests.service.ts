'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Event, Method, Service } from 'moleculer-decorators';

import { AuthType, UserAuthMeta } from './api.service';
import DbConnection from '../mixins/database.mixin';
import GeometriesMixin from '../mixins/geometries.mixin';

import {
  COMMON_FIELDS,
  COMMON_DEFAULT_SCOPES,
  COMMON_SCOPES,
  FieldHookCallback,
  BaseModelInterface,
  ContextMeta,
  EntityChangedParams,
  TENANT_FIELD,
} from '../types';
import { User, UserType } from './users.service';
import _ from 'lodash';
import {
  GeomFeatureCollection,
  geometryFromText,
  geometryToGeom,
} from '../modules/geometry';
import { Tenant } from './tenants.service';
import { RequestHistoryType } from './requests.histories.service';
import { getTemplateHtml } from '../utils';
import moment from 'moment';
import { getLakesAndPonds } from '../utils/db.queries';

type RequestStatusChanged = { statusChanged: boolean };

export interface Request extends BaseModelInterface {
  status: string;
  geom: GeomFeatureCollection;
  type: string;
  objectType: string;
}

export const RequestStatus = {
  CREATED: 'CREATED',
  SUBMITTED: 'SUBMITTED',
  REJECTED: 'REJECTED',
  RETURNED: 'RETURNED',
  APPROVED: 'APPROVED',
};

const nonEditableStatuses = [RequestStatus.APPROVED, RequestStatus.REJECTED];

const VISIBLE_TO_USER_SCOPE = 'visibleToUser';

const AUTH_PROTECTED_SCOPES = [...COMMON_DEFAULT_SCOPES, VISIBLE_TO_USER_SCOPE];

const populatePermissions = (field: string) => {
  return function (
    ctx: Context<{}, UserAuthMeta>,
    _values: any,
    requests: any[]
  ) {
    const { user, profile } = ctx?.meta;
    return requests.map((request: any) => {
      const editingPermissions = this.hasPermissionToEdit(
        request,
        user,
        profile
      );
      return !!editingPermissions[field];
    });
  };
};

@Service({
  name: 'requests',

  mixins: [
    DbConnection({
      collection: 'requests',
    }),
    GeometriesMixin,
  ],

  settings: {
    fields: {
      id: {
        type: 'string',
        columnType: 'integer',
        primaryKey: true,
        secure: true,
      },

      purpose: {
        type: 'string',
      },

      delivery: {
        type: 'string',
      },

      objects: {
        type: 'array',
        columnName: 'cadastralIds',
        items: 'number',
        required: true,
      },

      geom: {
        type: 'any',
        raw: true,
        async populate(ctx: any, _values: any, requests: Request[]) {
          const result = await ctx.call('requests.getGeometryJson', {
            id: requests.map((f) => f.id),
          });

          return requests.map((request) => result[`${request.id}`] || {});
        },
      },

      status: {
        type: 'string',
        enum: Object.values(RequestStatus),
        validate: 'validateStatus',
        onCreate: () => RequestStatus.CREATED,
        onUpdate: function ({
          ctx,
          value,
        }: FieldHookCallback & ContextMeta<RequestStatusChanged>) {
          const { user } = ctx?.meta;
          if (!ctx?.meta?.statusChanged) return;
          else if (!user?.id) return value;

          return value || RequestStatus.SUBMITTED;
        },
      },

      respondedAt: {
        type: 'date',
        columnType: 'datetime',
        readonly: true,
        set: ({
          ctx,
        }: FieldHookCallback & ContextMeta<RequestStatusChanged>) => {
          const { user, statusChanged } = ctx?.meta;
          if (user?.type !== UserType.ADMIN || !statusChanged) return;
          return new Date();
        },
      },

      canEdit: {
        type: 'boolean',
        virtual: true,
        populate: populatePermissions('edit'),
      },

      canValidate: {
        type: 'boolean',
        virtual: true,
        populate: populatePermissions('validate'),
      },

      generatedFile: 'string',

      notifyEmail: {
        type: 'string',
        onCreate: ({ ctx, value }: FieldHookCallback) => {
          const { user } = ctx?.meta;
          return value || user?.email;
        },
      },

      ...TENANT_FIELD,

      ...COMMON_FIELDS,
    },

    scopes: {
      ...COMMON_SCOPES,
      visibleToUser(query: any, ctx: Context<null, UserAuthMeta>, params: any) {
        const { user, profile } = ctx?.meta;
        if (!user?.id) return query;

        const createdByUserQuery = {
          createdBy: user?.id,
          tenant: { $exists: false },
        };

        if (profile?.id) {
          return { ...query, tenant: profile.id };
        } else if (user.type === UserType.USER) {
          return { ...query, ...createdByUserQuery };
        }

        if (query.createdBy === user.id) {
          return { ...query, ...createdByUserQuery };
        }

        return query;
      },
    },

    defaultScopes: AUTH_PROTECTED_SCOPES,
  },

  hooks: {
    before: {
      create: ['parseGeomField', 'validateStatusChange'],
      update: ['parseGeomField', 'validateStatusChange'],
    },
  },

  actions: {
    update: {
      additionalParams: {
        comment: { type: 'string', optional: true },
      },
    },
  },
})
export default class RequestsService extends moleculer.Service {
  @Action({
    rest: 'GET /:id/history',
    params: {
      id: {
        type: 'number',
        convert: true,
      },
    },
  })
  async getHistory(
    ctx: Context<{
      id: number;
      page?: number;
      pageSize?: number;
    }>
  ) {
    return ctx.call(`requests.histories.list`, {
      sort: '-createdAt',
      query: {
        request: ctx.params.id,
      },
      page: ctx.params.page,
      pageSize: ctx.params.pageSize,
      populate: 'createdBy',
    });
  }

  @Action({
    rest: 'GET /test-html',
    auth: AuthType.PUBLIC,
  })
  async testHtml(ctx: Context<{}, { $responseType: string }>) {
    const obj3: any[] = await getLakesAndPonds({ kategorijaId: 3, limit: 3 });
    const obj4: any[] = await getLakesAndPonds({ kategorijaId: 4, limit: 3 });
    const obj5: any[] = await getLakesAndPonds({ kategorijaId: 5, limit: 3 });
    const obj6: any[] = await getLakesAndPonds({ kategorijaId: 6, limit: 3 });
    const obj7: any[] = await getLakesAndPonds({ kategorijaId: 7, limit: 3 });

    ctx.meta.$responseType = 'text/html';
    return getTemplateHtml('request.ejs', {
      id: 123123,
      date: '2023-01-05',
      objects: [...obj3, ...obj4, ...obj5, ...obj6, ...obj7],
      roundNumber: (number: string, digits: number = 2) => {
        return parseFloat(number).toFixed(digits);
      },
      moment,
      dateFormat: 'YYYY-MM-DD',
    });
  }

  @Method
  validateStatus({ ctx, value, entity }: FieldHookCallback) {
    const { user, profile } = ctx.meta;
    if (!value || !user?.id) return true;

    const adminStatuses = [
      RequestStatus.REJECTED,
      RequestStatus.RETURNED,
      RequestStatus.APPROVED,
    ];

    const newStatuses = [RequestStatus.CREATED];

    const error = `Cannot set status with value ${value}`;
    if (!entity?.id) {
      return newStatuses.includes(value) || error;
    }

    const editingPermissions = this.hasPermissionToEdit(entity, user, profile);

    if (editingPermissions.edit) {
      return value === RequestStatus.SUBMITTED || error;
    } else if (editingPermissions.validate) {
      return adminStatuses.includes(value) || error;
    }

    return error;
  }

  @Method
  hasPermissionToEdit(
    request: any,
    user?: User,
    profile?: Tenant
  ): {
    edit: boolean;
    validate: boolean;
  } {
    const invalid = { edit: false, validate: false };

    const tenant = request.tenant || request.tenantId;

    if (
      !request?.id ||
      [RequestStatus.APPROVED, RequestStatus.REJECTED].includes(request?.status)
    ) {
      return invalid;
    }

    if (!user?.id) {
      return {
        edit: true,
        validate: true,
      };
    }

    const isCreatedByUser = !tenant && user && user.id === request.createdBy;
    const isCreatedByTenant = profile && profile.id === tenant;

    if (isCreatedByTenant || isCreatedByUser) {
      return {
        validate: false,
        edit: [RequestStatus.RETURNED].includes(request.status),
      };
    } else if (user.type === UserType.ADMIN) {
      return {
        edit: false,
        validate: [RequestStatus.CREATED, RequestStatus.SUBMITTED].includes(
          request.status
        ),
      };
    }

    return invalid;
  }

  @Method
  async parseGeomField(
    ctx: Context<{ id?: number; type?: string; geom: GeomFeatureCollection }>
  ) {
    const { geom, id } = ctx.params;

    const errMessage = 'No geometry was passed';

    if (geom?.features?.length) {
      const adapter = await this.getAdapter(ctx);
      const table = adapter.getTable();

      try {
        const geomItem = geom.features[0];
        const value = geometryToGeom(geomItem.geometry);
        ctx.params.geom = table.client.raw(geometryFromText(value));
      } catch (err) {
        throw new moleculer.Errors.ValidationError(err.message);
      }
    }

    return ctx;
  }

  @Method
  async validateStatusChange(
    ctx: Context<{ id: number }, UserAuthMeta & RequestStatusChanged>
  ) {
    const { id } = ctx.params;

    if (!!id) {
      ctx.meta.statusChanged = true;
    }

    return ctx;
  }

  @Event()
  async 'requests.updated'(ctx: Context<EntityChangedParams<Request>>) {
    const { oldData: prevRequest, data: request } = ctx.params;

    if (prevRequest?.status !== request.status) {
      const { comment } = ctx.options?.parentCtx?.params as any;
      const typesByStatus = {
        [RequestStatus.SUBMITTED]: RequestHistoryType.UPDATED,
        [RequestStatus.REJECTED]: RequestHistoryType.REJECTED,
        [RequestStatus.RETURNED]: RequestHistoryType.RETURNED,
        [RequestStatus.APPROVED]: RequestHistoryType.APPROVED,
      };

      await ctx.call('requests.histories.create', {
        request: request.id,
        comment,
        type: typesByStatus[request.status],
      });
    }
  }

  @Event()
  async 'requests.created'(ctx: Context<EntityChangedParams<Request>>) {
    const { data: request } = ctx.params;

    await ctx.call('requests.histories.create', {
      request: request.id,
      type: RequestHistoryType.CREATED,
    });
  }
}
