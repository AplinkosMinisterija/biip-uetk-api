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
    },
    timeout: 0,
  })
  async saveScreenshot(
    ctx: Context<{
      url: string;
      hash: string;
      waitFor: string;
      data: { [key: string]: any };
    }>
  ) {
    const { url, hash, data, waitFor } = ctx.params;
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

    let screenshotUrl = await getHashedFileUrl();

    job.updateProgress(50);

    if (!screenshotUrl) {
      const screenshot = await ctx.call('tools.makeScreenshot', {
        url,
        waitFor,
        stream: true,
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

      screenshotUrl = await getHashedFileUrl();
      if (!screenshotUrl) {
        throw new Error('Screenshot is emtpy');
      }
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
