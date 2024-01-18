'use strict';

import moleculer, { Context, RestSchema } from 'moleculer';
import { Action, Event, Method, Service } from 'moleculer-decorators';

import { FeatureCollection } from 'geojsonjs';
import { isEmpty } from 'lodash';
import PostgisMixin from 'moleculer-postgis';
import DbConnection from '../mixins/database.mixin';
import {
  ALL_FILE_TYPES,
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
  throwBadRequestError,
  USER_PUBLIC_GET,
  USER_PUBLIC_POPULATE,
} from '../types';
import { getObjectByCadastralId } from '../utils';
import {
  emailCanBeSent,
  notifyFormAssignee,
  notifyOnFormUpdate,
} from '../utils/mails';
import { UserAuthMeta } from './api.service';
import { FormHistoryTypes } from './forms.histories.service';
import { UETKObjectType } from './objects.service';
import { Tenant } from './tenants.service';
import { User, USERS_DEFAULT_SCOPES, UserType } from './users.service';

type FormStatusChanged = { statusChanged: boolean };

export interface Form extends BaseModelInterface {
  status: string;
  geom: FeatureCollection;
  objectName: string;
  cadastralId: string | number;
  type: string;
  objectType: string;
  assignee: number;
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

export const FormType = {
  NEW: 'NEW',
  EDIT: 'EDIT',
  REMOVE: 'REMOVE',
};

const nonEditableStatuses = [FormStatus.APPROVED, FormStatus.REJECTED];

const VISIBLE_TO_USER_SCOPE = 'visibleToUser';

const AUTH_PROTECTED_SCOPES = [...COMMON_DEFAULT_SCOPES, VISIBLE_TO_USER_SCOPE];

const populatePermissions = (field: string) => {
  return function (ctx: Context<{}, UserAuthMeta>, _values: any, forms: any[]) {
    const { user, profile, authUser } = ctx?.meta;
    return forms.map((form: any) => {
      const editingPermissions = this.hasPermissionToEdit(
        form,
        user,
        authUser,
        profile
      );
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

      type: {
        type: 'string',
        enum: Object.values(FormType),
        default: FormType.NEW,
      },

      objectType: {
        type: 'string',
        required: true,
        enum: Object.values(UETKObjectType),
      },

      objectName: 'string',

      cadastralId: 'number',

      geom: {
        type: 'any',
        geom: {
          type: 'geom',
          validate({ value, params }: any) {
            if (params?.id) return true;

            if ((!params?.type || params?.type === FormType.NEW) && !value) {
              return 'Geometry must be provided';
            }

            return true;
          },
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

      assignee: {
        type: 'number',
        columnType: 'integer',
        populate: USER_PUBLIC_POPULATE,
        get: USER_PUBLIC_GET,
        set: async ({
          ctx,
          value,
          entity,
        }: FieldHookCallback & ContextMeta<FormStatusChanged>) => {
          const { user, authUser } = ctx?.meta;

          if (!entity?.id || !user?.id || !value) return null;

          const availableAssigneeList: { rows: User[] } = await ctx.call(
            'forms.getAssignees'
          );

          if (
            user.type === UserType.USER ||
            !availableAssigneeList.rows.find(
              (assignee) => assignee.id === Number(value)
            )
          ) {
            throwBadRequestError('Assignee cannot be set.');
          }

          const createdBy: User = await ctx.call('users.resolve', {
            id: entity.createdBy,
          });

          let prevAssignee = null;
          if (!!entity.assigneeId) {
            prevAssignee = (await ctx.call('users.resolve', {
              id: entity.assigneeId,
            })) as User;
          }

          const newAssignee = Number(value);
          const prevAssigneeId = Number(prevAssignee?.authUser);
          const userIsCreator = Number(createdBy.authUser) === newAssignee;

          if (
            authUser.type === UserType.ADMIN &&
            !authUser.adminOfGroups.length
          ) {
            const assignedToHimself =
              Number(authUser.id) === Number(prevAssigneeId);

            if (!!newAssignee && !!prevAssigneeId) {
              throwBadRequestError('Assignee already exists.');
            } else if (!newAssignee && !assignedToHimself) {
              throwBadRequestError('Cannot unassign others.');
            }
          }

          if (!newAssignee && !prevAssigneeId) {
            throwBadRequestError('Already unassigned.');
          } else if (!!newAssignee && userIsCreator) {
            throwBadRequestError('Cannot assign to creator.');
          }
          const assigneeAuthUser: any = await ctx.call('auth.users.get', {
            id: value,
          });

          const localUser: User = await ctx.call('users.findOrCreate', {
            authUser: assigneeAuthUser,
            update: true,
            hideAdmins: false,
          });

          if (emailCanBeSent() && localUser.email) {
            notifyFormAssignee(localUser.email, entity.id);
          }

          return localUser.id;
        },
        columnName: 'assigneeId',
      },

      object: {
        type: 'object',
        virtual: true,
        populate: function (
          ctx: Context<{}, UserAuthMeta>,
          _values: any,
          forms: Form[]
        ) {
          return Promise.all(
            forms.map(async (form) =>
              this.getObjectFromCadastralId(form.cadastralId, form.objectName)
            )
          );
        },
      },

      canEdit: {
        type: 'boolean',
        virtual: true,
        populate: populatePermissions('edit'),
      },

      canAssign: {
        type: 'boolean',
        virtual: true,
        populate: populatePermissions('assign'),
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
    rest: 'GET /assignees',
    auth: EndpointType.ADMIN,
  })
  async getAssignees(ctx: Context<{}, UserAuthMeta>) {
    const { authUser, user } = ctx.meta;

    if (authUser?.type === UserType.ADMIN && isEmpty(authUser?.adminOfGroups))
      return {
        rows: [
          {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            phone: user.phone,
            email: user.email,
          },
        ],
        total: 1,
        page: 1,
      };

    return await ctx.call('auth.users.list', {
      ...ctx.params,
      query: {
        type: UserType.ADMIN,
        group: {
          $in: authUser?.adminOfGroups,
        },
      },
      fields: ['id', 'firstName', 'lastName', 'phone', 'email'],
      pageSize: 99999,
    });
  }

  @Action({
    rest: 'PATCH /:id/assignee/:assignee?',
    params: {
      id: {
        type: 'number',
        convert: true,
      },
      assignee: {
        optional: true,
        type: 'number',
        convert: true,
      },
    },
    types: [EndpointType.ADMIN],
  })
  async setAssignee(
    ctx: Context<{ id: number; assignee: number }, UserAuthMeta>
  ) {
    await this.updateEntity(ctx, {
      id: ctx.params.id,
      assignee: ctx.params.assignee || null,
    });

    return { success: true };
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
    const { user, profile, authUser } = ctx.meta;
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

    const editingPermissions = this.hasPermissionToEdit(
      entity,
      user,
      authUser,
      profile
    );

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
    authUser?: any,
    profile?: Tenant
  ): {
    edit: boolean;
    validate: boolean;
    assign: boolean;
  } {
    const invalid = { edit: false, validate: false, assign: false };

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
        assign: true,
      };
    }

    const isCreatedByUser = !tenant && user && user.id === form.createdBy;
    const isCreatedByTenant = profile && profile.id === tenant;

    const canEdit =
      [FormStatus.RETURNED].includes(form.status) &&
      (isCreatedByTenant || isCreatedByUser);

    const isSuperAdminOrAssignee =
      authUser.type === UserType.SUPER_ADMIN || form.assigneeId === user.id;

    const canValidate =
      isSuperAdminOrAssignee &&
      [FormStatus.CREATED, FormStatus.SUBMITTED].includes(form.status);

    const canAssign =
      !isCreatedByUser &&
      authUser.type !== UserType.USER &&
      (!isEmpty(authUser.adminOfGroups) ||
        !form?.assigneeId ||
        isSuperAdminOrAssignee);

    return {
      edit: canEdit,
      validate: canValidate,
      assign: canAssign,
    };
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

  @Method
  async getObjectFromCadastralId(id?: number | string, name?: string) {
    const objects = await getObjectByCadastralId(id, { name });
    if (!objects?.length) return;

    return objects[0];
  }

  @Method
  async sendNotificationOnStatusChange(form: Form) {
    const object = await this.getObjectFromCadastralId(
      form.cadastralId,
      form.objectName
    );

    if (
      !emailCanBeSent() ||
      !object?.name ||
      [FormStatus.SUBMITTED].includes(form.status)
    )
      return;

    // TODO: send email for admins / assignees.
    if ([FormStatus.CREATED].includes(form.status)) {
      return notifyOnFormUpdate(
        NOTIFY_ADMIN_EMAIL,
        form.status,
        form.id,
        form.type,
        object.name,
        object.id,
        true
      );
    }

    if ([FormStatus.SUBMITTED].includes(form.status)) {
      const assignee: User = await this.broker.call('users.resolve', {
        id: form.assignee,
        scope: USERS_DEFAULT_SCOPES,
      });

      if (!assignee?.email) return;

      return notifyOnFormUpdate(
        assignee.email,
        form.status,
        form.id,
        form.type,
        object.name,
        object.id,
        true
      );
    }

    if (
      [FormStatus.RETURNED, FormStatus.REJECTED, FormStatus.APPROVED].includes(
        form.status
      )
    ) {
      const user: User = await this.broker.call('users.resolve', {
        id: form.createdBy,
        scope: USERS_DEFAULT_SCOPES,
      });

      if (!user?.email) return;

      return notifyOnFormUpdate(
        user.email,
        form.status,
        form.id,
        form.type,
        object.name,
        object.id,
        user.type === UserType.ADMIN
      );
    }
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

      await this.sendNotificationOnStatusChange(form);
    }
  }

  @Event()
  async 'forms.created'(ctx: Context<EntityChangedParams<Form>>) {
    const { data: form } = ctx.params;

    await ctx.call('forms.histories.create', {
      form: form.id,
      type: FormHistoryTypes.CREATED,
    });

    await this.sendNotificationOnStatusChange(form);
  }
}
