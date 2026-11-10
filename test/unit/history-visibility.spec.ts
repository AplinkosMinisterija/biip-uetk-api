import { Errors, ServiceBroker } from 'moleculer';

// Real `forms.getHistory` / `requests.getHistory`; the DB-backed `resolve` and
// `histories.list` are stubbed: `resolve` behaves like the default scopes do
// (`visibleToUser`): an entity the caller may not see is "not found".
const visibleTo: Record<string, Record<number, number[]>> = {
  forms: { 1: [100] },
  requests: { 5: [100] },
};
const calls: { action: string; params: any }[] = [];

function resolveStub(service: string) {
  return (ctx: any) => {
    const owners = visibleTo[service][Number(ctx.params.id)] || [];
    if (!owners.includes(ctx.meta?.user?.id)) {
      if (ctx.params.throwIfNotExist) {
        throw new Errors.MoleculerClientError(
          'Entity not found',
          404,
          'ENTITY_NOT_FOUND'
        );
      }
      return null;
    }
    return { id: Number(ctx.params.id) };
  };
}

const stubs: Record<string, (ctx: any) => any> = {
  'forms.resolve': resolveStub('forms'),
  'requests.resolve': resolveStub('requests'),
  'forms.histories.list': () => ({
    rows: [{ id: 1, type: 'CREATED' }],
    total: 1,
  }),
  'requests.histories.list': () => ({
    rows: [{ id: 1, type: 'CREATED' }],
    total: 1,
  }),
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

describe('history is only as visible as its form or request', () => {
  const broker = new ServiceBroker({
    logger: false,
    middlewares: [stubMiddleware],
  });
  let formsSchema: any;
  let requestsSchema: any;

  beforeAll(async () => {
    process.env.DB_CONNECTION =
      process.env.DB_CONNECTION || 'postgresql://x@127.0.0.1:1/x';
    process.env.GIS_DB_CONNECTION =
      process.env.GIS_DB_CONNECTION || 'postgresql://x@127.0.0.1:1/x';
    const { default: FormsService } = await import(
      '../../services/forms.service'
    );
    const { default: RequestsService } = await import(
      '../../services/requests.service'
    );
    const forms: any = broker.createService(FormsService as any);
    const requests: any = broker.createService(RequestsService as any);
    formsSchema = forms.schema;
    requestsSchema = requests.schema;
    for (const svc of [forms, requests]) svc.schema.started = undefined;
    for (const name of ['forms.histories', 'requests.histories']) {
      broker.createService({ name, actions: { list: () => null } });
    }
    await broker.start().catch((): void => undefined);
  });

  afterAll(() => broker.stop());
  beforeEach(() => (calls.length = 0));

  it.each([
    ['forms', 1],
    ['requests', 5],
  ])('%s: the owner gets the history', async (service, id) => {
    const res: any = await broker.call(
      `${service}.getHistory`,
      { id },
      { meta: { user: { id: 100 } } }
    );
    expect(res.total).toBe(1);
    const resolve = calls.find((c) => c.action === `${service}.resolve`);
    expect(Number(resolve?.params.id)).toBe(id);
    expect(resolve?.params.throwIfNotExist).toBe(true);
  });

  it.each([
    ['forms', 1],
    ['requests', 5],
  ])(
    '%s: someone else gets 404 and the history is not read',
    async (service, id) => {
      await expect(
        broker.call(
          `${service}.getHistory`,
          { id },
          { meta: { user: { id: 200 } } }
        )
      ).rejects.toMatchObject({ code: 404 });
      expect(calls.some((c) => c.action === `${service}.histories.list`)).toBe(
        false
      );
    }
  );

  it('resolve applies visibleToUser by default in both services', () => {
    for (const schema of [formsSchema, requestsSchema]) {
      expect(schema.settings.defaultScopes).toContain('visibleToUser');
    }
  });
});
