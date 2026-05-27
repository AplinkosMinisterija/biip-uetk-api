'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import { toReadableStream } from '../utils';
import { throwBadRequestError } from '../types';
import { AuthType } from './api.service';

// Hosts the tools service is allowed to fetch on behalf of a caller. Anything
// outside this set is rejected before we hand the URL to the screenshot/PDF
// renderer — without it `tools.download` (PUBLIC) and `tools.makeScreenshot`
// were a general-purpose SSRF reflector pointed at internal IPs.
function allowedToolHosts(): Set<string> {
  const hosts = new Set<string>();
  const candidates = [
    process.env.MAPS_HOST,
    process.env.SERVER_HOST,
    process.env.APP_HOST,
    process.env.QGIS_SERVER_HOST,
    process.env.TOOLS_ALLOWED_HOSTS, // comma-separated extra allowlist
  ].filter(Boolean) as string[];

  for (const raw of candidates) {
    for (const entry of raw.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      try {
        const u = new URL(trimmed);
        hosts.add(u.host.toLowerCase());
      } catch {
        hosts.add(trimmed.toLowerCase());
      }
    }
  }

  return hosts;
}

function assertSafeToolUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throwBadRequestError('Invalid URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throwBadRequestError('Only http(s) URLs are allowed');
  }

  const hosts = allowedToolHosts();
  if (hosts.size === 0) {
    // No allowlist configured — fail closed in production, allow in dev so
    // local testing isn't blocked.
    if (process.env.NODE_ENV === 'production') {
      throwBadRequestError('Tools allowlist not configured');
    }
    return parsed;
  }

  if (!hosts.has(parsed.host.toLowerCase())) {
    throwBadRequestError(`Host not allowed: ${parsed.host}`);
  }

  return parsed;
}

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
    assertSafeToolUrl(url);
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
    assertSafeToolUrl(url);

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
    assertSafeToolUrl(url);

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
