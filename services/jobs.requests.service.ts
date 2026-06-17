'use strict';

import moleculer, { Context } from 'moleculer';
import { Action, Method, Service } from 'moleculer-decorators';
import moment from 'moment';
import BullMqMixin from '../mixins/bullmq.mixin';
import { FILE_TYPES, throwNotFoundError } from '../types';
import {
  addLeadingZeros,
  getRequestSecret,
  getTemplateHtml,
  roundNumber,
  toMD5Hash,
  toReadableStream,
} from '../utils';
import { AuthType } from './api.service';
import { UETKObject } from './objects.service';
import { Request } from './requests.service';
import { Tenant } from './tenants.service';
import { User } from './users.service';

// Layer names shown to the QGIS / ArcGIS user when opening the extract
// .gdb. Keyed by geometry family because every UETKObjectType maps
// 1:1 to a family (rivers/canals -> lines, lakes/ponds -> polygons,
// dams/hydro/fish/culvert -> points). OpenFileGDB launders whitespace
// to underscores, so the LT names are written with underscores
// upfront — the GDB file ends up with the exact name we send.
const GDB_LAYER_NAMES = {
  lines: 'Upės',
  polygons: 'Ežerai_ir_tvenkiniai',
  points: 'Hidrotechniniai_statiniai',
} as const;

@Service({
  name: 'jobs.requests',
  mixins: [BullMqMixin],
  settings: {
    bullmq: {
      worker: { concurrency: 5 },
      job: {
        attempts: 5,
        failParentOnFailure: true,
        backoff: 1000,
      },
    },
  },
})
export default class JobsRequestsService extends moleculer.Service {
  @Action({
    queue: true,
    params: {
      id: 'number',
    },
    timeout: 0,
  })
  async generateAndSavePdf(ctx: Context<{ id: number }>) {
    const { id } = ctx.params;
    const { job } = ctx.locals;

    const request: Request = await ctx.call('requests.resolve', {
      id,
      populate: 'createdBy,tenant',
    });

    const childrenValues = await job.getChildrenValues();

    const screenshotsByHash: any = Object.values(childrenValues).reduce(
      (acc: any, item: any) => ({
        ...acc,
        [item.hash]: item.url,
      }),
      {}
    );

    const screenshotsHash = toMD5Hash(
      `id=${id}&date=${moment().format('YYYYMMDDHHmmsss')}`
    );
    const redisKey = `screenshots.${screenshotsHash}`;

    await this.broker.cacher.set(redisKey, screenshotsByHash);

    const secret = getRequestSecret(request);

    const footerHtml = getTemplateHtml('footer.ejs', {
      id: addLeadingZeros(id),
      date: moment(request.createdAt).format('YYYY-MM-DD'),
    });

    const pdf = await ctx.call('tools.makePdf', {
      url: `${process.env.SERVER_HOST}/jobs/requests/${id}/html?secret=${secret}&skey=${screenshotsHash}`,
      footer: footerHtml,
      // Portrait A4. Stakeholder requires the map page keep its
      // preamble (AAA header + "KADASTRO ŽEMĖLAPIO IŠTRAUKA" + numeris
      // + suformavimo data + object name + kadastro_id), which eats
      // ~190pt of the content area regardless of orientation. In
      // landscape the remaining 305pt isn't enough for a tall screenshot
      // — the 742x464pt image overflows. Portrait leaves ~552pt for
      // the map, which a 1280x1400 viewport fills almost exactly
      // (495x542pt rendered = the largest map area we can give without
      // dropping the required preamble).
    });

    const folder = this.getFolderName(
      request?.createdBy as any as User,
      request?.tenant as Tenant
    );

    const result: any = await ctx.call(
      'minio.uploadFile',
      {
        payload: toReadableStream(pdf),
        folder,
        isPrivate: true,
        types: FILE_TYPES,
      },
      {
        meta: {
          mimetype: 'application/pdf',
          filename: `israsas-${request.id}.pdf`,
        },
      }
    );

    await ctx.call('requests.saveGeneratedPdf', {
      id,
      url: result.url,
    });

    return { job: job.id };
  }

  @Action({
    queue: true,
    params: {
      id: 'number',
    },
    timeout: 0,
  })
  async generateAndSaveGdb(ctx: Context<{ id: number }>) {
    const { id } = ctx.params;

    const request: Request = await ctx.call('requests.resolve', {
      id,
      populate: 'createdBy,tenant,geom',
    });

    if (!request?.id) return { skipped: 'no-request' };

    const cadastralIds = request.objects
      ?.filter((i) => i.type === 'CADASTRAL_ID')
      ?.map((i) => i.id)
      ?.filter((i) => !!i);

    const query: any = {};
    if (cadastralIds?.length) query.cadastralId = { $in: cadastralIds };
    if (request.geom && Object.keys(request.geom).length) query.geom = request.geom;

    if (!query.cadastralId && !query.geom) return { skipped: 'no-objects' };

    const objects: UETKObject[] = await ctx.call('objects.find', {
      query,
      populate: ['geom', 'extendedData'],
    });

    // OpenFileGDB requires one geometry type per layer, AND the public
    // UETK GDB schema differs per geometry family (lines = `upes_l`
    // with `ziociu_x/y` + `ilgis_uetk`; polygons = `ezerai_tvenkiniai`
    // with `objekto_x/y` + `st_area` + reg date + pabaseinis; points
    // = hidroelektrines / zuvu_pralaidos / etc. with just
    // `objekto_x/y` and no reg/pabaseinis). Bucket per geometry family
    // first, then build per-family properties so each layer's
    // attribute table matches the public uetk.gdb.
    type Bucketed = { geometry: any; obj: any; inheritedProps: any };
    const flat: Bucketed[] = objects.flatMap((obj: any) => {
      if (
        obj.geom?.type === 'FeatureCollection' &&
        Array.isArray(obj.geom.features)
      ) {
        return obj.geom.features
          .filter((f: any) => f?.geometry?.type)
          .map((f: any) => ({
            geometry: f.geometry,
            obj,
            inheritedProps: f.properties || {},
          }));
      }
      const geometry =
        obj.geom?.geometry || (obj.geom?.type ? obj.geom : null);
      if (!geometry?.type) return [];
      return [{ geometry, obj, inheritedProps: {} }];
    });

    const buckets = {
      points: [] as Bucketed[],
      lines: [] as Bucketed[],
      polygons: [] as Bucketed[],
    };
    for (const item of flat) {
      const t = item.geometry?.type;
      if (t === 'Point' || t === 'MultiPoint') buckets.points.push(item);
      else if (t === 'LineString' || t === 'MultiLineString')
        buckets.lines.push(item);
      else if (t === 'Polygon' || t === 'MultiPolygon')
        buckets.polygons.push(item);
    }

    const populatedLayers = (
      Object.entries(buckets) as Array<
        [keyof typeof buckets, Bucketed[]]
      >
    )
      .filter(([, items]) => items.length > 0)
      .map(([family, items]) => ({
        name: GDB_LAYER_NAMES[family],
        geojson: {
          type: 'FeatureCollection',
          features: items.map(({ geometry, obj, inheritedProps }) => ({
            type: 'Feature',
            geometry,
            properties: {
              ...this.basePropsForFamily(obj, family),
              ...inheritedProps,
            },
          })),
        },
      }));
    if (!populatedLayers.length) return { skipped: 'no-geometries' };

    const archiveName = `israsas-${request.id}`;
    // tools.makeGdb streams the ZIP back as a Node Readable (no buffering).
    // Always use the `layers` payload (even for single-family requests)
    // so the layer-name inside the .gdb is the LT label from
    // GDB_LAYER_NAMES, not the archive name. The single-geojson legacy
    // shape would name the layer `israsas-${id}` instead.
    //
    // A failure here MUST surface — historically the BullMQ retry loop
    // ate the rejection and the request stayed APPROVED with no
    // generated file (BĮIP request Nr. 232). We rethrow so BullMQ marks
    // the job failed *and* the request stays observably broken instead
    // of silently green.
    const stream: NodeJS.ReadableStream = await ctx
      .call('tools.makeGdb', {
        layers: populatedLayers,
        name: archiveName,
        srid: 3346,
      })
      .then((s) => s as NodeJS.ReadableStream)
      .catch((err: any) => {
        this.logger.error(
          `tools.makeGdb failed for request ${request.id} ` +
            `(${populatedLayers.length} layer(s): ${populatedLayers
              .map((l) => `${l.name}=${l.geojson.features.length}`)
              .join(', ')})`,
          err,
        );
        throw err;
      });

    const folder = this.getFolderName(
      request?.createdBy as any as User,
      request?.tenant as Tenant
    );

    const result: any = await ctx.call(
      'minio.uploadFile',
      {
        payload: stream,
        folder,
        isPrivate: true,
        types: ['application/zip', 'application/x-zip-compressed'],
        name: `israsas-${request.id}`,
      },
      {
        meta: {
          mimetype: 'application/zip',
          filename: `israsas-${request.id}.zip`,
        },
      }
    );

    await ctx.call('requests.saveGeneratedPdf', { id, url: result.url });

    return { generated: true };
  }

  @Action({
    queue: true,
    params: {
      id: 'number',
    },
    timeout: 0,
  })
  async generateAndSaveGeoJson(ctx: Context<{ id: number }>) {
    const { id } = ctx.params;

    const request: Request = await ctx.call('requests.resolve', {
      id,
      populate: 'createdBy,tenant,geom',
    });

    if (!request?.id) return { skipped: 'no-request' };

    const cadastralIds = request.objects
      ?.filter((i) => i.type === 'CADASTRAL_ID')
      ?.map((i) => i.id)
      ?.filter((i) => !!i);

    const query: any = {};
    if (cadastralIds?.length) query.cadastralId = { $in: cadastralIds };
    if (request.geom && Object.keys(request.geom).length) query.geom = request.geom;

    if (!query.cadastralId && !query.geom) return { skipped: 'no-objects' };

    const objects: UETKObject[] = await ctx.call('objects.find', {
      query,
      populate: ['geom', 'extendedData'],
    });

    // Same per-family schema as generateAndSaveGdb so a user requesting
    // either format reads the same attribute table — only the
    // post-assembly shipping differs (GDB → multi-layer .gdb; GeoJSON
    // → single FeatureCollection, reprojected). See
    // basePropsForFamily for the per-family rationale.
    const familyOf = (
      t?: string,
    ): 'points' | 'lines' | 'polygons' | null => {
      if (t === 'Point' || t === 'MultiPoint') return 'points';
      if (t === 'LineString' || t === 'MultiLineString') return 'lines';
      if (t === 'Polygon' || t === 'MultiPolygon') return 'polygons';
      return null;
    };
    const buildFeature = (geometry: any, obj: any, inheritedProps: any) => {
      const family = familyOf(geometry?.type);
      if (!family) return null;
      return {
        type: 'Feature',
        geometry,
        properties: {
          ...this.basePropsForFamily(obj, family),
          ...inheritedProps,
        },
      };
    };
    const features = objects.flatMap((obj: any) => {
      if (
        obj.geom?.type === 'FeatureCollection' &&
        Array.isArray(obj.geom.features)
      ) {
        return obj.geom.features
          .map((f: any) => buildFeature(f.geometry, obj, f.properties || {}))
          .filter(Boolean);
      }
      const geometry =
        obj.geom?.geometry || (obj.geom?.type ? obj.geom : null);
      const built = buildFeature(geometry, obj, {});
      return built ? [built] : [];
    });

    if (!features.length) return { skipped: 'no-geometries' };

    const geojson = { type: 'FeatureCollection', features };

    // Publishing.uetkMerged stores geometries in EPSG:3346 (LKS-94), but
    // the GeoJSON spec mandates WGS84 (EPSG:4326). A raw 3346 GeoJSON
    // does not load in QGIS or any web map tool without a manual CRS
    // hint — which the stakeholder confirmed as the blocker that killed
    // the previous GeoJSON output. tools.reproject pipes through
    // ogr2ogr -s_srs 3346 -t_srs 4326 and streams the result back.
    // A failure here MUST rethrow so BullMQ marks the job failed and
    // the request doesn't end up APPROVED with a missing file.
    const stream: NodeJS.ReadableStream = await ctx
      .call('tools.reproject', {
        geojson,
        sourceSrid: 3346,
        targetSrid: 4326,
      })
      .then((s) => s as NodeJS.ReadableStream)
      .catch((err: any) => {
        this.logger.error(
          `tools.reproject failed for request ${request.id} ` +
            `(${features.length} features)`,
          err,
        );
        throw err;
      });

    const folder = this.getFolderName(
      request?.createdBy as any as User,
      request?.tenant as Tenant
    );

    const result: any = await ctx.call(
      'minio.uploadFile',
      {
        payload: stream,
        folder,
        isPrivate: true,
        // Browsers / curl uploads can present either of these for a
        // .geojson, depending on the OS mime table. MinIO matches against
        // this list, so accept both.
        types: ['application/geo+json', 'application/json'],
        name: `israsas-${request.id}`,
      },
      {
        meta: {
          mimetype: 'application/geo+json',
          filename: `israsas-${request.id}.geojson`,
        },
      }
    );

    await ctx.call('requests.saveGeneratedPdf', { id, url: result.url });

    return { generated: true };
  }

  @Action({
    params: {
      id: 'number',
    },
    timeout: 0,
  })
  async initiateGdbGenerate(ctx: Context<{ id: number }>) {
    // No screenshot children needed for GDB — single queued job with
    // BullMQ retry semantics inherited from the mixin (5 attempts, 1s
    // backoff). Mirrors initiatePdfGenerate but without the flow() step.
    const job = await this.localQueue(ctx, 'generateAndSaveGdb', {
      id: ctx.params.id,
    });
    return { job: { id: job.id } };
  }

  @Action({
    params: {
      id: 'number',
    },
    timeout: 0,
  })
  async initiateGeoJsonGenerate(ctx: Context<{ id: number }>) {
    // Same shape as initiateGdbGenerate — single queued job, BullMQ
    // retry semantics inherited from the mixin. No screenshot children
    // since GeoJSON is a pure data extract.
    const job = await this.localQueue(ctx, 'generateAndSaveGeoJson', {
      id: ctx.params.id,
    });
    return { job: { id: job.id } };
  }

  @Action({
    params: {
      id: 'number',
    },
    timeout: 0,
  })
  async initiatePdfGenerate(ctx: Context<{ id: number }>) {
    const data: any[] = [];

    const { id } = ctx.params;

    const objects: any[] = await this.getRequestData(id);

    const params = new URLSearchParams({
      screenshot: '1',
      preview: '1',
    });

    function getUrl(params: URLSearchParams) {
      const mapHost = process.env.MAPS_HOST || 'https://maps.biip.lt';
      return `${mapHost}/uetk?${params.toString()}`;
    }

    // add all objects
    objects.forEach((item) => {
      params.set('cadastralId', `${item.id}`);
      data.push({
        url: getUrl(params),
        hash: item.hash,
      });
    });

    const childrenJobs = data.map((item) => ({
      // 1280x1400 (taller-than-wide) — sized for portrait A4 below the
      // required preamble. Scales to ~495x542pt in the PDF, which
      // fills the available content area after the AAA header + KADASTRO
      // ŽEMĖLAPIO IŠTRAUKA title + numeris + data + object name block
      // (~190pt). Going taller (e.g. 1280x1600) would render under the
      // page bottom margin.
      params: { ...item, waitFor: '#image-canvas-0', width: 1280, height: 1400 },
      name: 'jobs',
      action: 'saveScreenshot',
    }));

    return this.flow(
      ctx,
      'jobs.requests',
      'generateAndSavePdf',
      {
        id,
      },
      childrenJobs
    );
  }

  @Action({
    params: {
      id: {
        type: 'number',
        convert: true,
      },
      secret: 'string',
      skey: {
        type: 'string',
        optional: true,
      },
    },
    rest: 'GET /:id/html',
    timeout: 0,
    auth: AuthType.PUBLIC,
  })
  async getRequestHtml(
    ctx: Context<
      { id: number; secret: string; skey: string },
      { $responseType: string }
    >
  ) {
    const { id, secret, skey: screenshotsRedisKey } = ctx.params;

    const request: Request = await ctx.call('requests.resolve', {
      id,
      throwIfNotExist: true,
    });

    const secretToApprove = getRequestSecret(request);
    if (!request?.id || !secret || secret !== secretToApprove) {
      return throwNotFoundError('Invalid secret!');
    }

    const objects: any[] = await this.getRequestData(id);

    let screenshotsByHash: any = {};
    if (screenshotsRedisKey) {
      screenshotsByHash = await this.broker.cacher.get(
        `screenshots.${screenshotsRedisKey}`
      );
    }

    ctx.meta.$responseType = 'text/html';

    return getTemplateHtml('request.ejs', {
      id: addLeadingZeros(id),
      date: request.createdAt,
      objects: objects.map((o) => ({
        ...o,
        screenshot: screenshotsByHash?.[o.hash] || '',
      })),
      formatDate: (date: string, format = 'YYYY-MM-DD') => {
        if (!date?.toString()?.trim()) return;

        const momentDate = moment(date);

        if (!momentDate.isValid()) return;

        return momentDate.format(format);
      },
      roundNumber,
      trimValue: (value?: string) => {
        if (!value) return '';

        return value?.trim();
      },
      fullData: !!request?.data?.extended,
    });
  }

  @Method
  getFolderName(user?: User, tenant?: Tenant) {
    const tenantPath = tenant?.id || 'private';
    const userPath = user?.id || 'user';

    return `uploads/requests/${tenantPath}/${userPath}`;
  }

  @Method
  async getRequestData(id: number) {
    const request: Request = await this.broker.call('requests.resolve', {
      id,
      populate: 'geom',
    });

    const cadastralIds = request.objects
      ?.filter((i) => i.type === 'CADASTRAL_ID')
      ?.map((i) => i.id)
      ?.filter((i) => !!i);

    const query: any = {};

    if (cadastralIds?.length) {
      query.cadastralId = { $in: cadastralIds };
    }

    if (request.geom && !!Object.keys(request.geom).length) {
      query.geom = request.geom;
    }

    if (!query.cadastralId && !query.geom) return [];

    const allItems: any[] = await this.broker.call('objects.find', {
      query,
      populate: 'extendedData',
    });

    const objects = allItems.map((item) => ({
      ...item,
      screenshot: '',
      id: item.cadastralId,
      hash: toMD5Hash(`cadastralId=${item.cadastralId}`),
    }));

    return objects;
  }

  // Build the per-feature attribute table for a given geometry family.
  // Schema matches the public UETK GDB (https://uetk.biip.lt/zemelapis/)
  // — three different shapes per family because the source category
  // tables themselves differ:
  //
  //   lines    upes_l                 id, kadastro_id, pavadinimas,
  //                                   kategorija, registracijos_data,
  //                                   upiu_pabas_id, ziociu_x/y,
  //                                   ilgis_uetk
  //   polygons ezerai_tvenkiniai      ...same admin block...
  //                                   objekto_x/y, st_area
  //   points   hidroelektrines etc.   id, kadastro_id, pavadinimas,
  //                                   kategorija, objekto_x/y
  //                                   (no reg date, no pabaseinis)
  //
  // kategorija intentionally uses categoryTranslate (the LT label
  // "Upė" / "Natūralus ežeras" / ...) instead of the raw enum so a
  // QGIS user reads human labels, not internal codes.
  //
  // extendedData is populated per-category by objects.service from the
  // uetk.israsai* tables (rivers expose ziociuX/Y, lakes expose
  // objektoX/Y, both expose registravimoData + the pabaseinis name).
  // We fall back to publishing.uetkMerged's WGS84 lng/lat for rows
  // without a matching extendedData query so they still ship usable
  // coordinates instead of nulls.
  @Method
  basePropsForFamily(obj: any, family: 'points' | 'lines' | 'polygons') {
    const ext = obj.extendedData || {};
    const common = {
      id: obj.id,
      kadastro_id: obj.cadastralId,
      pavadinimas: obj.name,
      kategorija: obj.categoryTranslate,
    };
    const adminBlock = {
      registracijos_data: ext.registravimoData ?? null,
      upiu_pabas_id:
        ext.pabaseinioPavadinimas ?? ext.baseinoPavadinimas ?? null,
    };
    if (family === 'lines') {
      return {
        ...common,
        ...adminBlock,
        ziociu_x: ext.ziociuX ?? obj.lng,
        ziociu_y: ext.ziociuY ?? obj.lat,
        ilgis_uetk: ext.upesIlgis ?? obj.length ?? null,
      };
    }
    if (family === 'polygons') {
      return {
        ...common,
        ...adminBlock,
        objekto_x: ext.objektoX ?? obj.lng,
        objekto_y: ext.objektoY ?? obj.lat,
        st_area: ext.vandensPavirsiausPlotasHe ?? obj.area ?? null,
      };
    }
    // family === 'points' — hidro, fish, dam, culvert. The public GDB
    // doesn't carry reg date / pabaseinis for these layers, so we
    // omit them entirely rather than ship nulls.
    return {
      ...common,
      objekto_x: ext.objektoX ?? obj.lng,
      objekto_y: ext.objektoY ?? obj.lat,
    };
  }
}
