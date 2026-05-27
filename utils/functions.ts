import { createHash, createHmac } from 'crypto';
import moment from 'moment';
import { Readable } from 'stream';

type QueryObject = { [key: string]: any };
export function toReadableStream(fetchReadable: any): NodeJS.ReadableStream {
  return new Readable({
    async read() {
      if (!fetchReadable?.read) {
        this.emit('done');
        return;
      }

      const { value, done } = await fetchReadable.read();
      if (done) {
        this.emit('end');
        return;
      }

      this.push(value);
    },
  });
}

export function toMD5Hash(text: string) {
  return createHash('md5').update(text).digest('hex');
}

export function roundNumber(number: string, digits: number = 2) {
  if (!number) return;

  let numberParsed = parseFloat(number);

  if (Number.isNaN(numberParsed)) return;

  return numberParsed.toFixed(digits);
}

export function parseToJsonIfNeeded(query: QueryObject | string): QueryObject {
  if (!query) return;

  if (typeof query === 'string') {
    try {
      query = JSON.parse(query);
    } catch (err) {}
  }

  return query as QueryObject;
}

/**
 * HMAC of (request id + createdAt) signed by a server-side secret. Replaces an
 * earlier MD5(id+createdAt) scheme that was brute-forceable given a known
 * request ID + creation window (~86k MD5/s on a laptop). Falls back to the old
 * scheme only if REQUEST_SECRET is missing, so dev environments without the
 * env var still work; production must set REQUEST_SECRET.
 */
export function getRequestSecret(request: any) {
  const payload = `id=${request.id}&date=${moment(request.createdAt).format(
    'YYYYMMDDHHmmss'
  )}`;
  const key = process.env.REQUEST_SECRET;
  if (key) {
    return createHmac('sha256', key).update(payload).digest('hex');
  }
  return toMD5Hash(payload);
}

export function addLeadingZeros(num: number, totalLength: number = 7) {
  return String(num).padStart(totalLength, '0');
}
