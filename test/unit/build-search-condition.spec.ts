import knex from 'knex';
import { buildSearchCondition } from '../../utils/functions';

const db = knex({ client: 'pg' });

function sqlFor(columns: string[], search: string) {
  const { condition, bindings } = buildSearchCondition(columns, search);
  return db('objects').where('category', 'RIVER').whereRaw(condition, bindings);
}

describe('buildSearchCondition', () => {
  it('builds a parameterized OR condition over the columns', () => {
    const { condition, bindings } = buildSearchCondition(
      ['name', 'cadastral_id'],
      'Neris'
    );
    expect(condition).toBe('(?? ILIKE ? OR ?? ILIKE ?)');
    expect(bindings).toEqual(['name', '%Neris%', 'cadastral_id', '%Neris%']);
  });

  it('keeps quotes from the search text inside the value binding', () => {
    const query = sqlFor(['name'], "x'OR'1'='1");
    const native = query.toSQL().toNative();
    expect(native.sql).toBe(
      'select * from "objects" where "category" = $1 and ("name" ILIKE $2)'
    );
    expect(native.bindings).toEqual(['RIVER', "%x'OR'1'='1%"]);
  });

  it('escapes LIKE wildcards so the text matches literally', () => {
    const { bindings } = buildSearchCondition(['name'], 'a_b\\c');
    expect(bindings[1]).toBe('%a\\_b\\\\c%');
  });

  it('quotes column names as identifiers', () => {
    const native = sqlFor(['name"; drop table x; --'], 'a').toSQL().toNative();
    expect(native.sql).toContain('"name""; drop table x; --" ILIKE $2');
  });

  it('wraps the OR group so it does not break other conditions', () => {
    const native = sqlFor(['name', 'cadastral_id'], 'a').toSQL().toNative();
    expect(native.sql).toContain(
      'where "category" = $1 and ("name" ILIKE $2 OR "cadastral_id" ILIKE $3)'
    );
  });
});
