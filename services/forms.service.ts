'use strict';

import moleculer, { Context, RestSchema } from 'moleculer';
import { Action, Event, Method, Service } from 'moleculer-decorators';

import { UserAuthMeta } from './api.service';
import DbConnection from '../mixins/database.mixin';
import GeometriesMixin from '../mixins/geometries.mixin';

import {
  COMMON_FIELDS,
  COMMON_DEFAULT_SCOPES,
  COMMON_SCOPES,
  FieldHookCallback,
  BaseModelInterface,
  throwUnauthorizedError,
  ContextMeta,
  EntityChangedParams,
  TENANT_FIELD,
  ALL_FILE_TYPES,
} from '../types';
import { User, UserType } from './users.service';
import _ from 'lodash';
import {
  GeomFeatureCollection,
  geometryFromText,
  geometryToGeom,
} from '../modules/geometry';
import { Tenant } from './tenants.service';
import { FormHistoryTypes } from './forms.histories.service';

type FormStatusChanged = { statusChanged: boolean };

export interface Form extends BaseModelInterface {
  status: string;
  geom: GeomFeatureCollection;
}

export const FormStatus = {
  CREATED: 'CREATED',
  SUBMITTED: 'SUBMITTED',
  REJECTED: 'REJECTED',
  RETURNED: 'RETURNED',
  APPROVED: 'APPROVED',
};

const FormProviderType = {
  OWNER: 'OWNER',
  OTHER: 'OTHER',
  MANAGER: 'MANAGER',
};

const FormType = {
  NEW: 'NEW',
  EDIT: 'EDIT',
  REMOVE: 'REMOVE',
};

const FormObjectType = {
  RIVER: 'RIVER', // Upė
  CANAL: 'CANAL', // Kanalas
  NATURAL_LAKE: 'NATURAL_LAKE', // Natūralus ežeras
  PONDED_LAKE: 'PONDED_LAKE', // Patvenktas ežeras
  POND: 'POND', // Tvenkinys
  ISOLATED_WATER_BODY: 'ISOLATED_WATER_BODY', // Nepratekamas dirbtinis paviršinis vandens telkinys
  EARTH_DAM: 'EARTH_DAM', // Žemių užtvanka
  WATER_EXCESS_CULVERT: 'WATER_EXCESS_CULVERT', // Vandens pertekliaus pralaida
  HYDRO_POWER_PLANT: 'HYDRO_POWER_PLANT', // Hidroelektrinė
  FISH_PASS: 'FISH_PASS', // Žuvų perlaida
};

const nonEditableStatuses = [FormStatus.APPROVED, FormStatus.REJECTED];

const VISIBLE_TO_USER_SCOPE = 'visibleToUser';

const AUTH_PROTECTED_SCOPES = [...COMMON_DEFAULT_SCOPES, VISIBLE_TO_USER_SCOPE];

const populatePermissions = (field: string) => {
  return function (ctx: Context<{}, UserAuthMeta>, _values: any, forms: any[]) {
    const { user, profile } = ctx?.meta;
    return forms.map((form: any) => {
      const editingPermissions = this.hasPermissionToEdit(form, user, profile);
      return !!editingPermissions[field];
    });
  };
};

@Service({
  name: 'forms',

  mixins: [
    DbConnection({
      collection: 'forms',
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

      type: {
        type: 'string',
        enum: Object.values(FormType),
        default: FormType.NEW,
      },

      objectType: {
        type: 'string',
        required: true,
        enum: Object.values(FormObjectType),
      },

      objectName: 'string',

      cadastralId: 'number',

      geom: {
        type: 'any',
        raw: true,
        async populate(ctx: any, _values: any, forms: Form[]) {
          const result = await ctx.call('forms.getGeometryJson', {
            id: forms.map((f) => f.id),
          });

          return forms.map((form) => result[`${form.id}`] || {});
        },
      },

      description: 'string',

      status: {
        type: 'string',
        enum: Object.values(FormStatus),
        validate: 'validateStatus',
        onCreate: () => FormStatus.CREATED,
        onUpdate: function ({
          ctx,
          value,
        }: FieldHookCallback & ContextMeta<FormStatusChanged>) {
          const { user } = ctx?.meta;
          if (!ctx?.meta?.statusChanged) return;
          else if (!user?.id) return value;

          return value || FormStatus.SUBMITTED;
        },
      },

      files: {
        type: 'array',
        columnType: 'json',
        items: { type: 'object' },
      },

      providerType: {
        type: 'string',
        enum: Object.values(FormProviderType),
        default: 'OWNER',
      },

      providedBy: {
        type: 'string',
        onCreate({ ctx, value }: FieldHookCallback) {
          if (!ctx?.meta?.user?.id || value) return value;

          return `${ctx.meta?.user?.firstName} ${ctx.meta?.user?.lastName}`;
        },
      },

      data: {
        type: 'object',
        columnType: 'json',
      },

      respondedAt: {
        type: 'date',
        columnType: 'datetime',
        readonly: true,
        set: ({ ctx }: FieldHookCallback & ContextMeta<FormStatusChanged>) => {
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
export default class FormsService extends moleculer.Service {
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
    return ctx.call(`forms.histories.list`, {
      sort: '-createdAt',
      query: {
        form: ctx.params.id,
      },
      page: ctx.params.page,
      pageSize: ctx.params.pageSize,
      populate: 'createdBy',
    });
  }

  @Action({
    rest: <RestSchema>{
      method: 'POST',
      path: '/upload',
      type: 'multipart',
      busboyConfig: {
        limits: {
          files: 1,
        },
      },
    },
  })
  async upload(ctx: Context<{}, UserAuthMeta>) {
    const folder = this.getFolderName(ctx.meta?.user, ctx.meta?.profile);
    return ctx.call('minio.uploadFile', {
      payload: ctx.params,
      isPrivate: true,
      types: ALL_FILE_TYPES,
      folder,
    });
  }

  @Method
  validateStatus({ ctx, value, entity }: FieldHookCallback) {
    const { user, profile } = ctx.meta;
    if (!value || !user?.id) return true;

    const adminStatuses = [
      FormStatus.REJECTED,
      FormStatus.RETURNED,
      FormStatus.APPROVED,
    ];

    const newStatuses = [FormStatus.CREATED];

    const error = `Cannot set status with value ${value}`;
    if (!entity?.id) {
      return newStatuses.includes(value) || error;
    }

    const editingPermissions = this.hasPermissionToEdit(entity, user, profile);

    if (editingPermissions.edit) {
      return value === FormStatus.SUBMITTED || error;
    } else if (editingPermissions.validate) {
      return adminStatuses.includes(value) || error;
    }

    return error;
  }

  @Method
  hasPermissionToEdit(
    form: any,
    user?: User,
    profile?: Tenant
  ): {
    edit: boolean;
    validate: boolean;
  } {
    const invalid = { edit: false, validate: false };

    const tenant = form.tenant || form.tenantId;

    if (
      !form?.id ||
      [FormStatus.APPROVED, FormStatus.REJECTED].includes(form?.status)
    ) {
      return invalid;
    }

    if (!user?.id) {
      return {
        edit: true,
        validate: true,
      };
    }

    const isCreatedByUser = !tenant && user && user.id === form.createdBy;
    const isCreatedByTenant = profile && profile.id === tenant;

    if (isCreatedByTenant || isCreatedByUser) {
      return {
        validate: false,
        edit: [FormStatus.RETURNED].includes(form.status),
      };
    } else if (user.type === UserType.ADMIN) {
      return {
        edit: false,
        validate: [FormStatus.CREATED, FormStatus.SUBMITTED].includes(
          form.status
        ),
      };
    }

    return invalid;
  }

  @Method
  async parseGeomField(
    ctx: Context<{
      id?: number;
      geom?: GeomFeatureCollection;
      geomBufferSize?: number;
    }>
  ) {
    const { geom, id } = ctx.params;

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
    } else if (id) {
      const form: Form = await ctx.call('forms.resolve', { id });
      if (!form.geom) {
        throw new moleculer.Errors.ValidationError('No geometry');
      }
    } else {
      throw new moleculer.Errors.ValidationError('Invalid geometry');
    }

    return ctx;
  }

  @Method
  async validateStatusChange(
    ctx: Context<{ id: number }, UserAuthMeta & FormStatusChanged>
  ) {
    const { id } = ctx.params;

    if (!!id) {
      ctx.meta.statusChanged = true;
    }

    return ctx;
  }

  @Method
  createFormHistory(
    ctx: Context,
    id: number,
    type: string,
    comment: string = ''
  ) {
    return ctx.call('forms.histories.create', {
      form: id,
      comment,
      type,
    });
  }

  @Method
  getFolderName(user?: User, tenant?: Tenant) {
    const tenantPath = tenant?.id || 'private';
    const userPath = user?.id || 'user';

    return `uploads/forms/${tenantPath}/${userPath}`;
  }


  @Event()
  async 'forms.updated'(ctx: Context<EntityChangedParams<Form>>) {
    const { oldData: prevForm, data: form } = ctx.params;

    if (prevForm?.status !== form.status) {
      const { comment } = ctx.options?.parentCtx?.params as any;
      const typesByStatus = {
        [FormStatus.SUBMITTED]: FormHistoryTypes.UPDATED,
        [FormStatus.REJECTED]: FormHistoryTypes.REJECTED,
        [FormStatus.RETURNED]: FormHistoryTypes.RETURNED,
        [FormStatus.APPROVED]: FormHistoryTypes.APPROVED,
      };

      await ctx.call('forms.histories.create', {
        form: form.id,
        comment,
        type: typesByStatus[form.status],
      });
    }
  }

  @Event()
  async 'forms.created'(ctx: Context<EntityChangedParams<Form>>) {
    const { data: form } = ctx.params;

    await ctx.call('forms.histories.create', {
      form: form.id,
      type: FormHistoryTypes.CREATED,
    });
  }
}
