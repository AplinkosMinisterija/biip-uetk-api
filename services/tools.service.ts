'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';

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
    },
    timeout: 0,
  })
  async makeScreenshot(
    ctx: Context<{ url: string; stream: boolean; encoding: string }>
  ) {
    const { url, stream, encoding } = ctx.params;
    const searchParams = new URLSearchParams({
      quality: '75',
      url: url,
      type: 'jpeg',
      encoding,
    });

    const screenshotEndpoint = `${this.toolsHost()}/screenshot`;
    console.log(`${screenshotEndpoint}?${searchParams.toString()}`)
    return new Promise(async (resolve, reject) => {
      fetch(`${screenshotEndpoint}?${searchParams.toString()}`)
          .then((r) => (stream ? r.body?.getReader() : (r.text() as any)))
          .then(resolve)
          .catch(err => reject(err?.message || 'Error while getting screenshot'));
    });
  }

  @Method
  toolsHost() {
    return process.env.TOOLS_HOST || `https://internalapi.biip.lt/tools`;
  }
}
