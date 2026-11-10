import { ServiceBroker } from 'moleculer';

// Real `users.invite` and `users.findOrCreate`; auth and DB actions stubbed.
// User 9 already exists (another tenant) with auth user 109.
const calls: { action: string; params: any }[] = [];
const existing = {
  id: 9,
  authUser: 109,
  email: 'owner@x.lt',
  phone: '+37060000000',
};

const stubs: Record<string, (ctx: any) => any> = {
  'auth.users.invite': () => ({ id: 109, firstName: 'Jonas', lastName: 'J' }),
  'auth.groups.get': (ctx) => ({ id: ctx.params.id }),
  'users.findOne': (ctx) =>
    ctx.params.query?.authUser === 109 ? existing : null,
  'users.update': (ctx) => ({ ...existing, ...ctx.params }),
  'users.create': (ctx) => ({ id: 10, ...ctx.params }),
  'tenantUsers.createRelationshipsIfNeeded': () => ({ ok: true }),
};

const stubMiddleware: any = {
  name: 'stubs',
  localAction(next: any, action: any) {
    return (ctx: any) => {
      calls.push({ action: action.name, params: ctx.params });
      return stubs[action.name]
        ? Promise.resolve().then(() => stubs[action.name](ctx))
        : next(ctx);
    };
  },
};

describe('users.invite does not overwrite an existing user', () => {
  const broker = new ServiceBroker({
    logger: false,
    middlewares: [stubMiddleware],
  });

  beforeAll(async () => {
    process.env.DB_CONNECTION =
      process.env.DB_CONNECTION || 'postgresql://x@127.0.0.1:1/x';
    const { default: UsersService } = await import(
      '../../services/users.service'
    );
    const users: any = broker.createService(UsersService as any);
    users.schema.started = undefined;
    // Registered only so the calls resolve; the middleware answers them.
    const noop = (): null => null;
    broker.createService({
      name: 'auth',
      actions: { 'users.invite': noop, 'groups.get': noop },
    });
    broker.createService({
      name: 'tenantUsers',
      actions: { createRelationshipsIfNeeded: noop },
    });
    await broker.start().catch((): void => undefined);
  });

  afterAll(() => broker.stop());
  beforeEach(() => (calls.length = 0));

  const tenantAdmin = {
    user: { id: 6, type: 'USER' },
    profile: { id: 1, role: 'ADMIN', authGroup: 1001 },
  };
  const invite = (extra: any = {}) =>
    broker.call(
      'users.invite',
      {
        personalCode: '39001010000',
        firstName: 'Jonas',
        lastName: 'J',
        email: 'attacker@evil.lt',
        phone: '+37061111111',
        ...extra,
      },
      { meta: tenantAdmin }
    );

  it('does not pass a client `update` flag to findOrCreate', async () => {
    await invite({ update: true });
    const foc = calls.find((c) => c.action === 'users.findOrCreate');
    expect(foc?.params.update).not.toBe(true);
  });

  it("does not change an existing user's contacts", async () => {
    await invite({ update: true });
    expect(calls.some((c) => c.action === 'users.update')).toBe(false);
  });

  it('still invites: existing user is linked to the tenant', async () => {
    const user: any = await invite();
    expect(user.id).toBe(9);
    expect(
      calls.some((c) => c.action === 'tenantUsers.createRelationshipsIfNeeded')
    ).toBe(true);
  });
});
