'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import BullMqMixin from '../mixins/bullmq.mixin';
import { Request } from './requests.service';
import { User } from './users.service';
import { Tenant } from './tenants.service';
import { getLakesAndPondsQuery, toMD5Hash } from '../utils';

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

    // const request: Request = await ctx.call('requests.resolve', {
    //   id,
    //   populate: 'createdBy,tenant',
    // });

    const childrenValues = await job.getChildrenValues();

    const screenshotsByHash: any = Object.values(childrenValues).reduce(
      (acc: any, item: any) => ({
        ...acc,
        [item.hash]: item.url,
      }),
      {}
    );

    const objects: any[] = await this.getRequestData();

    // set screenshots for objects
    objects.forEach((item) => {
      item.screenshot = screenshotsByHash[item.hash] || '';
    });

    // const folder = this.getFolderName(
    //   request.createdBy as any as User,
    //   request.tenant as Tenant
    // );

    // const result: any = await ctx.call(
    //   'minio.uploadFile',
    //   {
    //     payload: pdf,
    //     folder,
    //     isPrivate: true,
    //     types: FILE_TYPES,
    //   },
    //   {
    //     meta: {
    //       mimetype: 'application/pdf',
    //       filename: `israsas-${request.id}.pdf`,
    //     },
    //   }
    // );

    // await ctx.call('requests.saveGeneratedPdf', {
    //   id,
    //   url: result.url,
    // });

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

    const objects: any[] = await this.getRequestData();

    const params = new URLSearchParams();

    function getUrl(params: URLSearchParams) {
      const mapHost = process.env.MAPS_HOST || 'https://maps.biip.lt';
      return `${mapHost}/uetk?${params.toString()}`;
    }

    // add all objects
    objects.forEach((item) => {
      params.set('item', `${item.id}`);
      data.push({
        url: getUrl(params),
        hash: item.hash,
      });
    });

    const childrenJobs = data.map((item) => ({
      params: item,
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

  @Method
  getFolderName(user?: User, tenant?: Tenant) {
    const tenantPath = tenant?.id || 'private';
    const userPath = user?.id || 'user';

    return `uploads/requests/${tenantPath}/${userPath}`;
  }

  @Method
  async getRequestData() {
    const objects = await getLakesAndPondsQuery({ limit: 5 });
    return objects.map((item) => ({
      ...item,
      hash: toMD5Hash(`item=${item.id}`),
    }));
  }
}
