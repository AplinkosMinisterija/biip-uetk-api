import { ServiceBroker } from 'moleculer';

// Real `users.updateUser` and `tenantUsers.updateUser`; DB-backed and external
// actions are stubbed with a broker middleware, so only the authorization logic
// of these two actions is exercised.
//
// Data: tenant 1 has members 5 (USER) and 6 (ADMIN); user 7 has no tenant;
// tenant 2 exists, user 5 is not a member there.
const members: Record<number, number[]> = { 1: [5, 6], 2: [9] };
const calls: { action: string; params: any }[] = [];

const stubs: Record<string, (ctx: any) => any> = {
  'users.get': (ctx) => ({
    id: Number(ctx.params.id),
    authUser: 100 + Number(ctx.params.id),
  }),
  'users.update': (ctx) => ({ id: ctx.params.id, email: ctx.params.email }),
  'tenants.get': (ctx) => ({
    id: Number(ctx.params.id),
    authGroup: 1000 + Number(ctx.params.id),
  }),
  'tenantUsers.findOne': (ctx) =>
    members[ctx.params.query.tenant]?.includes(ctx.params.query.user)
      ? { id: 1 }
      : null,
  'tenantUsers.update': () => ({ id: 1 }),
  'tenantUsers.userExistsInTenant': (ctx) =>
    !!members[ctx.params.tenantId]?.includes(ctx.params.userId),
  'auth.users.assignToGroup': () => ({ ok: true }),
};

const stubMiddleware = {
  name: 'stubs',
  localAction(next: any, action: any) {
    return (ctx: any) => {
      calls.push({ action: action.name, params: ctx.params });
      return stubs[action.name]
        ? Promise.resolve(stubs[action.name](ctx))
        : next(ctx);
    };
  },
  remoteAction(next: any) {
    return next;
  },
};

describe('users.updateUser authorization', () => {
  const broker = new ServiceBroker({
    logger: false,
    middlewares: [stubMiddleware as any],
  });

  beforeAll(async () => {
    process.env.DB_CONNECTION =
      process.env.DB_CONNECTION || 'postgresql://x@127.0.0.1:1/x';
    const { default: UsersService } = await import(
      '../../services/users.service'
    );
    const { default: TenantUsersService } = await import(
      '../../services/tenantUsers.service'
    );
    const users = broker.createService(UsersService as any);
    const tenantUsers = broker.createService(TenantUsersService as any);
    // Keep only the actions under test as real ones; everything else is stubbed.
    for (const svc of [users, tenantUsers] as any[]) {
      svc.started = async (): Promise<void> => undefined;
      svc.schema.started = undefined;
    }
    broker.createService({
      name: 'auth',
      actions: { 'users.assignToGroup': stubs['auth.users.assignToGroup'] },
    });
    broker.createService({
      name: 'tenants',
      actions: { get: stubs['tenants.get'] },
    });
    await broker.start().catch(() => undefined);
  });

  afterAll(() => broker.stop());
  beforeEach(() => (calls.length = 0));

  const USER = (id: number) => ({ id, type: 'USER' });
  const ADMIN = { id: 1, type: 'ADMIN' };
  const asTenant = (id: number, role: 'ADMIN' | 'USER') => ({ id, role });
  const update = (params: any, meta: any) =>
    broker.call('users.updateUser', params, { meta });
  const roleChanged = () =>
    calls.some((c) => c.action === 'tenantUsers.update');
  const userUpdated = () => calls.some((c) => c.action === 'users.update');

  it('lets a user change their own contact details', async () => {
    await update({ id: 5, email: 'a@b.lt' }, { user: USER(5) });
    expect(userUpdated()).toBe(true);
  });

  it('refuses a role change by a member without a profile (self)', async () => {
    await expect(
      update({ id: 5, role: 'ADMIN', tenantId: 1 }, { user: USER(5) })
    ).rejects.toMatchObject({ code: 401 });
    expect(roleChanged()).toBe(false);
  });

  it('refuses a role change by a member without a profile (other member)', async () => {
    await expect(
      update({ id: 6, role: 'USER', tenantId: 1 }, { user: USER(5) })
    ).rejects.toMatchObject({ code: 401 });
    expect(roleChanged()).toBe(false);
  });

  it('refuses a role change with a USER-role profile', async () => {
    await expect(
      update(
        { id: 5, role: 'ADMIN' },
        { user: USER(5), profile: asTenant(1, 'USER') }
      )
    ).rejects.toMatchObject({ code: 401 });
    expect(roleChanged()).toBe(false);
  });

  it("refuses changing another user's contacts without being their tenant admin", async () => {
    await expect(
      update({ id: 6, email: 'x@y.lt' }, { user: USER(7) })
    ).rejects.toMatchObject({
      code: 401,
    });
    await expect(
      update(
        { id: 6, email: 'x@y.lt' },
        { user: USER(5), profile: asTenant(1, 'USER') }
      )
    ).rejects.toMatchObject({ code: 401 });
    expect(userUpdated()).toBe(false);
  });

  it('lets a tenant admin update a member of their tenant, role included', async () => {
    await update(
      { id: 5, role: 'ADMIN', email: 'n@t.lt' },
      { user: USER(6), profile: asTenant(1, 'ADMIN') }
    );
    expect(roleChanged()).toBe(true);
    expect(userUpdated()).toBe(true);
  });

  it('does not let a tenant admin reach a user outside their tenant', async () => {
    await expect(
      update(
        { id: 9, email: 'x@y.lt' },
        { user: USER(6), profile: asTenant(1, 'ADMIN') }
      )
    ).rejects.toMatchObject({ code: 404 });
    expect(userUpdated()).toBe(false);
  });

  it('ignores a tenantId from the client for a tenant admin (uses the profile)', async () => {
    await update(
      { id: 5, role: 'USER', tenantId: 2 },
      { user: USER(6), profile: asTenant(1, 'ADMIN') }
    );
    const call = calls.find((c) => c.action === 'tenantUsers.updateUser');
    expect(Number(call?.params.tenantId)).toBe(1);
  });

  it('lets a system admin update anyone, role included', async () => {
    await update(
      { id: 5, role: 'ADMIN', tenantId: 1, email: 'a@b.lt' },
      { user: ADMIN }
    );
    expect(roleChanged()).toBe(true);
    expect(userUpdated()).toBe(true);
  });

  it('tenantUsers.updateUser itself refuses a caller without a profile who is not a system admin', async () => {
    await expect(
      broker.call(
        'tenantUsers.updateUser',
        { userId: 5, tenantId: 1, role: 'ADMIN' },
        { meta: { user: USER(5) } }
      )
    ).rejects.toMatchObject({ code: 401 });
    expect(roleChanged()).toBe(false);
  });
});
