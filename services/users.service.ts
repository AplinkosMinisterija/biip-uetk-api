'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Event, Service } from 'moleculer-decorators';

import DbConnection from '../mixins/database.mixin';
import {
  BaseModelInterface,
  COMMON_DEFAULT_SCOPES,
  COMMON_FIELDS,
  COMMON_SCOPES,
  EndpointType,
  FieldHookCallback,
  throwNotFoundError,
  throwUnauthorizedError,
} from '../types';
import { UserAuthMeta } from './api.service';
import { Tenant } from './tenants.service';
import { TenantUserRole } from './tenantUsers.service';

export enum UserType {
  ADMIN = 'ADMIN',
  USER = 'USER',
  SUPER_ADMIN = 'SUPER_ADMIN',
}
export interface User extends BaseModelInterface {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  type: UserType;
  authUser: number;
}

const VISIBLE_TO_USER_SCOPE = 'tenant';
const NOT_ADMINS_SCOPE = 'notAdmins';

const AUTH_PROTECTED_SCOPES = [
  ...COMMON_DEFAULT_SCOPES,
  VISIBLE_TO_USER_SCOPE,
  NOT_ADMINS_SCOPE,
];

export const USERS_WITHOUT_AUTH_SCOPES = [`-${VISIBLE_TO_USER_SCOPE}`];
export const USERS_WITHOUT_NOT_ADMINS_SCOPE = [`-${NOT_ADMINS_SCOPE}`];
export const USERS_DEFAULT_SCOPES = [
  ...USERS_WITHOUT_AUTH_SCOPES,
  ...USERS_WITHOUT_NOT_ADMINS_SCOPE,
];

@Service({
  name: 'users',

  mixins: [
    DbConnection({
      collection: 'users',
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

      firstName: 'string',

      lastName: 'string',

      email: 'string',

      phone: 'string',

      type: {
        type: 'string',
        enum: Object.values(UserType),
        default: UserType.USER,
      },

      authUser: {
        type: 'number',
        columnType: 'integer',
        columnName: 'authUserId',
        populate: 'auth.users.get',
        async onRemove({ ctx, entity }: FieldHookCallback) {
          await ctx.call(
            'auth.users.remove',
            { id: entity.authUserId },
            { meta: ctx?.meta }
          );
        },
      },

      profiles: {
        virtual: true,
        type: 'array',
        items: 'object',
        populate(_ctx: Context, _values: any, users: any[]) {
          return Promise.all(
            users.map(async (user: any) => {
              return this.broker.call(
                'tenantUsers.getProfiles',
                {},
                {
                  meta: {
                    user,
                  },
                }
              );
            })
          );
        },
      },

      role: {
        virtual: true,
        type: 'string',
        populate(ctx: any, _values: any, users: any[]) {
          return Promise.all(
            users.map(async (user: any) => {
              if (!ctx.meta.profile?.id) return;
              return ctx.call('tenantUsers.getRole', {
                tenant: ctx.meta.profile.id,
                user: user.id,
              });
            })
          );
        },
      },

      ...COMMON_FIELDS,
    },

    scopes: {
      ...COMMON_SCOPES,
      notAdmins(query: any) {
        query.type = UserType.USER;
        return query;
      },
      async tenant(query: any, ctx: Context<null, UserAuthMeta>, params: any) {
        let tenantId: number;

        if (ctx?.meta?.profile?.id) {
          tenantId = ctx.meta.profile.id;
        } else if (ctx?.meta?.user?.type === UserType.ADMIN) {
          tenantId = query.tenant;
          delete query.tenant;
        } else if (!!ctx?.meta?.user?.id) {
          query.id = ctx.meta.user.id;
        }

        if (tenantId) {
          const userIds: number[] = await ctx.call(
            'tenantUsers.findIdsByTenant',
            {
              id: tenantId,
              role: query.role,
            }
          );
          delete query.role;

          if (params?.id) {
            let hasPermissions = false;
            if (Array.isArray(params.id)) {
              hasPermissions = params.id.every((id: number) =>
                userIds.includes(Number(id))
              );
            } else {
              hasPermissions = userIds.includes(Number(params.id));
            }

            if (!hasPermissions) {
              throwUnauthorizedError(
                `Cannot access user with ID: ${params.id}`
              );
            }
          } else {
            query.id = { $in: userIds };
          }
        }
        return query;
      },
    },

    defaultScopes: AUTH_PROTECTED_SCOPES,
  },

  actions: {
    create: {
      rest: null,
    },

    get: {
      types: [EndpointType.ADMIN, EndpointType.TENANT_ADMIN],
    },

    list: {
      types: [EndpointType.ADMIN, EndpointType.TENANT_USER],
    },

    remove: {
      rest: null,
    },

    update: {
      rest: null,
    },
  },
})
export default class UsersService extends moleculer.Service {
  @Action({
    rest: 'POST /',
    params: {
      personalCode: 'any',
      firstName: 'string',
      lastName: 'string',
      email: 'string',
      phone: 'string',
      tenantId: {
        type: 'number',
        optional: true,
      },
      role: {
        type: 'string',
        optional: true,
        default: TenantUserRole.USER,
      },
    },
    types: [EndpointType.ADMIN, EndpointType.TENANT_ADMIN],
  })
  async invite(
    ctx: Context<
      {
        personalCode: string;
        role?: TenantUserRole;
        email: string;
        tenantId?: number;
      },
      UserAuthMeta
    >
  ) {
    const { personalCode, email, role, tenantId } = ctx.params;
    const { profile, user: authenticatedUser } = ctx.meta;
    const data: any = {
      personalCode,
      notify: [email],
    };

    let authGroupId;
    if (profile?.id) {
      data.companyId = profile.authGroup;
      data.role = role;
      authGroupId = profile.authGroup;
    }

    let tenant: Tenant;
    if (tenantId) {
      tenant = await ctx.call('tenants.resolve', {
        id: tenantId,
      });

      if (authenticatedUser?.type !== UserType.ADMIN || !tenant?.id) {
        throw new moleculer.Errors.MoleculerClientError(
          'Cannot assign user to tenant.',
          401,
          'UNAUTHORIZED'
        );
      }

      data.companyId = tenant.authGroup;
      data.role = role;
      authGroupId = tenant.authGroup;
    }

    const authUser: any = await ctx.call('auth.users.invite', data);

    const user: User = await ctx.call('users.findOrCreate', {
      authUser: authUser,
      ...ctx.params,
    });

    if (authGroupId) {
      const authGroup: any = await ctx.call('auth.groups.get', {
        id: authGroupId,
      });
      if (authGroup && authGroup.id) {
        await ctx.call('tenantUsers.createRelationshipsIfNeeded', {
          authGroup: { ...authGroup, role },
          userId: user.id,
        });
      }
    }

    return user;
  }

  @Action({
    params: {
      authUser: 'any',
    },
    cache: {
      keys: ['authUser.id'],
    },
  })
  async resolveByAuthUser(ctx: Context<{ authUser: any }>) {
    const user: User = await ctx.call('users.findOrCreate', {
      authUser: ctx.params.authUser,
    });

    return user;
  }

  @Action({
    params: {
      authUser: 'any',
      update: {
        type: 'boolean',
        default: false,
      },

      firstName: {
        type: 'string',
        optional: true,
      },
      lastName: {
        type: 'string',
        optional: true,
      },
      email: {
        type: 'string',
        optional: true,
      },
      phone: {
        type: 'string',
        optional: true,
      },
    },
  })
  async findOrCreate(
    ctx: Context<{
      authUser: any;
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      update?: boolean;
    }>
  ) {
    const { authUser, update, firstName, lastName, email, phone } = ctx.params;
    if (!authUser || !authUser.id) return;

    const scope = [...USERS_WITHOUT_AUTH_SCOPES];

    const authUserIsAdmin = [UserType.SUPER_ADMIN, UserType.ADMIN].includes(
      authUser.type
    );

    if (authUserIsAdmin) {
      scope.push(...USERS_WITHOUT_NOT_ADMINS_SCOPE);
    }

    const user: User = await ctx.call('users.findOne', {
      query: {
        authUser: authUser.id,
      },
      scope,
    });

    if (!update && user && user.id) return user;

    const dataToSave = {
      firstName: firstName || authUser.firstName,
      lastName: lastName || authUser.lastName,
      type: authUserIsAdmin ? UserType.ADMIN : UserType.USER,
      email: email || authUser.email,
      phone: phone || authUser.phone,
    };

    if (user?.id) {
      return this.updateEntity(
        ctx,
        {
          id: user.id,
          ...dataToSave,
        },
        { scope }
      );
    }

    // let user to customize his phone and email
    if (user?.email) {
      delete dataToSave.email;
    }
    if (user?.phone) {
      delete dataToSave.phone;
    }

    return ctx.call('users.create', {
      authUser: authUser.id,
      ...dataToSave,
    });
  }

  @Action({
    rest: 'DELETE /:id',
    params: {
      id: {
        type: 'number',
        convert: true,
      },
    },
    types: [EndpointType.ADMIN, EndpointType.TENANT_ADMIN],
  })
  async removeUser(ctx: Context<{ id: number }, UserAuthMeta>) {
    const { id } = ctx.params;
    const { profile } = ctx.meta;
    const user = await ctx.call('users.get', { id });

    if (!user) {
      return throwNotFoundError('User not found.');
    }

    if (profile?.id) {
      return ctx.call('tenantUsers.removeUser', {
        userId: id,
        tenantId: profile.id,
      });
    } else if (ctx.meta.user.type === UserType.ADMIN) {
      await ctx.call('tenantUsers.removeTenants', {
        userId: id,
      });
    }

    return ctx.call('users.remove', { id });
  }

  @Action({
    rest: 'PATCH /:id',
    params: {
      id: 'any',
      role: {
        type: 'string',
        optional: true,
      },
      email: {
        type: 'string',
        optional: true,
      },
      phone: {
        type: 'string',
        optional: true,
      },
      tenantId: {
        type: 'number',
        optional: true,
      },
    },
  })
  async updateUser(
    ctx: Context<
      {
        id: number;
        role: string;
        email: string;
        phone: string;
        tenantId: number;
      },
      UserAuthMeta
    >
  ) {
    const { profile, user } = ctx.meta;
    const { id, email, phone, role, tenantId } = ctx.params;

    const userToUpdate: User = await ctx.call('users.get', { id });

    if (!userToUpdate) {
      return throwNotFoundError('User not found.');
    }

    if (role) {
      await ctx.call('tenantUsers.updateUser', {
        userId: id,
        tenantId: profile?.id || tenantId,
        role,
      });
    }

    return ctx.call('users.update', {
      id,
      email,
      phone,
    });
  }

  @Event()
  async 'users.**'() {
    this.broker.emit('clean.cache.auth');
    await this.broker.cacher?.clean(`${this.fullName}.**`);
  }
}
