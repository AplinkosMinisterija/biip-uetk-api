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

export function getObjectByCadastralId(
  id: string | number,
  fallbackItem?: object
) {
  const host = process.env.QGIS_SERVER_HOST || 'https://gis.biip.lt';
  const url = `${host}/qgisserver/uetk_zuvinimas?SERVICE=WFS&REQUEST=GetFeature&TYPENAME=uetk_zuvinimas_info&OUTPUTFORMAT=application/json&FILTER=%3CFilter%3E%3CPropertyIsEqualTo%3E%3CPropertyName%3Ecadastral_id%3C/PropertyName%3E%3CLiteral%3E${id}%3C/Literal%3E%3C/PropertyIsEqualTo%3E%3C/Filter%3E`;

  return fetch(url)
    .then((r) => r.json())
    .then((r) => r.features)
    .then((r) => {
      if (!r?.length && fallbackItem) {
        return [fallbackItem];
      }
      return r;
    });
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
