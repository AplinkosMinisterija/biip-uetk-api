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
import { Form } from './forms.service';
import { Tenant } from './tenants.service';
import { User } from './users.service';

@Service({
  name: 'jobs.forms',
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
export default class JobsFormsService extends moleculer.Service {
  @Action({
    queue: true,
    params: { id: 'number' },
    timeout: 0,
  })
  async generateAndSavePdf(ctx: Context<{ id: number }>) {
    const { id } = ctx.params;
    const { job } = ctx.locals;

    const form: Form = await ctx.call('forms.resolve', {
      id,
      populate: 'createdBy,tenant',
    });

    const childrenValues = await job.getChildrenValues();
    const screenshotsByHash: any = Object.values(childrenValues).reduce(
      (acc: any, item: any) => ({ ...acc, [item.hash]: item.url }),
      {}
    );

    const screenshotsHash = toMD5Hash(
      `id=${id}&date=${moment().format('YYYYMMDDHHmmsss')}`
    );
    await this.broker.cacher.set(
      `screenshots.${screenshotsHash}`,
      screenshotsByHash
    );

    const secret = getRequestSecret(form);

    const footerHtml = getTemplateHtml('footer.ejs', {
      id: addLeadingZeros(id),
      date: moment(form.createdAt).format('YYYY-MM-DD'),
    });

    const pdf = await ctx.call('tools.makePdf', {
      url: `${process.env.SERVER_HOST}/jobs/forms/${id}/html?secret=${secret}&skey=${screenshotsHash}`,
      footer: footerHtml,
    });

    const folder = this.getFolderName(
      form?.createdBy as any as User,
      form?.tenant as Tenant
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
          filename: `israsas-forma-${form.id}.pdf`,
        },
      }
    );

    await ctx.call('forms.saveGeneratedPdf', { id, url: result.url });

    return { job: job.id };
  }

  @Action({
    params: { id: 'number' },
    timeout: 0,
  })
  async initiatePdfGenerate(ctx: Context<{ id: number }>) {
    const { id } = ctx.params;

    const objects: any[] = await this.getFormObjectData(id);
    if (!objects.length) return { job: null };

    const params = new URLSearchParams({ screenshot: '1', preview: '1' });

    function getUrl(p: URLSearchParams) {
      const mapHost = process.env.MAPS_HOST || 'https://maps.biip.lt';
      return `${mapHost}/uetk?${p.toString()}`;
    }

    const data = objects.map((item) => {
      params.set('cadastralId', `${item.id}`);
      return { url: getUrl(params), hash: item.hash };
    });

    const childrenJobs = data.map((item) => ({
      params: { ...item, waitFor: '#image-canvas-0' },
      name: 'jobs',
      action: 'saveScreenshot',
    }));

    return this.flow(
      ctx,
      'jobs.forms',
      'generateAndSavePdf',
      { id },
      childrenJobs
    );
  }

  @Action({
    params: {
      id: { type: 'number', convert: true },
      secret: 'string',
      skey: { type: 'string', optional: true },
    },
    rest: 'GET /:id/html',
    timeout: 0,
    auth: AuthType.PUBLIC,
  })
  async getFormHtml(
    ctx: Context<
      { id: number; secret: string; skey: string },
      { $responseType: string }
    >
  ) {
    const { id, secret, skey: screenshotsRedisKey } = ctx.params;

    const form: Form = await ctx.call('forms.resolve', {
      id,
      throwIfNotExist: true,
    });

    const secretToApprove = getRequestSecret(form);
    if (!form?.id || !secret || secret !== secretToApprove) {
      return throwNotFoundError('Invalid secret!');
    }

    const objects: any[] = await this.getFormObjectData(id);

    let screenshotsByHash: any = {};
    if (screenshotsRedisKey) {
      screenshotsByHash = await this.broker.cacher.get(
        `screenshots.${screenshotsRedisKey}`
      );
    }

    ctx.meta.$responseType = 'text/html';

    return getTemplateHtml('request.ejs', {
      id: addLeadingZeros(id),
      date: form.createdAt,
      objects: objects.map((o) => ({
        ...o,
        screenshot: screenshotsByHash?.[o.hash] || '',
      })),
      formatDate: (date: string, format = 'YYYY-MM-DD') => {
        if (!date?.toString()?.trim()) return;
        const m = moment(date);
        if (!m.isValid()) return;
        return m.format(format);
      },
      roundNumber,
      trimValue: (value?: string) => (!value ? '' : value?.trim()),
      fullData: false,
    });
  }

  @Method
  getFolderName(user?: User, tenant?: Tenant) {
    const tenantPath = tenant?.id || 'private';
    const userPath = user?.id || 'user';

    return `uploads/forms/${tenantPath}/${userPath}`;
  }

  @Method
  async getFormObjectData(id: number) {
    const form: Form = await this.broker.call('forms.resolve', { id });

    if (!form?.cadastralId) return [];

    const items: any[] = await this.broker.call('objects.find', {
      query: { cadastralId: { $in: [form.cadastralId] } },
      populate: 'extendedData',
    });

    return items.map((item) => ({
      ...item,
      screenshot: '',
      id: item.cadastralId,
      hash: toMD5Hash(`cadastralId=${item.cadastralId}`),
    }));
  }
}
