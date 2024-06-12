import { createHash } from 'crypto';
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

export function getRequestSecret(request: any) {
  return toMD5Hash(
    `id=${request.id}&date=${moment(request.createdAt).format(
      'YYYYMMDDHHmmss'
    )}`
  );
}

export function addLeadingZeros(num: number, totalLength: number = 5) {
  return String(num).padStart(totalLength, '0');
}
