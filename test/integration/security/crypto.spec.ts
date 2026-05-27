'use strict';

import { createHmac } from 'crypto';
import moment from 'moment';
import { getRequestSecret } from '../../../utils/functions';

describe('getRequestSecret (HMAC mode)', () => {
  const createdAt = '2026-05-27T12:00:00.000Z';
  const request = { id: 42, createdAt };

  it('returns an HMAC-SHA256 hex digest when REQUEST_SECRET is set', () => {
    const got = getRequestSecret(request);
    expect(got).toMatch(/^[a-f0-9]{64}$/);

    const payload = `id=${request.id}&date=${moment(createdAt).format(
      'YYYYMMDDHHmmss'
    )}`;
    const expected = createHmac('sha256', process.env.REQUEST_SECRET as string)
      .update(payload)
      .digest('hex');
    expect(got).toBe(expected);
  });

  it('changes when REQUEST_SECRET changes — defeats the prior brute force', () => {
    const original = process.env.REQUEST_SECRET;
    const a = getRequestSecret(request);
    process.env.REQUEST_SECRET = `${original}-rotated`;
    const b = getRequestSecret(request);
    process.env.REQUEST_SECRET = original;
    expect(a).not.toBe(b);
  });

  it('falls back to MD5 only when REQUEST_SECRET is unset (dev convenience)', () => {
    const original = process.env.REQUEST_SECRET;
    delete process.env.REQUEST_SECRET;
    try {
      const got = getRequestSecret(request);
      // MD5 is 32 hex chars; the HMAC mode returns 64.
      expect(got).toMatch(/^[a-f0-9]{32}$/);
    } finally {
      if (original !== undefined) process.env.REQUEST_SECRET = original;
    }
  });
});
