'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import { toReadableStream } from '../utils';
import { AuthType } from './api.service';

@Service({
  name: 'tools',
})
export default class ToolsService extends moleculer.Service {
  @Action({
    params: {
      url: 'string',
      stream: {
        type: 'boolean',
        default: false,
      },
      encoding: {
        type: 'string',
        enum: ['binary', 'base64'],
        default: 'binary',
      },
      waitFor: {
        type: 'string',
        optional: true,
      },
    },
    timeout: 0,
  })
  async makeScreenshot(
    ctx: Context<{
      url: string;
      stream: boolean;
      encoding: string;
      waitFor: string;
    }>
  ) {
    const { url, stream, encoding, waitFor } = ctx.params;
    const searchParams = new URLSearchParams({
      quality: '75',
      url: url,
      type: 'jpeg',
      encoding,
    });

    if (waitFor) {
      searchParams.set('waitFor', waitFor);
    }

    const screenshotEndpoint = `${this.toolsHost()}/screenshot`;

    return new Promise(async (resolve, reject) => {
      fetch(`${screenshotEndpoint}?${searchParams.toString()}`)
        .then((r) => (stream ? r.body?.getReader() : (r.text() as any)))
        .then(resolve)
        .catch((err) =>
          reject(err?.message || 'Error while getting screenshot')
        );
    });
  }

  @Action({
    params: {
      url: 'string',
      footer: {
        type: 'string',
        optional: true,
      },
      header: {
        type: 'string',
        optional: true,
      },
    },
    timeout: 0,
  })
  async makePdf(
    ctx: Context<{ url: string; header?: string; footer?: string }>
  ) {
    const { url, footer, header } = ctx.params;

    const pdfEndpoint = `${this.toolsHost()}/pdf`;

    return new Promise(async (resolve, reject) => {
      fetch(pdfEndpoint, {
        method: 'POST',
        body: JSON.stringify({
          url,
          height: 877,
          width: 620,
          footer,
          header,
          margin: {
            top: 50,
            bottom: 50,
            left: 50,
            right: 50,
          },
        }),
        headers: {
          'Content-Type': 'application/json',
        },
      })
        .then((r) => r.body?.getReader())
        .then(resolve)
        .catch((err) => {
          console.error(err);
          reject(err?.message || 'Error while getting pdf');
        });
    });
  }

  @Action({
    params: {
      url: 'string',
      name: 'string',
    },
    rest: 'GET /download',
    auth: AuthType.PUBLIC,
    timeout: 0,
  })
  async download(
    ctx: Context<
      { url: string; name: string },
      { $responseType: string; $statusCode: number; $responseHeaders: any }
    >
  ) {
    const { url, name } = ctx.params;

    const downloadEndpoint = `${this.toolsHost()}/download`;

    const query = new URLSearchParams({ name, url }).toString();
    return new Promise(async (resolve, reject) => {
      fetch(`${downloadEndpoint}?${query}`, { method: 'GET' })
        .then((response) => {
          ctx.meta.$responseType = response.headers.get('Content-Type');
          ctx.meta.$statusCode = response.status;
          ctx.meta.$responseHeaders = {
            'Content-Disposition': `attachment; filename="${name}"`,
          };
          return response;
        })
        .then((r) => toReadableStream(r.body?.getReader()))
        .then(resolve)
        .catch((err) => {
          console.error(err);
          reject(err?.message || 'Error while downloading');
        });
    });
  }

  @Method
  toolsHost() {
    return process.env.TOOLS_HOST || `https://internalapi.biip.lt/tools`;
  }
}
