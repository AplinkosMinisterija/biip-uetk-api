'use strict';

// @ts-ignore
import MinioMixin from 'moleculer-minio';
import Moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import { UserAuthMeta, AuthType } from './api.service';
import {
  getExtention,
  getMimetype,
  getPublicFileName,
  IMAGE_TYPES,
  MultipartMeta,
  throwNotFoundError,
  throwUnableToUploadError,
  throwUnsupportedMimetypeError,
} from '../types';

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
        default: getPublicFileName(50),
      },
      isPrivate: {
        type: 'boolean',
        default: false,
      },
    },
    timeout: 0,
  })
  async uploadFile(
    ctx: Context<
      {
        payload: NodeJS.ReadableStream;
        folder: string;
        types: string[];
        name: string;
        isPrivate?: boolean;
      },
      UserAuthMeta & MultipartMeta & { protected?: boolean }
    >
  ) {
    const { mimetype, filename } = ctx.meta;
    const { folder, payload, types, isPrivate, name } = ctx.params;
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

    return {
      success: true,
      url,
      size,
      filename,
      path: `${bucketName}/${objectFileName}`,
    };
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
    auth: AuthType.PUBLIC,
    rest: 'GET /:bucket/:name+',
  })
  async getFile(
    ctx: Context<
      { bucket: string; name: string[] },
      {
        $responseHeaders: any;
        $statusCode: number;
        $statusMessage: string;
        $responseType: string;
      }
    >
  ) {
    const { bucket, name } = ctx.params;

    try {
      const reader: NodeJS.ReadableStream = await ctx.call('minio.getObject', {
        bucketName: bucket,
        objectName: name.join('/'),
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
        optional: true,
        type: 'string',
        default: BUCKET_NAME(),
      },
    },
  })
  async fileStat(ctx: Context<{ bucketName: string; objectName: string }>) {
    const { bucketName, objectName } = ctx.params;

    try {
      const data: any = await ctx.call('minio.statObject', {
        bucketName,
        objectName,
      });

      const exists = data?.size > 0;

      return {
        exists,
        publicUrl: exists && this.getObjectUrl(objectName, false, bucketName),
        privateUrl: exists && this.getObjectUrl(objectName, true, bucketName),
      };
    } catch (err) {}

    return {
      exists: false,
    };
  }

  @Action({
    params: {
      path: 'string',
    },
  })
  async removeFile(ctx: Context<{ path: string }>) {
    const { path } = ctx.params;

    const [bucket, ...paths] = path.split('/');

    try {
      const result = await ctx.call('minio.removeObject', {
        bucketName: bucket,
        objectName: paths.join('/'),
      });
      return { sucess: !result };
    } catch (err) {
      return { succes: false };
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

  created() {
    if (!process.env.MINIO_ACCESSKEY || !process.env.MINIO_SECRETKEY) {
      this.broker.fatal('MINIO is not configured');
    }
  }
}
