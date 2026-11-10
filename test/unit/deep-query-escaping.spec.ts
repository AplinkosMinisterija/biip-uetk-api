import path from 'path';

// `@aplinkosministerija/moleculer-accounts` DeepQueryMixin turns client queries on
// `object`/`array` fields (e.g. `requests.objects`) into SQL with
// `mongo-query-to-postgres-jsonb` and passes the result to `whereRaw` without
// bindings. Versions before 0.2.18 do not escape values or keys in
// `pathToObjectHelper`, so this checks the version the mixin actually loads.

const accountsDir = path.dirname(
  require.resolve('@aplinkosministerija/moleculer-accounts/package.json')
);
const resolvedFromMixin = require.resolve('mongo-query-to-postgres-jsonb', {
  paths: [accountsDir],
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const convert = require(resolvedFromMixin);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require(path.join(
  path.dirname(resolvedFromMixin),
  'package.json'
));

/** SQL text with every '...' literal (incl. '' escapes) removed. */
function outsideLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

const MARKER = '7777';

describe('mongo-query-to-postgres-jsonb as used by DeepQueryMixin', () => {
  it('is a version that escapes values and keys (>= 0.2.18)', () => {
    const [major, minor, patch] = version.split('.').map(Number);
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(2018);
  });

  it('keeps ordinary queries unchanged', () => {
    expect(convert('objects_elem', { id: 5, type: 'RIVER' }, [])).toBe(
      `(objects_elem @> '{ "id": 5 }' and objects_elem @> '{ "type": "RIVER" }')`
    );
  });

  const payloads: Record<string, Record<string, unknown>> = {
    'quote in a value': { id: `x"}'::jsonb OR ${MARKER}=${MARKER} OR 'a'='a` },
    'value closing the EXISTS group': {
      id: `x"}'::jsonb) OR ${MARKER}=${MARKER} OR ('a'='a`,
    },
    'quote in a key': { [`type"}' OR ${MARKER}=${MARKER} --`]: 1 },
    'nested value': { a: { b: `'); select ${MARKER}; --` } },
  };

  for (const [name, query] of Object.entries(payloads)) {
    it(`keeps client input inside SQL literals: ${name}`, () => {
      const sql = convert('objects_elem', query, []);
      expect(sql).toContain(MARKER);
      expect(outsideLiterals(sql)).not.toContain(MARKER);
    });
  }
});
