'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Event, Method, Service } from 'moleculer-decorators';

import { FeatureCollection } from 'geojsonjs';
import PostgisMixin, { GeometryType } from 'moleculer-postgis';
import DbConnection from '../mixins/database.mixin';
import { AuthType, UserAuthMeta } from './api.service';

import moment from 'moment';
import {
  BaseModelInterface,
  COMMON_DEFAULT_SCOPES,
  COMMON_FIELDS,
  COMMON_SCOPES,
  ContextMeta,
  EndpointType,
  EntityChangedParams,
  FieldHookCallback,
  NOTIFY_ADMIN_EMAIL,
  TENANT_FIELD,
  throwValidationError,
} from '../types';
import {
  addLeadingZeros,
  getRequestSecret,
  getTemplateHtml,
  toReadableStream,
} from '../utils';
import {
  emailCanBeSent,
  notifyOnFileGenerated,
  notifyOnRequestUpdate,
} from '../utils/mails';
import { UETKObject } from './objects.service';
import { RequestHistoryType } from './requests.histories.service';
import { Tenant } from './tenants.service';
import { User, USERS_DEFAULT_SCOPES, UserType } from './users.service';

type RequestStatusChanged = { statusChanged: boolean };
type RequestAutoApprove = { autoApprove: boolean };

export interface Request extends BaseModelInterface {
  status: string;
  geom: FeatureCollection;
  purpose: string;
  purposeValue: string;
  objects: any[];
  objectType: string;
  generatedFile: string;
  notifyEmail: string;
  tenant: number | Tenant;
  data?: {
    extended?: boolean;
  };
}

export const RequestStatus = {
  CREATED: 'CREATED',
  SUBMITTED: 'SUBMITTED',
  REJECTED: 'REJECTED',
  RETURNED: 'RETURNED',
  APPROVED: 'APPROVED',
};

export const PurposeTypes = {
  TERRITORIAL_PLANNING_DOCUMENT: 'TERRITORIAL_PLANNING_DOCUMENT',
  TECHNICAL_PROJECT: 'TECHNICAL_PROJECT',
  SCIENTIFIC_INVESTIGATION: 'SCIENTIFIC_INVESTIGATION',
  OTHER: 'OTHER',
};

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

async function validatePurposeValue({ params, value }: FieldHookCallback) {
  const { purpose } = params;

  if (purpose === PurposeTypes.OTHER && !value) {
    throwValidationError('purpose value is required');
  } else if (purpose !== PurposeTypes.OTHER && value) {
    throwValidationError('purpose value must be empty');
  }

  return value;
}

@Service({
  name: 'requests',

  mixins: [
    DbConnection({
      collection: 'requests',
    }),
    PostgisMixin({
      srid: 3346,
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

      purpose: {
        type: 'string',
        enum: Object.values(PurposeTypes),
        required: true,
      },

      purposeValue: {
        type: 'string',
        onCreate: validatePurposeValue,
        onUpdate: validatePurposeValue,
        onReplace: validatePurposeValue,
      },

      objects: {
        type: 'array',
        onCreate: ({ value }: FieldHookCallback) => value || [],
        items: {
          type: 'object',
          properties: {
            id: [
              {
                type: 'number',
                required: true,
              },
              { type: 'string', required: true },
            ],
            type: {
              type: 'string',
              required: true,
              enum: ['CADASTRAL_ID'], //, 'CATEGORY_ID'],
            },
          },
        },
        required: true,
        async populate(ctx: any, _values: any[], requests: any[]) {
          const cadastralIds = _values
            .filter((v) => v.type === 'CADASTRAL_ID' && !!v.id)
            .map((v) => v.id);

          const objs: UETKObject[] = await ctx.call('objects.find', {
            query: {
              cadastralId: { $in: cadastralIds },
            },
            mapping: 'cadastralId',
          });

          return requests.map((r) =>
            r.objects
              .map((obj: any) => {
                if (obj.type === 'CADASTRAL_ID' && obj.id) {
                  return { ...objs[obj.id], ...obj };
                }
              })
              .filter((i: any) => !!i)
          );
        },
      },

      geom: {
        type: 'any',
        geom: {
          type: 'geom',
          multi: true,
          types: [GeometryType.POLYGON, GeometryType.MULTI_POLYGON],
        },
      },

      status: {
        type: 'string',
        enum: Object.values(RequestStatus),
        default: RequestStatus.CREATED,
        validate: 'validateStatus',
        onCreate: function ({
          ctx,
        }: FieldHookCallback & ContextMeta<RequestAutoApprove>) {
          const { autoApprove } = ctx?.meta;
          return autoApprove ? RequestStatus.APPROVED : RequestStatus.CREATED;
        },
        onUpdate: function ({
          ctx,
          value,
        }: FieldHookCallback & ContextMeta<RequestStatusChanged>) {
          const { user, statusChanged } = ctx?.meta;
          if (!statusChanged) return;
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

      data: {
        type: 'object',
        properties: {
          extended: {
            type: 'boolean',
            required: false,
            default: false,
          },
        },
      },

      ...TENANT_FIELD,

      ...COMMON_FIELDS,
    },

    scopes: {
      ...COMMON_SCOPES,
      visibleToUser(query: any, ctx: Context<null, UserAuthMeta>) {
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
      async filterCategory(query: any, ctx: Context) {
        if (!query.category) return query;

        const objectsQuery: Record<string, any> = { category: query.category };

        if (query.objects) {
          objectsQuery.cadastralId = query.objects.id;
        }

        const objects: UETKObject[] = await ctx.call('objects.find', {
          query: objectsQuery,
        });

        const cadastralIds = objects.map((obj) => obj.cadastralId);

        query.objects = { id: { $in: cadastralIds } };

        delete query.category;

        return query;
      },
    },

    defaultScopes: [...AUTH_PROTECTED_SCOPES, 'filterCategory'],
  },

  hooks: {
    before: {
      create: ['validateStatusChange'],
      update: ['validateStatusChange'],
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
    params: {
      id: 'number',
      url: 'string',
    },
  })
  saveGeneratedPdf(ctx: Context<{ id: number; url: string }>) {
    const { id, url: generatedFile } = ctx.params;

    return this.updateEntity(ctx, {
      id,
      generatedFile,
    });
  }

  @Action({
    params: {
      id: {
        type: 'number',
        convert: true,
      },
    },
    rest: 'POST /:id/generate',
    timeout: 0,
  })
  async generatePdf(ctx: Context<{ id: number }>) {
    const flow: any = await ctx.call('jobs.requests.initiatePdfGenerate', {
      id: ctx.params.id,
    });

    return {
      generating: !!flow?.job?.id,
    };
  }

  @Action({
    params: {
      id: {
        type: 'number',
        convert: true,
      },
    },
    auth: AuthType.PUBLIC,
    rest: 'GET /:id/geom',
  })
  async getRequestGeom(ctx: Context<{ id: number }>) {
    const request: Request = await ctx.call('requests.resolve', {
      id: ctx.params.id,
      populate: 'geom',
      throwIfNotExist: true,
    });

    return request?.geom || {};
  }

  @Action({
    params: {
      id: {
        type: 'number',
        convert: true,
      },
    },
    rest: 'GET /:id/pdf',
    types: [EndpointType.ADMIN],
    timeout: 0,
  })
  async getRequestPdf(ctx: Context<{ id: number }, { $responseType: string }>) {
    const { id } = ctx.params;

    const request: Request = await ctx.call('requests.resolve', {
      id,
      throwIfNotExist: true,
    });

    const secret = getRequestSecret(request);

    const footerHtml = getTemplateHtml('footer.ejs', {
      id: addLeadingZeros(id),
      date: moment(request.createdAt).format('YYYY-MM-DD'),
    });

    const pdf = await ctx.call('tools.makePdf', {
      url: `${process.env.SERVER_HOST}/jobs/requests/${id}/html?secret=${secret}`,
      footer: footerHtml,
    });

    ctx.meta.$responseType = 'application/pdf';

    return toReadableStream(pdf);
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

    const newStatuses = [RequestStatus.CREATED, RequestStatus.APPROVED];

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
  async validateStatusChange(
    ctx: Context<
      { id: number },
      UserAuthMeta & RequestAutoApprove & RequestStatusChanged
    >
  ) {
    const { id } = ctx.params;

    const { user } = ctx.meta;
    if (!!id) {
      ctx.meta.statusChanged = true;
    } else if (user?.type === UserType.ADMIN) {
      ctx.meta.autoApprove = true;
    }

    return ctx;
  }

  @Method
  async sendNotificationOnStatusChange(request: Request) {
    if (
      !emailCanBeSent() ||
      [RequestStatus.APPROVED].includes(request.status)
    ) {
      // Do not send when approved - when file will be generated email will be sent
      return;
    }

    // TODO: send email for admins using settings.
    if (
      [RequestStatus.CREATED, RequestStatus.SUBMITTED].includes(request.status)
    ) {
      return notifyOnRequestUpdate(
        NOTIFY_ADMIN_EMAIL,
        request.status,
        request.id,
        true
      );
    }

    const user: User = await this.broker.call('users.resolve', {
      id: request.createdBy,
      scope: USERS_DEFAULT_SCOPES,
    });

    const notifyEmail = request.notifyEmail || user?.email;

    if (!notifyEmail) return;

    notifyOnRequestUpdate(
      request.notifyEmail || user.email,
      request.status,
      request.id,
      user?.type === UserType.ADMIN
    );
  }

  @Method
  async generatePdfIfNeeded(request: Request) {
    if (!request || !request.id) return;

    if (request.status !== RequestStatus.APPROVED) {
      return;
    }

    if (request.generatedFile) return;

    this.broker.call('requests.generatePdf', { id: request.id });
    return request;
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

      await this.generatePdfIfNeeded(request);
      await this.sendNotificationOnStatusChange(request);
    }

    if (
      prevRequest?.generatedFile !== request.generatedFile &&
      !!request.generatedFile
    ) {
      await ctx.call(
        'requests.histories.create',
        {
          request: request.id,
          type: RequestHistoryType.FILE_GENERATED,
        },
        { meta: null }
      );

      if (emailCanBeSent()) {
        const user: User = await ctx.call('users.resolve', {
          id: request.createdBy,
          scope: USERS_DEFAULT_SCOPES,
        });

        notifyOnFileGenerated(
          user.email,
          request.id,
          user.type === UserType.ADMIN
        );
      }
    }
  }

  @Event()
  async 'requests.created'(ctx: Context<EntityChangedParams<Request>>) {
    const { data: request } = ctx.params;

    await ctx.call('requests.histories.create', {
      request: request.id,
      type: RequestHistoryType.CREATED,
    });

    if (request.status === RequestStatus.APPROVED) {
      await ctx.call('requests.histories.create', {
        request: request.id,
        comment: 'Automatiškai patvirtintas prašymas.',
        type: RequestHistoryType.APPROVED,
      });

      await this.generatePdfIfNeeded(request);
    }

    await this.sendNotificationOnStatusChange(request);
  }
}
