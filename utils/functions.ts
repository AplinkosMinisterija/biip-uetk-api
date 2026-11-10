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

/**
 * Maps a stored file URL (e.g. `requests.generatedFile`, saved as
 * `<SERVER_HOST>/minio/<bucket>/<object>` - older rows may carry another host
 * of this API) to this API's own file proxy: only the part after `/minio/` is
 * kept and the host is always `serverHost`. Returns undefined when there is no
 * `/minio/` part or the object path tries to leave it. The public download
 * endpoint therefore can never be pointed at another address.
 */
export function toOwnFileUrl(
  url: string,
  serverHost?: string
): string | undefined {
  if (!url || !serverHost) return undefined;
  let source: URL;
  let base: URL;
  try {
    source = new URL(url);
    base = new URL(serverHost);
  } catch (err) {
    return undefined;
  }
  if (!['http:', 'https:'].includes(source.protocol)) return undefined;

  const marker = '/minio/';
  const at = source.pathname.indexOf(marker);
  if (at < 0) return undefined;
  const objectPath = source.pathname.slice(at + marker.length);
  if (!objectPath) return undefined;

  const prefix = `${base.pathname.replace(/\/+$/, '')}${marker}`;
  const target = new URL(`${prefix}${objectPath}`, base.origin);
  // URL parsing resolves `..` and `%2e%2e`; the result must stay under /minio/.
  if (target.origin !== base.origin || !target.pathname.startsWith(prefix)) {
    return undefined;
  }
  target.search = source.search;
  return target.toString();
}

/**
 * ASCII file name safe for a quoted `Content-Disposition` value: Node rejects
 * header values with non-Latin-1 characters, and `"`, `\\`, CR and LF would
 * break the header.
 */
export function safeFileName(name: string): string {
  return (name || 'file').replace(/[^\x20-\x7e]|["\\]/g, '_');
}

/**
 * `Content-Disposition: attachment` with an ASCII fallback and the original
 * (UTF-8) name in `filename*`, so names like `Išrašas.pdf` keep their letters.
 */
export function attachmentHeader(name: string): string {
  const original = name || 'file';
  return `attachment; filename="${safeFileName(
    original
  )}"; filename*=UTF-8''${encodeURIComponent(original).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )}`;
}

/**
 * Builds a case-insensitive "contains" condition over several columns as a
 * parameterized `$raw` for `@moleculer/database`. Column names go in as
 * identifier bindings (`??`) and the search text as a value binding (`?`), so
 * nothing from the client is written into the SQL text. LIKE wildcards in the
 * search text are escaped, so it matches literally.
 */
export function buildSearchCondition(columns: string[], search: string) {
  const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  return {
    condition: `(${columns.map(() => '?? ILIKE ?').join(' OR ')})`,
    bindings: columns.flatMap((column) => [column, pattern]),
  };
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
