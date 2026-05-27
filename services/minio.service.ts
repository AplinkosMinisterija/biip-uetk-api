'use strict';

// @ts-ignore
import MinioMixin from 'moleculer-minio';
import Moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import { UserAuthMeta } from './api.service';
import {
  EndpointType,
  getExtention,
  getMimetype,
  getPublicFileName,
  IMAGE_TYPES,
  MultipartMeta,
  throwBadRequestError,
  throwNotFoundError,
  throwUnableToUploadError,
  throwUnsupportedMimetypeError,
} from '../types';
import moment from 'moment';

// Folder prefixes a caller is allowed to write to / delete from. Computed
// against the caller's identity (tenant profile or freelance user). Without
// this check uploadFile's `folder` parameter let an authenticated user write
// into someone else's private namespace.
function callerOwnedFolders(meta: UserAuthMeta): string[] {
  const userId = meta?.user?.id;
  const tenantId = meta?.profile?.id;
  const folders: string[] = [];
  // Cover both upload prefixes used in the codebase (forms, requests).
  for (const kind of ['forms', 'requests']) {
    folders.push(`uploads/${kind}/private/${userId ?? 'user'}`);
    if (tenantId) folders.push(`uploads/${kind}/${tenantId}/${userId ?? 'user'}`);
  }
  return folders;
}

function isFolderOwnedByCaller(folder: string, meta: UserAuthMeta): boolean {
  if (!folder || typeof folder !== 'string') return false;
  const normalized = folder.replace(/^\/+|\/+$/g, '');
  // Reject any path-traversal attempt before substring matching.
  if (normalized.includes('..') || normalized.includes('\\')) return false;
  // System / background worker context (no user identity) is trusted — the
  // calling action (e.g. jobs.requests.generateAndSavePdf) computed the folder
  // from validated request data, not from request params.
  if (!meta?.user?.id) return true;
  if (meta.user.type === 'ADMIN') return true;
  return callerOwnedFolders(meta).some(
    (owned) => normalized === owned || normalized.startsWith(`${owned}/`)
  );
}

export const BUCKET_NAME = () => process.env.MINIO_BUCKET || 'uetk';

@Service({
  name: 'minio',
  mixins: [MinioMixin],
  settings: {
    endPoint: process.env.MINIO_ENDPOINT,
    port: parseInt(process.env.MINIO_PORT),
    useSSL: process.env.MINIO_USESSL === 'true',
    accessKey: process.env.MINIO_ACCESSKEY,
    secretKey: process.env.MINIO_SECRETKEY,
  },
})
export default class MinioService extends Moleculer.Service {
  @Action({
    params: {
      bucketName: {
        type: 'string',
        optional: true,
        default: BUCKET_NAME(),
      },
      objectName: 'string',
      isPrivate: {
        type: 'boolean',
        default: false,
      },
    },
    visibility: 'protected',
  })
  getUrl(
    ctx: Context<{
      bucketName: string;
      objectName: string;
      isPrivate?: boolean;
    }>
  ) {
    const { bucketName, objectName, isPrivate } = ctx.params;

    return this.getObjectUrl(objectName, isPrivate, bucketName);
  }

  /**
   * Convert a stored "private" object URL into a freshly-signed presigned URL.
   * Returns the input unchanged when the stored value is not one of our private
   * proxy URLs (e.g. already absolute MinIO public URL, external string).
   * Lets FE keep using `<a href={url}>` without sending an Authorization header.
   */
  @Action({
    params: { url: 'string' },
    visibility: 'protected',
  })
  async signStoredUrl(ctx: Context<{ url: string }>) {
    const { url } = ctx.params;
    if (!url || typeof url !== 'string') return url;

    const marker = '/minio/';
    const idx = url.indexOf(marker);
    if (idx === -1) return url;

    const rest = url.slice(idx + marker.length);
    const [bucketName, ...objectParts] = rest.split('/');
    const objectName = objectParts.join('/');
    if (!bucketName || !objectName) return url;

    try {
      return await this.getPresignedUrl(ctx, objectName, bucketName);
    } catch (err) {
      this.logger.warn('signStoredUrl failed, returning raw URL', err);
      return url;
    }
  }

  @Action({
    params: {
      folder: 'string',
      types: {
        type: 'array',
        items: 'string',
        optional: true,
        default: IMAGE_TYPES,
      },
      name: {
        type: 'string',
        optional: true,
      },
      isPrivate: {
        type: 'boolean',
        default: false,
      },
      presign: {
        type: 'boolean',
        default: false,
      },
    },
    timeout: 0,
    // Not directly callable via API — go through forms.upload / requests flows
    // which set folder/isPrivate from authenticated context.
    visibility: 'protected',
  })
  async uploadFile(
    ctx: Context<
      {
        payload: NodeJS.ReadableStream;
        folder: string;
        types: string[];
        name: string;
        presign?: boolean;
        isPrivate?: boolean;
      },
      UserAuthMeta & MultipartMeta & { protected?: boolean }
    >
  ) {
    const { mimetype, filename } = ctx.meta;
    const {
      folder,
      payload,
      types,
      isPrivate,
      name: defaultName,
      presign,
    } = ctx.params;
    const name = defaultName || getPublicFileName(50);

    if (!isFolderOwnedByCaller(folder, ctx.meta)) {
      throwBadRequestError('Folder not allowed for this caller');
    }

    if (!types.includes(mimetype)) {
      throwUnsupportedMimetypeError();
    }

    const extension = getExtention(mimetype);

    const objectFileName = `${folder}/${name}.${extension}`;
    const bucketName = BUCKET_NAME();

    try {
      await ctx.call('minio.putObject', payload, {
        meta: {
          bucketName,
          objectName: objectFileName,
          metaData: {
            'Content-Type': mimetype,
          },
        },
      });
    } catch (_e) {
      throwUnableToUploadError();
    }

    const { size }: { size: number } = await ctx.call('minio.statObject', {
      objectName: objectFileName,
      bucketName,
    });

    const url = await ctx.call('minio.getUrl', {
      objectName: objectFileName,
      isPrivate,
      bucketName,
    });

    const response: any = {
      success: true,
      url,
      size,
      filename,
      path: `${bucketName}/${objectFileName}`,
    };

    if (presign) {
      const presignedUrl: string = await this.getPresignedUrl(
        ctx,
        objectFileName,
        bucketName
      );
      response.presignedUrl = presignedUrl;
    }

    return response;
  }

  @Action({
    params: {
      name: {
        type: 'array',
        items: {
          type: 'string',
          convert: true,
        },
      },
    },
    rest: 'GET /:bucket/:name+',
    types: [
      EndpointType.ADMIN,
      EndpointType.USER,
      EndpointType.TENANT_USER,
      EndpointType.TENANT_ADMIN,
    ],
  })
  async getFile(
    ctx: Context<
      { bucket: string; name: string[] },
      UserAuthMeta & {
        $responseHeaders: any;
        $statusCode: number;
        $statusMessage: string;
        $responseType: string;
      }
    >
  ) {
    const { bucket, name } = ctx.params;
    const objectName = name.join('/');

    // Admins read anything; everyone else must own the folder.
    if (
      ctx.meta?.user?.type !== 'ADMIN' &&
      !isFolderOwnedByCaller(objectName, ctx.meta)
    ) {
      return throwNotFoundError('File not found.');
    }

    try {
      const reader: NodeJS.ReadableStream = await ctx.call('minio.getObject', {
        bucketName: bucket,
        objectName,
      });

      const filename = name[name.length - 1];
      const mimetype = getMimetype(filename);
      if (mimetype) {
        ctx.meta.$responseType = mimetype;
      }

      return reader;
    } catch (err) {
      return throwNotFoundError('File not found.');
    }
  }

  @Action({
    params: {
      objectName: 'string',
      bucketName: {
        type: 'string',
        default: BUCKET_NAME(),
      },
    },
    visibility: 'protected',
  })
  async fileStat(ctx: Context<{ bucketName: string; objectName: string }>) {
    const { bucketName, objectName } = ctx.params;

    const response: any = {
      exists: false,
    };
    try {
      const data: any = await ctx.call('minio.statObject', {
        bucketName,
        objectName,
      });

      response.exists = data?.size > 100;

      if (response.exists) {
        const presignedUrl: string = await this.getPresignedUrl(
          ctx,
          objectName,
          bucketName
        );

        response.publicUrl = this.getObjectUrl(objectName, false, bucketName);
        response.privateUrl = this.getObjectUrl(objectName, true, bucketName);
        response.presignedUrl = presignedUrl;
        response.lastModified = moment(data.lastModified).format();
      }

      return response;
    } catch (err) {}

    return response;
  }

  @Action({
    params: {
      path: 'string',
    },
    types: [
      EndpointType.ADMIN,
      EndpointType.USER,
      EndpointType.TENANT_USER,
      EndpointType.TENANT_ADMIN,
    ],
  })
  async removeFile(ctx: Context<{ path: string }, UserAuthMeta>) {
    const { path } = ctx.params;

    const [bucket, ...paths] = path.split('/');
    const objectName = paths.join('/');

    if (
      ctx.meta?.user?.type !== 'ADMIN' &&
      !isFolderOwnedByCaller(objectName, ctx.meta)
    ) {
      return { success: false };
    }

    try {
      const result = await ctx.call('minio.removeObject', {
        bucketName: bucket,
        objectName,
      });
      return { success: !result };
    } catch (err) {
      return { success: false };
    }
  }

  async started() {
    try {
      const bucketExists: boolean = await this.actions.bucketExists({
        bucketName: BUCKET_NAME(),
      });

      if (!bucketExists) {
        await this.actions.makeBucket({
          bucketName: BUCKET_NAME(),
        });

        await this.client.setBucketPolicy(
          BUCKET_NAME(),
          JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: {
                  AWS: ['*'],
                },
                Action: ['s3:GetObject'],
                Resource: [
                  `arn:aws:s3:::${BUCKET_NAME()}/uploads/species/*`,
                  `arn:aws:s3:::${BUCKET_NAME()}/uploads/forms/*`,
                ],
              },
            ],
          })
        );

        await this.client.setBucketLifecycle(BUCKET_NAME(), {
          Rule: [
            {
              ID: 'Expiration Rule For Temp Files',
              Status: 'Enabled',
              Filter: {
                Prefix: 'temp/*',
              },
              Expiration: {
                Days: '7',
              },
            },
          ],
        });
      }
    } catch (err) {
      this.broker.logger.fatal(err);
    }
  }

  @Method
  getObjectUrl(
    objectName: string,
    isPrivate: boolean = false,
    bucketName: string = BUCKET_NAME()
  ) {
    let hostUrl = process.env.MINIO_PUBLIC_URL;

    if (isPrivate) {
      hostUrl = `${process.env.SERVER_HOST}/minio`;
    }

    return `${hostUrl}/${bucketName}/${objectName}`;
  }

  @Method
  getPresignedUrl(
    ctx: Context,
    objectName: string,
    bucketName: string = BUCKET_NAME()
  ): Promise<string> {
    return ctx.call('minio.presignedUrl', {
      bucketName,
      objectName,
      httpMethod: 'GET',
      expires: 60 * 60 * 24 * 7, // 1 week
      reqParams: {},
      requestDate: moment().format(),
    });
  }

  created() {
    if (!process.env.MINIO_ACCESSKEY || !process.env.MINIO_SECRETKEY) {
      this.broker.fatal('MINIO is not configured');
    }
  }
}
