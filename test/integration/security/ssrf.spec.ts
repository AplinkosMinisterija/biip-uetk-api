'use strict';

import { assertSafeToolUrl } from '../../../services/tools.service';

describe('tools.assertSafeToolUrl — SSRF allowlist', () => {
  const allowedDevHost = 'localhost:3000';

  it('accepts URLs on the SERVER_HOST allowlist', () => {
    expect(() =>
      assertSafeToolUrl(`http://${allowedDevHost}/jobs/requests/1/html?secret=x`)
    ).not.toThrow();
  });

  it('accepts URLs on the MAPS_HOST allowlist', () => {
    expect(() => assertSafeToolUrl('https://maps.biip.lt/uetk')).not.toThrow();
  });

  it('rejects AWS / GCP metadata IPs', () => {
    expect(() =>
      assertSafeToolUrl('http://169.254.169.254/latest/meta-data/')
    ).toThrow(/Host not allowed/);
    expect(() =>
      assertSafeToolUrl('http://metadata.google.internal/computeMetadata/v1/')
    ).toThrow(/Host not allowed/);
  });

  it('rejects arbitrary external hosts', () => {
    expect(() => assertSafeToolUrl('https://attacker.com/foo')).toThrow(
      /Host not allowed/
    );
  });

  it('rejects non-http schemes', () => {
    expect(() => assertSafeToolUrl('file:///etc/passwd')).toThrow(/http/);
    expect(() => assertSafeToolUrl('gopher://internal/whatever')).toThrow(
      /http/
    );
  });

  it('rejects malformed URLs', () => {
    expect(() => assertSafeToolUrl('not-a-url')).toThrow(/Invalid URL/);
    expect(() => assertSafeToolUrl('')).toThrow();
  });
});
