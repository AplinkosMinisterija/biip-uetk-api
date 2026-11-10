import { ServiceBroker } from 'moleculer';

// Dummy MinIO settings so the service can be constructed; nothing connects:
// `minio.getObject` is answered by the middleware below.
Object.assign(process.env, {
  MINIO_ENDPOINT: process.env.MINIO_ENDPOINT || '127.0.0.1',
  MINIO_PORT: process.env.MINIO_PORT || '9000',
  MINIO_ACCESSKEY: process.env.MINIO_ACCESSKEY || 'x',
  MINIO_SECRETKEY: process.env.MINIO_SECRETKEY || 'x',
  MINIO_BUCKET: 'uetk',
  DB_CONNECTION: process.env.DB_CONNECTION || 'postgresql://x@127.0.0.1:1/x',
});

const calls: { action: string; params: any }[] = [];
const stubMiddleware: any = {
  name: 'stubs',
  localAction(next: any, action: any) {
    return (ctx: any) => {
      calls.push({ action: action.name, params: ctx.params });
      if (action.name === 'minio.getObject') {
        return Promise.resolve({ stream: true });
      }
      return next(ctx);
    };
  },
};

describe('minio.getFile serves only this app bucket', () => {
  const broker = new ServiceBroker({
    logger: false,
    middlewares: [stubMiddleware],
  });

  beforeAll(async () => {
    const { default: MinioService } = await import(
      '../../services/minio.service'
    );
    const svc: any = broker.createService(MinioService as any);
    svc.schema.started = undefined;
    await broker.start().catch((): void => undefined);
  });

  afterAll(() => broker.stop());
  beforeEach(() => (calls.length = 0));

  it('refuses another bucket without reading it', async () => {
    await expect(
      broker.call('minio.getFile', { bucket: 'minio', name: ['admin', 'v3'] })
    ).rejects.toMatchObject({ code: 404 });
    expect(calls.some((c) => c.action === 'minio.getObject')).toBe(false);
  });

  it('serves a file from its own bucket', async () => {
    await broker.call('minio.getFile', {
      bucket: 'uetk',
      name: ['uploads', 'requests', 'a.zip'],
    });
    const get = calls.find((c) => c.action === 'minio.getObject');
    expect(get?.params).toMatchObject({
      bucketName: 'uetk',
      objectName: 'uploads/requests/a.zip',
    });
  });
});

describe('generated request files get an unguessable folder', () => {
  it('adds a random segment, different for every file', async () => {
    const { default: JobsRequestsService } = await import(
      '../../services/jobs.requests.service'
    );
    const getFolderName = (JobsRequestsService as any).prototype.getFolderName;
    const a: string = getFolderName({ id: 5 }, undefined);
    const b: string = getFolderName({ id: 5 }, undefined);
    expect(a).toMatch(/^uploads\/requests\/private\/5\/[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
    expect(getFolderName({ id: 5 }, { id: 7 })).toMatch(
      /^uploads\/requests\/7\/5\/[0-9a-f-]{36}$/
    );
  });
});
