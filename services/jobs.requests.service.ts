'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import moment from 'moment';
import BullMqMixin from '../mixins/bullmq.mixin';
import { FILE_TYPES, throwNotFoundError } from '../types';
import {
  addLeadingZeros,
  getRequestSecret,
  getTemplateHtml,
  roundNumber,
  toMD5Hash,
  toReadableStream,
} from '../utils';
import { AuthType } from './api.service';
import { Request } from './requests.service';
import { Tenant } from './tenants.service';
import { User } from './users.service';

@Service({
  name: 'jobs.requests',
  mixins: [BullMqMixin],
  settings: {
    bullmq: {
      worker: { concurrency: 5 },
      job: {
        attempts: 5,
        failParentOnFailure: true,
        backoff: 1000,
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

    const secret = getRequestSecret(request);

    const footerHtml = getTemplateHtml('footer.ejs', {
      id: addLeadingZeros(id),
      date: moment(request.createdAt).format('YYYY-MM-DD'),
    });

    const pdf = await ctx.call('tools.makePdf', {
      url: `${process.env.SERVER_HOST}/jobs/requests/${id}/html?secret=${secret}&skey=${screenshotsHash}`,
      footer: footerHtml,
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

    return { job: job.id };
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

    const params = new URLSearchParams({
      screenshot: '1',
      preview: '1',
    });

    function getUrl(params: URLSearchParams) {
      const mapHost = process.env.MAPS_HOST || 'https://maps.biip.lt';
      return `${mapHost}/uetk?${params.toString()}`;
    }

    // add all objects
    objects.forEach((item) => {
      params.set('cadastralId', `${item.id}`);
      data.push({
        url: getUrl(params),
        hash: item.hash,
      });
    });

    const childrenJobs = data.map((item) => ({
      params: { ...item, waitFor: '#image-canvas-0' },
      name: 'jobs',
      action: 'saveScreenshot',
    }));

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
      skey: {
        type: 'string',
        optional: true,
      },
    },
    rest: 'GET /:id/html',
    timeout: 0,
    auth: AuthType.PUBLIC,
  })
  async getRequestHtml(
    ctx: Context<
      { id: number; secret: string; skey: string },
      { $responseType: string }
    >
  ) {
    const { id, secret, skey: screenshotsRedisKey } = ctx.params;

    const request: Request = await ctx.call('requests.resolve', {
      id,
      throwIfNotExist: true,
    });

    const secretToApprove = getRequestSecret(request);
    if (!request?.id || !secret || secret !== secretToApprove) {
      return throwNotFoundError('Invalid secret!');
    }

    const objects: any[] = await this.getRequestData(id);

    let screenshotsByHash: any = {};
    if (screenshotsRedisKey) {
      screenshotsByHash = await this.broker.cacher.get(
        `screenshots.${screenshotsRedisKey}`
      );
    }

    ctx.meta.$responseType = 'text/html';

    return getTemplateHtml('request.ejs', {
      id: addLeadingZeros(id),
      date: request.createdAt,
      objects: objects.map((o) => ({
        ...o,
        screenshot: screenshotsByHash?.[o.hash] || '',
      })),
      formatDate: (date: string, format = 'YYYY-MM-DD') => {
        if (!date?.toString()?.trim()) return;

        const momentDate = moment(date);

        if (!momentDate.isValid()) return;

        return momentDate.format(format);
      },
      roundNumber,
      trimValue: (value?: string) => {
        if (!value) return '';

        return value?.trim();
      },
      fullData: !!request?.data?.extended,
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
    const request: Request = await this.broker.call('requests.resolve', {
      id,
      populate: 'geom',
    });

    const cadastralIds = request.objects
      ?.filter((i) => i.type === 'CADASTRAL_ID')
      ?.map((i) => i.id)
      ?.filter((i) => !!i);

    const query: any = {};

    if (cadastralIds?.length) {
      query.cadastralId = { $in: cadastralIds };
    }

    if (request.geom && !!Object.keys(request.geom).length) {
      query.geom = request.geom;
    }

    if (!query.cadastralId && !query.geom) return [];

    const allItems: any[] = await this.broker.call('objects.find', {
      query,
      populate: 'extendedData',
    });

    const objects = allItems.map((item) => ({
      ...item,
      screenshot: '',
      id: item.cadastralId,
      hash: toMD5Hash(`cadastralId=${item.cadastralId}`),
    }));

    return objects;
  }
}
