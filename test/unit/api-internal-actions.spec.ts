import { ServiceBroker } from 'moleculer';
import http from 'http';
import { AddressInfo } from 'net';

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode || 0));
      })
      .on('error', reject);
  });
}

// The real, unmodified `api.service` gateway. Stand-in actions are PUBLIC so no
// auth service is needed; the check runs before authentication anyway.
describe('api gateway blocks internal actions reached by automatic mapping', () => {
  const broker = new ServiceBroker({ logger: false });
  let base: string;

  beforeAll(async () => {
    process.env.PORT = '0';
    const { default: ApiService } = await import('../../services/api.service');
    broker.createService({
      name: 'probe',
      actions: {
        withRest: {
          rest: 'GET /with-rest',
          auth: 'PUBLIC',
          handler: () => 'ok',
        },
        internal: { auth: 'PUBLIC', handler: () => 'internal' },
        internalNoAuth: { handler: () => 'internal' },
      },
    } as any);
    broker.createService(ApiService as any);
    await broker.start();
    const api: any = broker.getLocalService('api');
    base = `http://127.0.0.1:${
      (api.server.address() as AddressInfo).port
    }/uetk`;
    // moleculer-web builds autoAliases asynchronously (debounced after
    // `$services.changed`); wait until the probe's rest alias exists.
    for (let i = 0; i < 50; i++) {
      if ((await get(`${base}/probe/with-rest`)) === 200) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  afterAll(() => broker.stop());

  it('serves an action through its declared rest alias', async () => {
    expect(await get(`${base}/probe/with-rest`)).toBe(200);
  });

  it('still serves an action that has rest through an auto-mapped path', async () => {
    expect(await get(`${base}/probe/withRest`)).toBe(200);
  });

  it('blocks an auto-mapped action without rest', async () => {
    expect(await get(`${base}/probe/internal`)).toBe(404);
  });

  it('blocks it before authentication (no 401 hint)', async () => {
    expect(await get(`${base}/probe/internalNoAuth`)).toBe(404);
  });

  it('keeps explicit aliases of actions without rest (GET /ping -> api.ping)', async () => {
    expect(await get(`${base}/ping`)).toBe(200);
  });

  it('blocks $node actions', async () => {
    expect(await get(`${base}/~node/health`)).toBe(404);
  });
});
