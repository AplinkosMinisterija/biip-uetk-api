import { createHash } from 'crypto';
import { Readable } from 'stream';

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
  return fetch(
    `https://dev.qgis.biip.lt/qgisserver/uetk_zuvinimas?SERVICE=WFS&REQUEST=GetFeature&TYPENAME=uetk_zuvinimas_info&OUTPUTFORMAT=application/json&FILTER=%3CFilter%3E%3CPropertyIsEqualTo%3E%3CPropertyName%3Ecadastral_id%3C/PropertyName%3E%3CLiteral%3E${id}%3C/Literal%3E%3C/PropertyIsEqualTo%3E%3C/Filter%3E`
  )
    .then((r) => r.json())
    .then((r) => r.features)
    .then((r) => {
      if (!r?.length && fallbackItem) {
        return [fallbackItem];
      }
      return r;
    });
}
