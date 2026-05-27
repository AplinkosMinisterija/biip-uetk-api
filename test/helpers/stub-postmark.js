'use strict';

// Stub used in tests via jest.config.js moduleNameMapper. Postmark ships as
// ESM-only since v4, which Jest 27 + ts-jest 27 (CommonJS) cannot parse. Mail
// flows aren't part of any security test, so we hand them a no-op client.

class ServerClient {
  constructor() {}
  sendEmailWithTemplate() {
    return Promise.resolve({});
  }
  sendEmail() {
    return Promise.resolve({});
  }
}

module.exports = { ServerClient };
module.exports.ServerClient = ServerClient;
module.exports.default = { ServerClient };
