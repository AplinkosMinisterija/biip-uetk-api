'use strict';

import moleculer, { Context, ServiceBroker } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import { faker } from '@faker-js/faker';
const fs = require('fs');

@Service({
  name: 'seed',
})
export default class SeedService extends moleculer.Service {
  @Action()
  async real(ctx: Context<Record<string, unknown>>) {
    const usersCount: number = await ctx.call('users.count');

    if (!usersCount) {
      const data: any[] = await ctx.call('auth.getSeedData');

      for (const item of data) {
        await ctx.call('auth.createUserWithTenantsIfNeeded', {
          authUser: item,
          authUserGroups: item.groups,
        });
      }
    }

    return true;
  }

  @Action()
  async fake(ctx: Context<Record<string, unknown>>) {
    return true;
  }

  async started(): Promise<void> {
    this.broker
      .waitForServices(['auth', 'users', 'tenants', 'tenants.users'])
      .then(async () => {
        await this.broker.call('seed.real', {}, { timeout: 120 * 1000 });

        if (process.env.NODE_ENV !== 'production') {
          await this.broker.call('seed.fake', {}, { timeout: 120 * 1000 });
        }
      });
  }
}
