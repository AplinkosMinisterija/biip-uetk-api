'use strict';

import { ServiceBroker } from 'moleculer';
import {
  buildBroker,
  runMigrations,
  seedBaseline,
  userMeta,
  adminMeta,
} from '../../helpers/broker';

describe('requests.getRequestGeom — no longer leaks geometry to anonymous callers', () => {
  let broker: ServiceBroker;
  let admin: any;
  let userA: any;
  let userB: any;
  let bRequestId: number;

  beforeAll(async () => {
    await runMigrations();
    broker = buildBroker();
    await broker.start();
    ({ admin, userA, userB } = await seedBaseline(broker));

    const bRecord: any = await broker.call(
      'requests.create',
      {
        purpose: 'OTHER',
        purposeValue: 'secret-geom-owner-b',
        objects: [{ id: '7', type: 'CADASTRAL_ID' }],
      },
      { meta: userMeta(userB) }
    );
    bRequestId = bRecord.id;
  }, 120000);

  afterAll(async () => {
    if (broker) await broker.stop();
  });

  it('returns empty geom when called with no user meta', async () => {
    // The action body does ctx.call('requests.resolve', { id, populate: 'geom',
    // throwIfNotExist: true }) — pre-fix the visibleToUser scope returned the
    // raw query when ctx.meta.user was missing, so an unauthenticated PUBLIC
    // alias leaked every request's geom. Post-fix the scope forces id=-1.
    await expect(
      broker.call('requests.getRequestGeom', { id: bRequestId })
    ).rejects.toThrow();
  });

  it("returns empty for user A trying to read user B's geom", async () => {
    await expect(
      broker.call(
        'requests.getRequestGeom',
        { id: bRequestId },
        { meta: userMeta(userA) }
      )
    ).rejects.toThrow();
  });

  it('returns the geom for the owner', async () => {
    const got: any = await broker.call(
      'requests.getRequestGeom',
      { id: bRequestId },
      { meta: userMeta(userB) }
    );
    // No geom was set on create, so we expect {} not an error.
    expect(got).toEqual({});
  });

  it('returns the geom for an admin', async () => {
    const got: any = await broker.call(
      'requests.getRequestGeom',
      { id: bRequestId },
      { meta: adminMeta(admin.id) }
    );
    expect(got).toEqual({});
  });
});
