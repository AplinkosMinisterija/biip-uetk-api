import { ServiceBroker } from 'moleculer';
import http from 'http';
import { AddressInfo } from 'net';

// jest 27's node environment has no global fetch.
function call(url: string, method = 'GET', json?: unknown) {
  return callRaw(
    url,
    method,
    json === undefined ? undefined : JSON.stringify(json)
  );
}

// Sends `payload` as-is, so a body can carry keys like "__proto__" that
// JSON.stringify of an object literal would not produce.
function callRaw(
  url: string,
  method = 'GET',
  payload?: string
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: payload ? { 'Content-Type': 'application/json' } : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, body: JSON.parse(data) })
        );
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Checks the real, unmodified `api.service` gateway: whatever a client sends, the
// action must never receive a `$raw` key. A stand-in `objects` service with PUBLIC
// actions echoes the params it gets (PUBLIC actions skip authentication, so no
// auth service is needed).
describe('api gateway strips client $raw', () => {
  const broker = new ServiceBroker({ logger: false });
  let baseUrl: string;

  beforeAll(async () => {
    process.env.PORT = '0';
    const { default: ApiService } = await import('../../services/api.service');

    broker.createService({
      name: 'objects',
      actions: {
        echo: {
          rest: 'GET /echo',
          auth: 'PUBLIC',
          handler: (ctx: any) => ctx.params,
        },
        echoPost: {
          rest: 'POST /echo',
          auth: 'PUBLIC',
          handler: (ctx: any) => ctx.params,
        },
      },
    } as any);

    broker.createService(ApiService as any);

    await broker.start();
    const api: any = broker.getLocalService('api');
    const { port } = api.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/uetk`;
  });

  afterAll(() => broker.stop());

  it('removes $raw from a JSON string query (GET)', async () => {
    const q = encodeURIComponent('{"$raw":"1=0","name":"Neris"}');
    const { status, body } = await call(
      `${baseUrl}/objects/echo?pageSize=1&query=${q}`
    );
    expect(status).toBe(200);
    expect(JSON.parse(body.query)).toEqual({ name: 'Neris' });
    expect(body.pageSize).toBe('1');
  });

  it('removes nested and unicode-escaped $raw (GET)', async () => {
    const q = encodeURIComponent('{"$or":[{"\\u0024raw":"1=0"},{"a":1}]}');
    const { body } = await call(`${baseUrl}/objects/echo?query=${q}`);
    expect(JSON.parse(body.query)).toEqual({ $or: [{}, { a: 1 }] });
  });

  it('removes $raw sent with qs bracket notation (GET)', async () => {
    const { body } = await call(
      `${baseUrl}/objects/echo?query[$raw]=1%3D0&query[name]=Neris`
    );
    expect(body.query).toEqual({ name: 'Neris' });
  });

  it('removes $raw from a JSON body (POST)', async () => {
    const { body } = await call(`${baseUrl}/objects/echo`, 'POST', {
      query: { $raw: '1=0', name: 'Neris' },
      $raw: 'x',
    });
    expect(body).toEqual({ query: { name: 'Neris' } });
  });

  it('removes $raw when the JSON body carries a __proto__ key (POST)', async () => {
    const { body } = await callRaw(
      `${baseUrl}/objects/echo`,
      'POST',
      '{"__proto__":{"x":1},"query":{"$raw":"1=0","name":"Neris"}}'
    );
    expect(body).toEqual({ query: { name: 'Neris' } });
  });

  it('removes $raw from a double-encoded query (GET)', async () => {
    const q = encodeURIComponent(
      JSON.stringify(JSON.stringify({ $raw: '1=0', a: 1 }))
    );
    const { body } = await call(`${baseUrl}/objects/echo?query=${q}`);
    expect(JSON.parse(body.query)).toEqual({ a: 1 });
  });

  it('passes ordinary params unchanged', async () => {
    const q = encodeURIComponent('{"name":"Neris"}');
    const { body } = await call(
      `${baseUrl}/objects/echo?query=${q}&search=Nemunas`
    );
    expect(body.query).toBe('{"name":"Neris"}');
    expect(body.search).toBe('Nemunas');
  });
});
