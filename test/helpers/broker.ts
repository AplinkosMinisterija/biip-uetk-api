'use strict';

import { ServiceBroker, ServiceSchema } from 'moleculer';
import { knex } from 'knex';
import { config as knexConfig } from '../../knexfile';

// Real services we want to exercise — anything carrying scope filters,
// field hooks, or the security-audit fixes belongs here.
const RequestsService = require('../../services/requests.service').default;
const RequestsHistoriesService =
  require('../../services/requests.histories.service').default;
const FormsService = require('../../services/forms.service').default;
const FormsHistoriesService =
  require('../../services/forms.histories.service').default;
const UsersService = require('../../services/users.service').default;
const TenantsService = require('../../services/tenants.service').default;
const TenantUsersService =
  require('../../services/tenantUsers.service').default;

/**
 * Stub `minio` service. Real signStoredUrl + folder ownership logic lives in
 * services/minio.service.ts, but pulling that file into tests drags in the
 * moleculer-minio mixin which wants a live S3 endpoint. We re-implement the
 * tiny piece of logic the field hooks depend on so set/get hooks can call
 * minio.signStoredUrl without hitting real MinIO.
 */
function callerOwnedFolders(meta: any): string[] {
  const userId = meta?.user?.id;
  const tenantId = meta?.profile?.id;
  const folders: string[] = [];
  for (const kind of ['forms', 'requests']) {
    folders.push(`uploads/${kind}/private/${userId ?? 'user'}`);
    if (tenantId) folders.push(`uploads/${kind}/${tenantId}/${userId ?? 'user'}`);
  }
  return folders;
}

function isFolderOwnedByCaller(folder: string, meta: any): boolean {
  if (!folder || typeof folder !== 'string') return false;
  const normalized = folder.replace(/^\/+|\/+$/g, '');
  if (normalized.includes('..') || normalized.includes('\\')) return false;
  if (!meta?.user?.id) return true;
  if (meta.user.type === 'ADMIN') return true;
  return callerOwnedFolders(meta).some(
    (owned) => normalized === owned || normalized.startsWith(`${owned}/`)
  );
}

const minioStub: ServiceSchema = {
  name: 'minio',
  actions: {
    signStoredUrl: {
      params: { url: 'string' },
      visibility: 'protected',
      handler(ctx: any) {
        const { url } = ctx.params;
        if (!url || typeof url !== 'string') return url;
        const idx = url.indexOf('/minio/');
        if (idx === -1) return url;
        const rest = url.slice(idx + '/minio/'.length);
        const [bucketName, ...objectParts] = rest.split('/');
        const objectName = objectParts.join('/');
        if (!bucketName || !objectName) return url;
        if (!isFolderOwnedByCaller(objectName, ctx.meta)) return url;
        return `${url}${url.includes('?') ? '&' : '?'}X-Amz-Signature=test-stub`;
      },
    },
    uploadFile: {
      visibility: 'protected',
      handler(ctx: any) {
        const folder = ctx.params?.folder || 'uploads/tmp/x/x';
        const name = ctx.params?.name || 'stub';
        const path = `${folder}/${name}.bin`;
        return {
          url: `http://localhost:9000/minio/uetk-test/${path}`,
          path: `uetk-test/${path}`,
          filename: ctx.meta?.filename,
          size: 100,
        };
      },
    },
    getFile: { handler: () => Buffer.from('stub') },
    removeFile: { handler: () => ({ success: true }) },
    fileStat: { handler: () => ({ exists: false }) },
    getUrl: { handler: () => 'http://localhost:9000/stub' },
    putObject: { handler: () => ({}) },
    getObject: { handler: () => Buffer.from('stub') },
    statObject: { handler: () => ({ size: 100 }) },
    removeObject: { handler: () => ({}) },
    presignedUrl: { handler: () => 'http://localhost:9000/presigned-stub' },
  },
};

// External auth service stub. Returns canned values for the handful of calls
// the real services make.
const authStub: ServiceSchema = {
  name: 'auth',
  actions: {
    'users.resolveToken': { handler: () => null },
    'users.get': { handler: () => ({}) },
    'users.invite': {
      handler: (ctx: any) => ({
        id: Math.floor(Math.random() * 1e9),
        firstName: 'Stub',
        lastName: 'Auth',
        email: ctx.params?.notify?.[0] || 'stub@test',
        type: 'USER',
      }),
    },
    'users.assignToGroup': { handler: () => ({ success: true }) },
    'users.unassignFromGroup': { handler: () => ({ success: true }) },
    'users.remove': { handler: () => ({ success: true }) },
    'users.logout': { handler: () => ({ success: true }) },
    'groups.get': { handler: () => ({ id: 1, name: 'stub-group', role: 'USER' }) },
    'groups.remove': { handler: () => ({ success: true }) },
    'apps.resolveToken': { handler: () => ({ id: 1, name: 'uetk-test' }) },
    validateType: {
      handler: (ctx: any) => {
        const types: string[] = ctx.params?.types || [];
        const { user, profile } = ctx.meta || {};
        if (!types?.length) return true;
        let ok = false;
        if (types.includes('ADMIN')) ok = ok || user?.type === 'ADMIN';
        if (types.includes('USER')) ok = ok || user?.type === 'USER';
        if (types.includes('TENANT_ADMIN'))
          ok = ok || profile?.role === 'ADMIN';
        if (types.includes('TENANT_USER')) ok = ok || !!profile?.id;
        return ok;
      },
    },
  },
};

// Objects service stub — the real one queries the GIS DB (PostGIS publishing
// schema) which we don't ship in test fixtures. Tests that need objects can
// stub more deeply per-spec.
const objectsStub: ServiceSchema = {
  name: 'objects',
  actions: {
    find: { handler: () => [] },
    list: {
      handler: () => ({
        rows: [],
        total: 0,
        page: 1,
        pageSize: 10,
        totalPages: 0,
      }),
    },
    findOne: { handler: () => null },
    search: { handler: () => ({ rows: [], total: 0 }) },
  },
};

// Tools stub for SSRF allowlist tests we exercise through the real
// tools.service action — see search.spec.ts. Not used by default.

/**
 * Build a broker wired with the security-relevant services + stubs.
 *
 * Caller is responsible for `broker.start()` and `broker.stop()`. Migrations
 * are NOT automatic — call `runMigrations()` separately before broker.start().
 */
export function buildBroker() {
  const broker = new ServiceBroker({
    logger: { type: 'Console', options: { level: 'warn' } },
    cacher: 'Memory',
    transporter: null as any,
  });

  // Stubs MUST be registered before real services if there are name collisions
  // (broker.createService is order-sensitive only for the last-wins case;
  // we register stubs first to be explicit).
  broker.createService(authStub);
  broker.createService(minioStub);
  broker.createService(objectsStub);

  broker.createService(UsersService);
  broker.createService(TenantsService);
  broker.createService(TenantUsersService);
  broker.createService(RequestsService);
  broker.createService(RequestsHistoriesService);
  broker.createService(FormsService);
  broker.createService(FormsHistoriesService);

  return broker;
}

/**
 * Wipe + migrate the test database. Idempotent. Run once before broker.start
 * in beforeAll.
 *
 * Each spec file gets a fresh broker + fresh migrations; we drop all known
 * tables AND the enum types created by migrations (user_type etc.), otherwise
 * the second migrate.latest() in the same Jest run hits
 * `type "user_type" already exists`.
 */
export async function runMigrations() {
  const k = knex(knexConfig);
  try {
    // Drop every non-PostGIS table + enum in the public schema. Hard-coding
    // the lists kept missing new tables / types when migrations grow (we hit
    // form_histories, tenant_user_role). PostGIS owns spatial_ref_sys + its
    // helper tables under public — skip those, dropping them breaks the
    // extension.
    await k.raw(`
      DO $$
      DECLARE r RECORD;
      BEGIN
        FOR r IN (
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public'
            AND tablename NOT IN ('spatial_ref_sys', 'geography_columns', 'geometry_columns', 'raster_columns', 'raster_overviews')
        ) LOOP
          EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
        FOR r IN (
          SELECT t.typname
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typtype = 'e'
        ) LOOP
          EXECUTE 'DROP TYPE IF EXISTS public.' || quote_ident(r.typname) || ' CASCADE';
        END LOOP;
      END $$;
    `);
    await k.migrate.latest();
  } finally {
    await k.destroy();
  }
}

/** Meta to call actions as a regular user. */
export function userMeta(user: { id: number; type?: string; firstName?: string; lastName?: string; email?: string }) {
  return {
    user: {
      id: user.id,
      type: user.type || 'USER',
      firstName: user.firstName || 'Test',
      lastName: user.lastName || 'User',
      email: user.email || 'user@test',
    },
    profile: undefined as any,
  };
}

/** Meta to call actions as an admin. */
export function adminMeta(adminId = 1) {
  return {
    user: {
      id: adminId,
      type: 'ADMIN',
      firstName: 'Test',
      lastName: 'Admin',
      email: 'admin@test',
    },
    profile: undefined as any,
  };
}

/** Meta to call actions as a tenant user / admin. */
export function tenantMeta(
  user: { id: number; type?: string },
  tenant: { id: number; role: 'USER' | 'ADMIN' }
) {
  return {
    user: { id: user.id, type: user.type || 'USER' },
    profile: { id: tenant.id, role: tenant.role },
  };
}

/** Seed a baseline set of users + tenants used across specs. */
export async function seedBaseline(broker: ServiceBroker) {
  const admin: any = await broker.call(
    'users.create',
    {
      firstName: 'Test',
      lastName: 'Admin',
      email: 'admin@test',
      type: 'ADMIN',
      authUser: 1001,
    }
  );
  const userA: any = await broker.call('users.create', {
    firstName: 'User',
    lastName: 'A',
    email: 'user-a@test',
    type: 'USER',
    authUser: 2001,
  });
  const userB: any = await broker.call('users.create', {
    firstName: 'User',
    lastName: 'B',
    email: 'user-b@test',
    type: 'USER',
    authUser: 2002,
  });
  const tenant: any = await broker.call('tenants.create', {
    name: 'Test Tenant',
    email: 'tenant@test',
    code: 'test-tenant',
    authGroup: 9001,
  });
  await broker.call('tenantUsers.create', {
    tenant: tenant.id,
    user: userA.id,
    role: 'ADMIN',
  });
  return { admin, userA, userB, tenant };
}
