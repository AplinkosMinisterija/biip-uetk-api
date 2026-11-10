import { ServiceBroker } from 'moleculer';
import http from 'http';
import {
  attachmentHeader,
  safeFileName,
  toOwnFileUrl,
} from '../../utils/functions';

const SERVER_HOST = 'https://internalapi.example.lt/uetk';
const OWN = `${SERVER_HOST}/minio/`;

describe('toOwnFileUrl', () => {
  it.each([
    [
      'own URL',
      `${OWN}uetk/uploads/requests/private/1/israsas-1.zip`,
      `${OWN}uetk/uploads/requests/private/1/israsas-1.zip`,
    ],
    ['keeps the query string', `${OWN}uetk/a.pdf?x=1`, `${OWN}uetk/a.pdf?x=1`],
    // Older rows were saved with another host of this API (seen on staging).
    [
      'older host of this API',
      'https://staging.internalapi.example.lt/uetk/minio/uetk/a.zip',
      `${OWN}uetk/a.zip`,
    ],
    [
      'public /api path',
      'https://uetk.example.lt/api/minio/uetk/a.zip',
      `${OWN}uetk/a.zip`,
    ],
  ])('maps %s to this API', (_name, url, expected) => {
    expect(toOwnFileUrl(url, SERVER_HOST)).toBe(expected);
  });

  it.each([
    ['foreign host', 'https://evil.example/uetk/minio/a.pdf'],
    [
      'userinfo trick',
      'https://internalapi.example.lt@evil.example/uetk/minio/a',
    ],
    [
      'look-alike host',
      'https://internalapi.example.lt.evil.example/uetk/minio/a',
    ],
  ])('never leaves this API for %s', (_name, url) => {
    const out = toOwnFileUrl(url, SERVER_HOST);
    expect(out && new URL(out).origin).toBe(new URL(SERVER_HOST).origin);
    expect(out?.startsWith(OWN)).toBe(true);
  });

  it.each([
    ['no /minio/ part', `${SERVER_HOST}/tools/ping`],
    ['internal docker host without /minio/', 'http://tools:3000/tools/ping'],
    ['dot-dot escape', `${OWN}../tools/ping`],
    ['encoded dot-dot', `${OWN}%2e%2e/tools/ping`],
    ['empty object path', OWN],
    ['prefix without slash', `${SERVER_HOST}/minioX/a`],
    ['file scheme', 'file:///uetk/minio/etc/passwd'],
    ['not a url', 'minio/a.pdf'],
    ['empty', ''],
  ])('rejects %s', (_name, url) => {
    expect(toOwnFileUrl(url, SERVER_HOST)).toBeUndefined();
  });

  it('rejects everything when SERVER_HOST is not set', () => {
    expect(toOwnFileUrl(`${OWN}a`, undefined)).toBeUndefined();
  });

  it('works when SERVER_HOST has a trailing slash', () => {
    expect(toOwnFileUrl(`${OWN}a`, `${SERVER_HOST}/`)).toBe(`${OWN}a`);
  });
});

describe('safeFileName / attachmentHeader', () => {
  it('makes an ASCII name that cannot break a quoted header value', () => {
    expect(safeFileName('a"b\\c\r\nd.pdf')).toBe('a_b_c__d.pdf');
    expect(safeFileName('Išrašas Nr. 5.zip')).toBe('I_ra_as Nr. 5.zip');
    expect(safeFileName('')).toBe('file');
  });

  it.each([
    '0000123.zip',
    'Išrašas Nr. 5.zip',
    'a"b\\c\r\nd.pdf',
    "it's (1)*.pdf",
    '',
  ])('builds a header Node accepts for %j', (name) => {
    const header = attachmentHeader(name);
    expect(() =>
      http.validateHeaderValue('Content-Disposition', header)
    ).not.toThrow();
    const star = header.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(star)).toBe(name || 'file');
  });
});

describe('tools.download action', () => {
  const broker = new ServiceBroker({ logger: false });
  const fetchMock = jest.fn();

  beforeAll(async () => {
    process.env.SERVER_HOST = SERVER_HOST;
    process.env.TOOLS_HOST = 'http://tools:3000/tools';
    process.env.DB_CONNECTION =
      process.env.DB_CONNECTION || 'postgresql://x@127.0.0.1:1/x';
    (global as any).fetch = fetchMock;
    const { default: ToolsService } = await import(
      '../../services/tools.service'
    );
    broker.createService(ToolsService as any);
    await broker.start();
  });

  afterAll(() => broker.stop());
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      status: 200,
      headers: { get: () => 'application/zip' },
      body: { getReader: () => ({ read: async () => ({ done: true }) }) },
    });
  });

  it('refuses a URL without a file path, without calling tools', async () => {
    await expect(
      broker.call('tools.download', {
        url: 'http://tools:3000/tools/ping',
        name: 'x',
      })
    ).rejects.toMatchObject({ code: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends tools only to this API, even for a foreign host', async () => {
    await broker.call('tools.download', {
      url: 'https://evil.example/x/minio/uetk/a.zip',
      name: 'a"b.zip',
    });
    const called = new URL(fetchMock.mock.calls[0][0]);
    expect(`${called.origin}${called.pathname}`).toBe(
      'http://tools:3000/tools/download'
    );
    expect(called.searchParams.get('url')).toBe(`${OWN}uetk/a.zip`);
    expect(called.searchParams.get('name')).toBe('a_b.zip');
  });

  it('proxies an own file URL unchanged', async () => {
    const url = `${OWN}uetk/uploads/requests/private/1/israsas-1.zip`;
    await broker.call('tools.download', { url, name: 'a.zip' });
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('url')).toBe(
      url
    );
  });
});
