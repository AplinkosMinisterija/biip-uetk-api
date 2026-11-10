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

export function addLeadingZeros(num: number, totalLength: number = 7) {
  return String(num).padStart(totalLength, '0');
}

const RAW_KEY = '$raw';

/**
 * Removes every `$raw` key at any depth of an object or array.
 *
 * `@moleculer/database` passes a `$raw` value from a `query` straight to knex
 * `whereRaw`, so a `$raw` must only ever be built by server code, never come
 * from a client.
 */
export function stripRawDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripRawDeep) as unknown as T;
  if (value && typeof value === 'object') {
    const out: QueryObject = {};
    for (const key of Object.keys(value)) {
      if (key === RAW_KEY) continue;
      out[key] = stripRawDeep((value as QueryObject)[key]);
    }
    return out as T;
  }
  return value;
}

// Keys never copied from client params: `$raw` reaches SQL, the others can
// replace an object's prototype when params are merged with Object.assign.
const DROPPED_KEYS = new Set([
  RAW_KEY,
  '__proto__',
  'constructor',
  'prototype',
]);

// How many times a JSON string is decoded when looking for an object inside.
// Downstream code may JSON.parse a value more than once (parseToJsonIfNeeded,
// then @moleculer/database sanitizeParams), so a double-encoded query must be
// unwrapped here too.
const MAX_JSON_DEPTH = 5;

function isOpaqueObject(value: any): boolean {
  return (
    Buffer.isBuffer(value) ||
    value instanceof Date ||
    ArrayBuffer.isView(value) ||
    typeof value.pipe === 'function'
  );
}

function decodeJsonObject(value: string): object | undefined {
  let current: any = value;
  for (let i = 0; i < MAX_JSON_DEPTH; i++) {
    if (typeof current !== 'string') break;
    const trimmed = current.trim();
    if (!/^[{["]/.test(trimmed)) return undefined;
    try {
      current = JSON.parse(trimmed);
    } catch (err) {
      return undefined;
    }
  }
  return current && typeof current === 'object' ? current : undefined;
}

/**
 * Sanitizes request parameters coming from HTTP clients: removes `$raw` (and
 * prototype-changing keys) at any depth, also inside values sent as JSON
 * strings, including double-encoded ones (e.g. `?query={"$raw":"..."}`, which
 * actions later parse). Escaped keys such as `"$raw"` are caught because
 * the string is decoded, not searched. A string is replaced only when something
 * was removed, so all other values keep their type and exact form.
 *
 * Every object is rebuilt from its own keys, whatever its prototype: a
 * `__proto__` key in a JSON body can change the prototype of the merged params
 * object, and that must not let it skip sanitizing.
 */
export function sanitizeClientParams<T>(value: T): T {
  if (typeof value === 'string') {
    const decoded = decodeJsonObject(value);
    if (!decoded) return value;

    const cleaned = sanitizeClientParams(decoded);
    return (JSON.stringify(cleaned) === JSON.stringify(decoded)
      ? value
      : JSON.stringify(cleaned)) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeClientParams) as unknown as T;
  }

  if (value && typeof value === 'object') {
    if (isOpaqueObject(value)) return value;

    const out: QueryObject = {};
    for (const key of Object.keys(value)) {
      if (DROPPED_KEYS.has(key)) continue;
      out[key] = sanitizeClientParams((value as QueryObject)[key]);
    }
    return out as T;
  }

  return value;
}
