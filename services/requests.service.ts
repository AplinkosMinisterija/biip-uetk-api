'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Event, Method, Service } from 'moleculer-decorators';

import { FeatureCollection } from 'geojsonjs';
import PostgisMixin, { GeometryType } from 'moleculer-postgis';
import DbConnection from '../mixins/database.mixin';
import { UserAuthMeta } from './api.service';

import moment from 'moment';
import { Readable } from 'stream';
import {
  BaseModelInterface,
  COMMON_DEFAULT_SCOPES,
  COMMON_FIELDS,
  COMMON_SCOPES,
  ContextMeta,
  EndpointType,
  EntityChangedParams,
  FieldHookCallback,
  GEOJSON_TYPES,
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
    format?: string;
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

export const RequestFormat = {
  PDF: 'PDF',
  GEOJSON: 'GEOJSON',
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

      generatedFile: {
        type: 'string',
        // Sign on read so FE can keep using <a href={url}> downloads without
        // sending an Authorization header. The stored value is a relative
        // private-proxy URL; minio.signStoredUrl issues a fresh presigned URL
        // that hits MinIO directly with the embedded signature.
        async get({ ctx, value }: FieldHookCallback) {
          if (!value || typeof value !== 'string') return value;
          return ctx.call('minio.signStoredUrl', { url: value });
        },
      },

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
          format: {
            type: 'string',
            required: false,
            enum: Object.values(RequestFormat),
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
        // Deny-by-default for unauthenticated callers: scope used to return the
        // raw query, which made any internal ctx.call('requests.resolve') from
        // a PUBLIC action expose every request. The route-level auth still
        // gates HTTP, but defense-in-depth matters when actions invoke each
        // other via ctx.call.
        if (!user?.id) return { ...query, id: -1 };

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
      filterRequestData(query: any) {
        // The web filter sends data: { format: 'GEOJSON' } (or { extended: bool }),
        // but jsonb '=' would only match rows whose data column has exactly that
        // shape. Rewrite to a JSONB containment so partial-key filters work for
        // rows that carry the new format key alongside extended.
        if (!query.data) return query;
        let value = query.data;
        if (typeof value === 'string') {
          try { value = JSON.parse(value); } catch (_) { return query; }
        }
        delete query.data;
        return {
          ...query,
          $raw: {
            condition: `data @> ?::jsonb`,
            bindings: [JSON.stringify(value)],
          },
        };
      },
    },

    defaultScopes: [
      ...AUTH_PROTECTED_SCOPES,
      'filterCategory',
      'filterRequestData',
    ],
  },

  hooks: {
    before: {
      create: ['validateStatusChange'],
      update: ['validateStatusChange'],
    },
  },

  actions: {
    // Authorization: any authenticated user can hit the CRUD routes, but the
    // visibleToUser scope ensures USERs only see their own and TENANT_USERs
    // only see their tenant's. Admins see everything. Public callers blocked
    // at the auth layer.
    create: {
      types: [
        EndpointType.ADMIN,
        EndpointType.USER,
        EndpointType.TENANT_USER,
        EndpointType.TENANT_ADMIN,
      ],
    },
    list: {
      types: [
        EndpointType.ADMIN,
        EndpointType.USER,
        EndpointType.TENANT_USER,
        EndpointType.TENANT_ADMIN,
      ],
    },
    get: {
      types: [
        EndpointType.ADMIN,
        EndpointType.USER,
        EndpointType.TENANT_USER,
        EndpointType.TENANT_ADMIN,
      ],
    },
    update: {
      types: [
        EndpointType.ADMIN,
        EndpointType.USER,
        EndpointType.TENANT_USER,
        EndpointType.TENANT_ADMIN,
      ],
      additionalParams: {
        comment: { type: 'string', optional: true },
      },
    },
    remove: {
      types: [EndpointType.ADMIN],
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
    types: [
      EndpointType.ADMIN,
      EndpointType.USER,
      EndpointType.TENANT_USER,
      EndpointType.TENANT_ADMIN,
    ],
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
    types: [
      EndpointType.ADMIN,
      EndpointType.USER,
      EndpointType.TENANT_USER,
      EndpointType.TENANT_ADMIN,
    ],
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
      id: { type: 'number', convert: true },
    },
    timeout: 0,
  })
  async generateGeoJson(ctx: Context<{ id: number }>) {
    const { id } = ctx.params;

    const request: Request = await ctx.call('requests.resolve', {
      id,
      populate: 'createdBy,tenant,geom',
    });

    if (!request?.id) return { generating: false };

    const cadastralIds = request.objects
      ?.filter((i) => i.type === 'CADASTRAL_ID')
      ?.map((i) => i.id)
      ?.filter((i) => !!i);

    const query: any = {};
    if (cadastralIds?.length) query.cadastralId = { $in: cadastralIds };
    if (request.geom && Object.keys(request.geom).length) query.geom = request.geom;

    if (!query.cadastralId && !query.geom) return { generating: false };

    const objects: UETKObject[] = await ctx.call('objects.find', {
      query,
      populate: 'geom',
    });

    const features = objects.flatMap((obj: any) => {
      const baseProps = {
        cadastralId: obj.cadastralId,
        name: obj.name,
        category: obj.category,
        categoryTranslate: obj.categoryTranslate,
        municipality: obj.municipality,
        municipalityCode: obj.municipalityCode,
        area: obj.area,
        length: obj.length,
      };
      if (
        obj.geom?.type === 'FeatureCollection' &&
        Array.isArray(obj.geom.features)
      ) {
        return obj.geom.features
          .filter((f: any) => f?.geometry?.type)
          .map((f: any) => ({
            type: 'Feature',
            geometry: f.geometry,
            properties: { ...baseProps, ...(f.properties || {}) },
          }));
      }
      const geometry =
        obj.geom?.geometry || (obj.geom?.type ? obj.geom : null);
      if (!geometry?.type) return [];
      return [{ type: 'Feature', geometry, properties: baseProps }];
    });

    const featureCollection = {
      type: 'FeatureCollection',
      features,
    };

    const folder = `uploads/requests/${
      (request.tenant as Tenant)?.id || 'private'
    }/${(request.createdBy as any as User)?.id || 'user'}`;

    const buffer = Buffer.from(JSON.stringify(featureCollection));
    const stream = Readable.from(buffer);

    const result: any = await ctx.call(
      'minio.uploadFile',
      {
        payload: stream,
        folder,
        isPrivate: true,
        types: GEOJSON_TYPES,
        name: `israsas-${request.id}`,
      },
      {
        meta: {
          mimetype: 'application/geo+json',
          filename: `israsas-${request.id}.geojson`,
        },
      }
    );

    await ctx.call('requests.saveGeneratedPdf', { id, url: result.url });

    return { generating: true };
  }

  @Action({
    params: {
      id: {
        type: 'number',
        convert: true,
      },
    },
    rest: 'GET /:id/geom',
    types: [
      EndpointType.ADMIN,
      EndpointType.USER,
      EndpointType.TENANT_USER,
      EndpointType.TENANT_ADMIN,
    ],
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

    if (request.data?.format === RequestFormat.GEOJSON) {
      this.broker.call('requests.generateGeoJson', { id: request.id });
    } else {
      this.broker.call('requests.generatePdf', { id: request.id });
    }
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
