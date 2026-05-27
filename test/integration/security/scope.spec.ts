'use strict';

import { ServiceBroker } from 'moleculer';
import {
  buildBroker,
  runMigrations,
  seedBaseline,
  userMeta,
  adminMeta,
} from '../../helpers/broker';

describe('visibleToUser scope: deny-by-default for unauthenticated callers', () => {
  let broker: ServiceBroker;
  let userA: any;
  let userB: any;
  let admin: any;

  beforeAll(async () => {
    await runMigrations();
    broker = buildBroker();
    await broker.start();
    ({ admin, userA, userB } = await seedBaseline(broker));

    // Seed one request per user so the scope has something to filter.
    await broker.call(
      'requests.create',
      {
        purpose: 'OTHER',
        purposeValue: 'a',
        objects: [{ id: '1', type: 'CADASTRAL_ID' }],
      },
      { meta: userMeta(userA) }
    );
    await broker.call(
      'requests.create',
      {
        purpose: 'OTHER',
        purposeValue: 'b',
        objects: [{ id: '2', type: 'CADASTRAL_ID' }],
      },
      { meta: userMeta(userB) }
    );
  }, 120000);

  afterAll(async () => {
    if (broker) await broker.stop();
  });

  it('returns nothing for an unauthenticated caller', async () => {
    // No user in meta at all — pre-fix the scope returned the unmodified
    // query, leaking every record to any internal ctx.call from a PUBLIC
    // action.
    const list: any = await broker.call('requests.list', { pageSize: 100 });
    expect(list.total).toBe(0);
    expect(list.rows).toEqual([]);
  });

  it("scopes a USER to their own records only", async () => {
    const list: any = await broker.call(
      'requests.list',
      { pageSize: 100 },
      { meta: userMeta(userA) }
    );
    expect(list.total).toBe(1);
    expect(list.rows[0].createdBy).toBe(userA.id);
  });

  it('lets an admin see everyone', async () => {
    const list: any = await broker.call(
      'requests.list',
      { pageSize: 100 },
      { meta: adminMeta(admin.id) }
    );
    expect(list.total).toBeGreaterThanOrEqual(2);
  });

  it("denies an unauthenticated caller a direct resolve by id", async () => {
    // Pick userB's record by id
    const all: any = await broker.call(
      'requests.list',
      { pageSize: 100 },
      { meta: adminMeta(admin.id) }
    );
    const bRecord = all.rows.find((r: any) => r.createdBy === userB.id);
    expect(bRecord).toBeTruthy();

    const resolved = await broker.call('requests.resolve', { id: bRecord.id });
    // pre-fix: returned the full record; post-fix: scope forces id=-1 so the
    // resolve returns nothing.
    expect(resolved).toBeFalsy();
  });

  it("denies user A from reading user B's request even by id", async () => {
    const all: any = await broker.call(
      'requests.list',
      { pageSize: 100 },
      { meta: adminMeta(admin.id) }
    );
    const bRecord = all.rows.find((r: any) => r.createdBy === userB.id);
    const resolvedAsA = await broker.call(
      'requests.resolve',
      { id: bRecord.id },
      { meta: userMeta(userA) }
    );
    expect(resolvedAsA).toBeFalsy();
  });
});
