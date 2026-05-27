'use strict';

import { ServiceBroker } from 'moleculer';
import {
  buildBroker,
  runMigrations,
  seedBaseline,
  userMeta,
  adminMeta,
  tenantMeta,
} from '../../helpers/broker';

describe('IDOR write-side defenses', () => {
  let broker: ServiceBroker;
  let admin: any;
  let userA: any;
  let userB: any;
  let tenant: any;

  beforeAll(async () => {
    await runMigrations();
    broker = buildBroker();
    await broker.start();
    ({ admin, userA, userB, tenant } = await seedBaseline(broker));
  }, 120000);

  afterAll(async () => {
    if (broker) await broker.stop();
  });

  describe('requests.generatedFile', () => {
    it("blocks a regular user from setting generatedFile on create", async () => {
      const malicious =
        `http://localhost:3000/minio/uetk-test/uploads/requests/private/${userB.id}/victim.pdf`;

      const created: any = await broker.call(
        'requests.create',
        {
          purpose: 'OTHER',
          purposeValue: 'idor',
          objects: [{ id: '12345', type: 'CADASTRAL_ID' }],
          generatedFile: malicious,
        },
        { meta: userMeta(userA) }
      );

      expect(created).toBeTruthy();
      expect(created.id).toBeGreaterThan(0);
      expect(created.generatedFile).toBeFalsy();
    });

    it("blocks a regular user from updating generatedFile on their own request", async () => {
      // Pre-seed a request as the user normally would
      const own: any = await broker.call(
        'requests.create',
        {
          purpose: 'OTHER',
          purposeValue: 'baseline',
          objects: [{ id: '99', type: 'CADASTRAL_ID' }],
        },
        { meta: userMeta(userA) }
      );
      expect(own.generatedFile).toBeFalsy();

      const victimUrl =
        `http://localhost:3000/minio/uetk-test/uploads/requests/private/${userB.id}/v.pdf`;

      // Direct call to updateEntity-equivalent: requests.update on own id.
      // We bypass the validateStatusChange edge case (which forces status=SUBMITTED
      // and rejects edits on CREATED) by NOT providing an id in params — instead
      // call the underlying database update via a known status (RETURNED is
      // editable). To keep things action-level we use updateEntity directly.
      await broker.call(
        '$node.actions',
        {},
        { meta: userMeta(userA) }
      ); // sanity that broker is alive

      // Force the request to RETURNED status as admin so the user can edit it
      await broker.call(
        'requests.update',
        { id: own.id, status: 'RETURNED' },
        { meta: adminMeta(admin.id) }
      );

      // Now user updates with a malicious generatedFile in payload
      const updated: any = await broker.call(
        'requests.update',
        {
          id: own.id,
          generatedFile: victimUrl,
          status: 'SUBMITTED', // user's allowed transition out of RETURNED
        },
        { meta: userMeta(userA) }
      );

      expect(updated.id).toBe(own.id);
      // The set hook returned entity?.generatedFile (was undefined before),
      // so the malicious URL never lands in storage.
      expect(updated.generatedFile).toBeFalsy();
    });

    it("allows system context (no user meta) to set generatedFile via saveGeneratedPdf", async () => {
      const own: any = await broker.call(
        'requests.create',
        {
          purpose: 'OTHER',
          purposeValue: 'system test',
          objects: [{ id: '77', type: 'CADASTRAL_ID' }],
        },
        { meta: userMeta(userA) }
      );

      // This is the real prod path: jobs.requests.generateAndSavePdf calls
      // requests.saveGeneratedPdf in a background worker context with empty
      // ctx.meta. saveGeneratedPdf passes scope: 'notDeleted' so visibleToUser
      // deny-by-default doesn't block its own job.
      const systemUrl =
        `http://localhost:3000/minio/uetk-test/uploads/requests/private/${userA.id}/job.pdf`;
      await broker.call('requests.saveGeneratedPdf', {
        id: own.id,
        url: systemUrl,
      });

      // Verify via admin read since the user's visibleToUser scope sees only
      // their own records — admin sees everyone.
      const reread: any = await broker.call(
        'requests.resolve',
        { id: own.id },
        { meta: adminMeta(admin.id) }
      );
      expect(reread.generatedFile).toContain('/uploads/requests/private/');
    });

    it("allows admin to set generatedFile via an APPROVE transition", async () => {
      const own: any = await broker.call(
        'requests.create',
        {
          purpose: 'OTHER',
          purposeValue: 'admin test',
          objects: [{ id: '55', type: 'CADASTRAL_ID' }],
        },
        { meta: userMeta(userA) }
      );

      const adminUrl =
        `http://localhost:3000/minio/uetk-test/uploads/requests/private/${userA.id}/admin.pdf`;
      const updated: any = await broker.call(
        'requests.update',
        { id: own.id, generatedFile: adminUrl, status: 'APPROVED' },
        { meta: adminMeta(admin.id) }
      );

      // Admin set is allowed; the stub minio.signStoredUrl appends a fake
      // X-Amz-Signature=... so the substring containing the original path is
      // enough to confirm the field was written.
      expect(updated.generatedFile).toContain('admin.pdf');
    });
  });

  describe('forms.files filter', () => {
    it('drops files[].url entries that point outside the caller folder', async () => {
      const ownUrl =
        `http://localhost:3000/minio/uetk-test/uploads/forms/private/${userA.id}/own.pdf`;
      const victimUrl =
        `http://localhost:3000/minio/uetk-test/uploads/forms/private/${userB.id}/victim.pdf`;
      const externalUrl = 'https://external.com/anything.pdf';

      const form: any = await broker.call(
        'forms.create',
        {
          type: 'NEW',
          objectType: 'POND',
          objectName: 'IDOR forms test',
          providerType: 'OWNER',
          description: 'x',
          geom: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [500000, 6000000] },
                properties: {},
              },
            ],
          },
          files: [
            { url: ownUrl, filename: 'own.pdf' },
            { url: victimUrl, filename: 'stolen.pdf' },
            { url: externalUrl, filename: 'ext.pdf' },
          ],
        },
        { meta: userMeta(userA) }
      );

      expect(form.id).toBeGreaterThan(0);
      const urls = (form.files || []).map((f: any) => f.url);
      expect(urls.some((u: string) => u.includes('own.pdf'))).toBe(true);
      expect(urls.some((u: string) => u.includes('anything.pdf'))).toBe(true);
      expect(urls.some((u: string) => u.includes('victim.pdf'))).toBe(false);
    });

    it("rejects path-traversal in files[].url", async () => {
      const traversal =
        `http://localhost:3000/minio/uetk-test/uploads/forms/private/${userA.id}/../${userB.id}/escape.pdf`;
      const form: any = await broker.call(
        'forms.create',
        {
          type: 'NEW',
          objectType: 'POND',
          objectName: 'traversal test',
          providerType: 'OWNER',
          description: 'x',
          geom: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [500000, 6000000] },
                properties: {},
              },
            ],
          },
          files: [{ url: traversal, filename: 'escape.pdf' }],
        },
        { meta: userMeta(userA) }
      );

      const urls = (form.files || []).map((f: any) => f.url);
      expect(urls.some((u: string) => u.includes('escape.pdf'))).toBe(false);
    });

    it('accepts files inside the tenant folder for tenant admin', async () => {
      const tenantUrl =
        `http://localhost:3000/minio/uetk-test/uploads/forms/${tenant.id}/${userA.id}/tenant-file.pdf`;
      const form: any = await broker.call(
        'forms.create',
        {
          type: 'NEW',
          objectType: 'POND',
          objectName: 'tenant test',
          providerType: 'OWNER',
          description: 'x',
          geom: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [500000, 6000000] },
                properties: {},
              },
            ],
          },
          files: [{ url: tenantUrl, filename: 'tenant-file.pdf' }],
        },
        { meta: tenantMeta(userA, { id: tenant.id, role: 'ADMIN' }) }
      );
      const urls = (form.files || []).map((f: any) => f.url);
      expect(urls.some((u: string) => u.includes('tenant-file.pdf'))).toBe(true);
    });
  });
});
