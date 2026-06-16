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
      width: {
        type: 'number',
        convert: true,
        optional: true,
      },
      height: {
        type: 'number',
        convert: true,
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
      width?: number;
      height?: number;
    }>
  ) {
    const { url, stream, encoding, waitFor, width, height } = ctx.params;
    const searchParams = new URLSearchParams({
      quality: '75',
      url: url,
      type: 'jpeg',
      encoding,
    });

    // Only override the upstream biip-tools default viewport (1280x720) when
    // the caller explicitly asks. The extract-PDF flow passes its own larger
    // dimensions from jobs.requests.initiatePdfGenerate; everything else gets
    // the unchanged default.
    if (typeof width === 'number') searchParams.set('width', String(width));
    if (typeof height === 'number') searchParams.set('height', String(height));

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
      landscape: {
        type: 'boolean',
        optional: true,
        convert: true,
      },
    },
    timeout: 0,
  })
  async makePdf(
    ctx: Context<{
      url: string;
      header?: string;
      footer?: string;
      landscape?: boolean;
    }>
  ) {
    const { url, footer, header, landscape } = ctx.params;

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
          ...(typeof landscape === 'boolean' ? { landscape } : {}),
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
    // Either `geojson` (single-layer, legacy) or `layers` (multi-layer —
    // required when bundling Point + LineString + Polygon objects together,
    // since OpenFileGDB allows only one geometry type per layer). The
    // upstream biip-tools /gdb endpoint accepts both shapes and validates
    // that exactly one was provided.
    params: {
      geojson: { type: 'object', optional: true },
      layers: {
        type: 'array',
        optional: true,
        items: {
          type: 'object',
          props: { name: 'string', geojson: 'object' },
        },
      },
      name: { type: 'string', optional: true },
      srid: { type: 'number', optional: true, convert: true },
    },
    timeout: 0,
  })
  async makeGdb(
    ctx: Context<{
      geojson?: any;
      layers?: Array<{ name: string; geojson: any }>;
      name?: string;
      srid?: number;
    }>
  ): Promise<NodeJS.ReadableStream> {
    const { geojson, layers, name, srid } = ctx.params;
    const gdbEndpoint = `${this.toolsHost()}/gdb`;

    const response = await fetch(gdbEndpoint, {
      method: 'POST',
      body: JSON.stringify({
        ...(layers ? { layers } : { geojson }),
        srid: srid ?? 3346,
        ...(name ? { name } : {}),
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `tools /gdb returned ${response.status}: ${detail || '<empty body>'}`
      );
    }

    // Stream the response body straight to the consumer (MinIO upload) so we
    // never buffer the entire ZIP in memory — per-request RSS otherwise
    // spikes proportional to the GDB archive size.
    return toReadableStream(response.body?.getReader());
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
