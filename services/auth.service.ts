'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Event, Method, Service } from 'moleculer-decorators';

import authMixin from 'biip-auth-nodejs/mixin';
import {
  AUTH_FREELANCERS_GROUP_ID,
  EndpointType,
  throwNotFoundError,
} from '../types';
import { UserAuthMeta } from './api.service';
import { TenantUserRole } from './tenantUsers.service';
import { User, UserType } from './users.service';

@Service({
  name: 'auth',
  mixins: [
    authMixin(process.env.AUTH_API_KEY, {
      host: process.env.AUTH_HOST || '',
      appHost: process.env.APP_HOST || 'https://uetk.biip.lt',
    }),
  ],
  actions: {
    'users.resolveToken': {
      cache: {
        keys: ['#authToken'],
      },
    },
    'apps.resolveToken': {
      cache: {
        keys: [],
      },
    },
  },
  hooks: {
    after: {
      login: 'afterUserLoggedIn',
      'evartai.login': 'afterUserLoggedIn',
      me: 'addProfiles',
    },
    before: {
      'evartai.login': 'beforeUserLogin',
    },
  },
})
export default class AuthService extends moleculer.Service {
  @Action({
    cache: {
      keys: ['#user.id', '#profile.id'],
    },
  })
  async me(ctx: Context<{}, UserAuthMeta>) {
    const { user, authUser } = ctx.meta;
    const data: any = {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      type: user.type,
    };

    if (authUser?.permissions?.UETK) {
      data.permissions = {
        UETK: authUser.permissions.UETK,
      };
    }

    return data;
  }

  @Action({
    params: {
      authUser: 'any',
      authUserGroups: 'array',
    },
  })
  async createUserWithTenantsIfNeeded(
    ctx: Context<{ authUser: any; authUserGroups: any[] }>
  ) {
    const { authUser, authUserGroups } = ctx.params;
    const user: User = await ctx.call('users.findOrCreate', {
      authUser: authUser,
      update: true,
    });

    if (authUserGroups && authUserGroups.length && user?.id) {
      const authGroups = authUserGroups.filter(
        (g) => g.id != AUTH_FREELANCERS_GROUP_ID
      );

      for (const group of authGroups) {
        await ctx.call('tenantUsers.createRelationshipsIfNeeded', {
          authGroup: group,
          userId: user.id,
        });
      }
    }

    return user;
  }

  @Action({
    cache: {
      keys: ['types', '#user.id', '#profile.id'],
    },
    params: {
      types: {
        type: 'array',
        items: 'string',
        enum: Object.values(EndpointType),
      },
    },
  })
  async validateType(ctx: Context<{ types: EndpointType[] }, UserAuthMeta>) {
    const { types } = ctx.params;
    const { user } = ctx.meta;
    const userType = user.type;
    const tenantRole = ctx.meta.profile?.role;
    if (!types || !types.length) return true;

    let result = false;
    if (types.includes(EndpointType.ADMIN)) {
      result = result || userType === UserType.ADMIN;
    }

    if (types.includes(EndpointType.USER)) {
      result = result || userType === UserType.USER;
    }

    if (tenantRole && types.includes(EndpointType.TENANT_ADMIN)) {
      result = result || tenantRole === TenantUserRole.ADMIN;
    }

    if (types.includes(EndpointType.TENANT_USER)) {
      result = result || !!ctx.meta.profile?.id;
    }

    return result;
  }

  @Method
  async afterUserLoggedIn(ctx: any, data: any) {
    if (!data || !data.token) return data;

    const meta = { authToken: data.token };

    const authUser: any = await this.broker.call(
      'auth.users.resolveToken',
      null,
      { meta }
    );
    const authUserGroups: any = await this.broker.call(
      'auth.users.get',
      {
        id: authUser?.id,
        populate: 'groups',
      },
      { meta }
    );
    const authGroups: any[] = authUserGroups?.groups || [];

    const user: User = await this.broker.call(
      'auth.createUserWithTenantsIfNeeded',
      {
        authUser: authUser,
        authUserGroups: authGroups,
      },
      { meta }
    );

    if (user.type === UserType.ADMIN && process.env.NODE_ENV !== 'local') {
      return throwNotFoundError();
    }

    return data;
  }

  @Method
  async beforeUserLogin(ctx: any) {
    ctx.params = ctx.params || {};
    ctx.params.defaultGroupId = AUTH_FREELANCERS_GROUP_ID;
    ctx.params.refresh = true;

    return ctx;
  }

  @Method
  async addProfiles(ctx: any, data: any) {
    if (data?.id && data?.type === UserType.USER) {
      data.profiles = await ctx.call('tenantUsers.getProfiles');
      data.profiles = data.profiles.map((i: any) => ({
        id: i.id,
        name: i.name,
        freelancer: i.freelancer,
        email: i.email,
        phone: i.phone,
        role: i.role,
      }));
    }

    return data;
  }

  @Event()
  async 'clean.cache.auth'() {
    await this.broker.cacher?.clean(`${this.fullName}.**`);
  }
}
