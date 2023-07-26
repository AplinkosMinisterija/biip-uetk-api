'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import BullMqMixin from '../mixins/bullmq.mixin';
import { User } from './users.service';
import { Tenant } from './tenants.service';
import {
  getLakesAndPondsQuery,
  getTemplateHtml,
  roundNumber,
  toMD5Hash,
  toReadableStream,
} from '../utils';
import { FILE_TYPES, throwNotFoundError } from '../types';
import { Request } from './requests.service';
import { AuthType } from './api.service';
import moment from 'moment';

function getSecret(request: Request) {
  return toMD5Hash(
    `id=${request.id}&date=${moment(request.createdAt).format(
      'YYYYMMDDHHmmss'
    )}`
  );
}

@Service({
  name: 'jobs.requests',
  mixins: [BullMqMixin],
  settings: {
    bullmq: {
      worker: { concurrency: 10 },
      job: {
        attempts: 5,
        backoff: {
          type: 'fixed',
          delay: 1000,
        },
      },
    },
  },
})
export default class JobsRequestsService extends moleculer.Service {
  @Action({
    queue: true,
    params: {
      id: 'number',
    },
    timeout: 0,
  })
  async generateAndSavePdf(ctx: Context<{ id: number }>) {
    const { id } = ctx.params;
    const { job } = ctx.locals;

    const request: Request = await ctx.call('requests.resolve', {
      id,
      populate: 'createdBy,tenant',
    });

    const childrenValues = await job.getChildrenValues();

    const screenshotsByHash: any = Object.values(childrenValues).reduce(
      (acc: any, item: any) => ({
        ...acc,
        [item.hash]: item.url,
      }),
      {}
    );

    const screenshotsHash = toMD5Hash(
      `id=${id}&date=${moment().format('YYYYMMDDHHmmsss')}`
    );
    const redisKey = `screenshots.${screenshotsHash}`;

    await this.broker.cacher.set(redisKey, screenshotsByHash);

    const objects: any[] = await this.getRequestData(id);

    const secret = getSecret(request);

    const pdf = await ctx.call('tools.makePdf', {
      url: `${process.env.SERVER_HOST}/jobs/requests/${id}/html?secret=${secret}&skey=${screenshotsHash}`,
    });

    const folder = this.getFolderName(
      request?.createdBy as any as User,
      request?.tenant as Tenant
    );

    const result: any = await ctx.call(
      'minio.uploadFile',
      {
        payload: toReadableStream(pdf),
        folder,
        isPrivate: true,
        types: FILE_TYPES,
      },
      {
        meta: {
          mimetype: 'application/pdf',
          filename: `israsas-${request.id}.pdf`,
        },
      }
    );

    await ctx.call('requests.saveGeneratedPdf', {
      id,
      url: result.url,
    });

    return { job: job.id, objects };
  }

  @Action({
    params: {
      id: 'number',
    },
    timeout: 0,
  })
  async initiatePdfGenerate(ctx: Context<{ id: number }>) {
    const data: any[] = [];

    const { id } = ctx.params;

    const objects: any[] = await this.getRequestData(id);

    const params = new URLSearchParams();

    function getUrl(params: URLSearchParams) {
      const mapHost = process.env.MAPS_HOST || 'https://maps.biip.lt';
      return `${mapHost}/uetk?${params.toString()}`;
    }

    // add all objects
    objects.forEach((item) => {
      params.set('cadastralId', `${item.kadastroId}`);
      data.push({
        url: getUrl(params),
        hash: item.hash,
      });
    });

    // const childrenJobs = data.map((item) => ({
    //   params: item,
    //   name: 'jobs',
    //   action: 'saveScreenshot',
    // }));

    const childrenJobs: any[] = [];

    return this.flow(
      ctx,
      'jobs.requests',
      'generateAndSavePdf',
      {
        id,
      },
      childrenJobs
    );
  }

  @Action({
    params: {
      id: {
        type: 'number',
        convert: true,
      },
      secret: 'string',
      skey: 'string',
    },
    rest: 'GET /:id/html',
    auth: AuthType.PUBLIC,
  })
  async getRequestHtml(
    ctx: Context<
      { id: number; secret: string; skey: string },
      { $responseType: string }
    >
  ) {
    const { id, secret, skey: screenshotsRedisKey } = ctx.params;

    const request: Request = await ctx.call('requests.resolve', { id });

    const secretToApprove = getSecret(request);
    if (!request?.id || !secret || secret !== secretToApprove) {
      return throwNotFoundError('Invalid secret!')
    }

    const objects: any[] = await this.getRequestData(id);

    const screenshotsByHash = await this.broker.cacher.get(
      `screenshots.${screenshotsRedisKey}`
    );

    ctx.meta.$responseType = 'text/html';

    return getTemplateHtml('request.ejs', {
      id,
      date: request.createdAt,
      objects: objects.map((o) => ({
        ...o,
        screenshot: screenshotsByHash?.[o.hash] || '',
      })),
      roundNumber,
      moment,
      dateFormat: 'YYYY-MM-DD',
      fullData: false,
    });
  }

  @Method
  getFolderName(user?: User, tenant?: Tenant) {
    const tenantPath = tenant?.id || 'private';
    const userPath = user?.id || 'user';

    return `uploads/requests/${tenantPath}/${userPath}`;
  }

  @Method
  async getRequestData(id: number) {
    const request: Request = await this.broker.call('requests.resolve', { id });

    const cadastralIds = request.objects
      .filter((i) => i.type === 'CADASTRAL_ID')
      .map((i) => i.id);

    const lakesAndPonds = await getLakesAndPondsQuery({ cadastralIds });

    const objects = [...lakesAndPonds].map((item) => ({
      ...item,
      screenshot: '',
      hash: toMD5Hash(`cadastralId=${item.kadastroId}`),
    }));

    return objects;
  }
}
