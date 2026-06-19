'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Service } from 'moleculer-decorators';
import BullMqMixin from '../mixins/bullmq.mixin';
import { toReadableStream } from '../utils';
import moment from 'moment';

@Service({
  name: 'jobs',
  mixins: [BullMqMixin],
  settings: {
    bullmq: {
      // Serialize screenshot jobs (1, not 5) because multi-object request
      // extracts were rendering duplicated map labels — same WMS basin /
      // cadastral labels appearing twice, slightly offset. Upstream
      // biip-tools /screenshot is a thin proxy to the Chrome API
      // (CHROME_API_ENDPOINT), and parallel calls into that service
      // bleed OpenLayers ImageWMS tile state across pooled puppeteer
      // pages. Sequential screenshots eliminate the overlap. Bump back
      // up once the Chrome service is fixed to isolate page contexts.
      worker: { concurrency: 1 },
      job: {
        attempts: 10,
        backoff: 1000,
        failParentOnFailure: true,
      },
    },
  },
})
export default class JobsService extends moleculer.Service {
  @Action({
    queue: true,
    params: {
      url: 'string',
      hash: 'string',
      data: {
        type: 'object',
        optional: true,
      },
      waitFor: {
        type: 'string',
        optional: true,
      },
      width: {
        type: 'number',
        optional: true,
        convert: true,
      },
      height: {
        type: 'number',
        optional: true,
        convert: true,
      },
    },
    timeout: 0,
  })
  async saveScreenshot(
    ctx: Context<{
      url: string;
      hash: string;
      waitFor: string;
      data: { [key: string]: any };
      width?: number;
      height?: number;
    }>
  ) {
    const { url, hash, data, waitFor, width, height } = ctx.params;
    const { job } = ctx.locals;

    const folder = 'temp/screenshots';

    async function getHashedFileUrl() {
      if (!hash) return;

      const objectName = `${folder}/${hash}.jpeg`;
      const fileData: any = await ctx.call('minio.fileStat', {
        objectName,
      });

      if (!fileData?.exists) return;

      const uploadedBeforeDays = moment().diff(
        moment(fileData.lastModified),
        'days'
      );

      if (uploadedBeforeDays > 5) return;

      return fileData.presignedUrl;
    }

    job.updateProgress(50);

    const screenshot = await ctx.call('tools.makeScreenshot', {
      url,
      waitFor,
      stream: true,
      ...(typeof width === 'number' ? { width } : {}),
      ...(typeof height === 'number' ? { height } : {}),
    });

    await ctx.call(
      'minio.uploadFile',
      {
        payload: toReadableStream(screenshot),
        folder,
        name: hash,
        isPrivate: true,
      },
      {
        meta: {
          mimetype: 'image/jpeg',
          filename: 'screenshot.jpeg',
        },
      }
    );

    const screenshotUrl = await getHashedFileUrl();
    if (!screenshotUrl) {
      throw new Error('Screenshot is emtpy');
    }

    job.updateProgress(100);

    return {
      job: job.id,
      url: screenshotUrl || '',
      hash,
      data: data || {},
    };
  }
}
