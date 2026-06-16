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
      populate: 'geom',
    });

    // flatMap so multi-geometry objects emit one Feature per inner geometry.
    // baseProps uses the published UETK GDB column naming
    // (https://uetk.biip.lt/zemelapis/) so the file's attribute table
    // matches what QGIS/ArcGIS users see in the public bulk download.
    // Every value comes from existing English-named UETKObject fields —
    // five of them (registrationDate, subbasinId, centroidX, centroidY,
    // stArea) are exposed by objects.service via explicit columnName
    // mappings into the LT publishing.uetkMerged columns, so we only
    // rename in this output layer, not in the model.
    //
    // kategorija intentionally uses categoryTranslate (the LT label
    // "Upė" / "Natūralus ežeras" / ...), not the raw category enum
    // ("RIVER" / "NATURAL_LAKE"), so users opening the .gdb in QGIS
    // read human labels instead of internal codes.
    const features = objects.flatMap((obj: any) => {
      const baseProps = {
        id: obj.id,
        kadastro_id: obj.cadastralId,
        pavadinimas: obj.name,
        kategorija: obj.categoryTranslate,
        registracijos_data: obj.registrationDate,
        upiu_pabas_id: obj.subbasinId,
        objekto_x: obj.centroidX,
        objekto_y: obj.centroidY,
        st_area: obj.stArea,
      };
      if (
        obj.geom?.type === 'FeatureCollection' &&
        Array.isArray(obj.geom.features)
      ) {
        return obj.geom.features
          .filter((f: any) => f?.geometry?.type)
          .map((f: any) => ({
            type: 'Feature',
            geometry: f.geometry,
            properties: { ...baseProps, ...(f.properties || {}) },
          }));
      }
      const geometry =
        obj.geom?.geometry || (obj.geom?.type ? obj.geom : null);
      if (!geometry?.type) return [];
      return [{ type: 'Feature', geometry, properties: baseProps }];
    });

    if (!features.length) return { skipped: 'no-geometries' };

    // OpenFileGDB requires one geometry type per layer. Bucket features by
    // their normalized geometry family (Point / LineString / Polygon —
    // Multi* variants fold into the same bucket as their singular form so
    // QGIS can render them as one layer). When the request bundles more
    // than one bucket, send the multi-layer payload — tools then writes
    // each bucket as its own table inside a single .gdb. Single-bucket
    // requests still go through the legacy single-layer path so we don't
    // surprise downstream consumers (and so the legacy GDB layout is
    // preserved when nothing has changed).
    const buckets = {
      points: [] as any[], // Point / MultiPoint
      lines: [] as any[], // LineString / MultiLineString
      polygons: [] as any[], // Polygon / MultiPolygon
    };
    for (const feature of features) {
      const t = feature.geometry?.type;
      if (t === 'Point' || t === 'MultiPoint') buckets.points.push(feature);
      else if (t === 'LineString' || t === 'MultiLineString')
        buckets.lines.push(feature);
      else if (t === 'Polygon' || t === 'MultiPolygon')
        buckets.polygons.push(feature);
    }
    const populatedLayers = Object.entries(buckets)
      .filter(([, list]) => list.length > 0)
      .map(([name, list]) => ({
        name,
        geojson: { type: 'FeatureCollection', features: list },
      }));
    if (!populatedLayers.length) return { skipped: 'no-geometries' };

    const archiveName = `israsas-${request.id}`;
    // tools.makeGdb streams the ZIP back as a Node Readable (no buffering).
    // A failure here MUST surface — historically the BullMQ retry loop ate
    // the rejection and the request stayed APPROVED with no generated file
    // (BĮIP request Nr. 232). We rethrow so BullMQ marks the job failed
    // *and* the request stays observably broken instead of silently green.
    const stream: NodeJS.ReadableStream = await ctx
      .call(
        'tools.makeGdb',
        populatedLayers.length === 1
          ? {
              geojson: populatedLayers[0].geojson,
              name: archiveName,
              srid: 3346,
            }
          : {
              layers: populatedLayers,
              name: archiveName,
              srid: 3346,
            },
      )
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
}
