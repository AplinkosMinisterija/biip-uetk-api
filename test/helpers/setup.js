'use strict';

// Test runtime: every env var that the services read on import must be set
// here. The values point at the CI / docker-compose Postgres + Redis services
// and fake out anything that would otherwise reach an external system
// (biip-auth, MinIO, tools-host).
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

process.env.AUTH_HOST = 'http://stub-auth.test';
process.env.AUTH_API_KEY = 'test';
process.env.APP_HOST = 'https://test-uetk.biip.lt';
process.env.SERVER_HOST = 'http://localhost:3000';
process.env.MAPS_HOST = 'https://maps.biip.lt';
process.env.TOOLS_HOST = 'http://stub-tools.test';
process.env.QGIS_SERVER_HOST = 'https://gis.biip.lt';

process.env.DB_CONNECTION =
  process.env.DB_CONNECTION ||
  'postgresql://postgres:postgres@localhost:5436/uetk_test';
process.env.GIS_DB_CONNECTION =
  process.env.GIS_DB_CONNECTION || process.env.DB_CONNECTION;

process.env.REDIS_CONNECTION =
  process.env.REDIS_CONNECTION || 'redis://localhost:6671';

process.env.MINIO_ACCESSKEY = 'minioadmin';
process.env.MINIO_SECRETKEY = 'minioadmin';
process.env.MINIO_BUCKET = 'uetk-test';
process.env.MINIO_ENDPOINT = 'localhost';
process.env.MINIO_PORT = '9000';
process.env.MINIO_USESSL = 'false';
process.env.MINIO_PUBLIC_URL = 'http://localhost:9000';

// HMAC key for getRequestSecret. Tests assert HMAC mode is on, so this must
// not be empty.
process.env.REQUEST_SECRET = 'test-request-secret-please-rotate-in-prod';
