/*
 * moleculer-bullmq
 * Copyright (c) 2022 LuxChan S.A R.L.-S (https://github.com/LuxChanLu/moleculer-bullmq)
 * MIT Licensed
 */

'use strict';

import { Worker, Queue, QueueEvents, FlowProducer } from 'bullmq';
import { Context } from 'moleculer';
import _ from 'lodash';

export default {
  settings: {
    bullmq: {
      worker: {},
    },
  },
  hooks: {
    before: {
      '*': '$populateJob',
    },
  },
  created() {
    this.$queues = Object.entries(this.schema.actions || {})
      .filter(([, { queue }]: any[]) => queue)
      .map(([name]) => name);
    this.$queueResolved = {};
    this.$connection = this.settings.bullmq.client
      ? this.settings.bullmq.client
      : this.broker.cacher.client.options;
  },
  async started() {
    if (this.$queues.length > 0) {
      this.$worker = new Worker(
        this.$queueName(),
        async (job) => {
          const { params, meta, parentSpan } = job.data;
          meta.job = { id: job.id, queue: this.$queueName() };
          return this.broker.call(`${this.$queueName()}.${job.name}`, params, {
            meta,
            timeout: 0,
            parentSpan,
          });
        },
        _.merge(this.settings.bullmq.worker, { connection: this.$connection })
      );
      this.$events = new QueueEvents(this.$queueName(), {
        connection: this.$connection,
      });
      this.$events.on('active', ({ jobId }: any) =>
        this.$transformEvent(jobId, 'active')
      );
      this.$events.on('removed', ({ jobId }: any) =>
        this.$transformEvent(jobId, 'removed')
      );
      this.$events.on('progress', ({ jobId, data }: any) =>
        this.$transformEvent(jobId, 'progress', { progress: data })
      );
      this.$events.on('failed', ({ jobId }: any) =>
        this.$transformEvent(jobId, 'failed')
      );
      this.$events.on('error', ({ jobId }: any) =>
        this.$transformEvent(jobId, 'error')
      );
      this.$events.on('completed', ({ jobId }: any) =>
        this.$transformEvent(jobId, 'completed')
      );
      this.$events.on('drained', () => this.$transformEvent('drained'));
      this.$events.on('paused', () => this.$transformEvent('paused'));
      this.$events.on('resumed', () => this.$transformEvent('resumed'));
      this.$events.on('cleaned', (jobs: any[], type: string) =>
        this.$transformEvent(null, 'cleaned', {
          jobs: jobs.map(({ id }) => id),
          type,
        })
      );
    }
  },
  async stopped() {
    if (this.$worker) {
      await this.$worker.close();
    }
    if (this.$events) {
      await this.$events.close();
    }
    await Promise.all(
      Object.values(this.$queueResolved).map((queue: any) => queue.close())
    );
  },
  methods: {
    $queueName() {
      if (this.version != null && !(this.settings || {}).$noVersionPrefix) {
        return `v${this.version}.${this.name}`;
      }
      return this.name;
    },
    $resolve(name: string) {
      if (!this.$queueResolved[name]) {
        this.$queueResolved[name] = new Queue(name, {
          connection: this.$connection,
        });
      }
      return this.$queueResolved[name];
    },
    $getQueueData(ctx: Context, params: any = {}) {
      return {
        params,
        meta: ctx.meta,
        parentSpan: {
          id: ctx.parentID,
          traceID: ctx.requestID,
          sampled: ctx.tracing,
        },
      };
    },
    pause(name: string) {
      if (name) {
        return this.$resolve(name).pause();
      } else if (this.$worker) {
        return this.$worker.pause();
      }
    },
    resume(name: string) {
      if (name) {
        return this.$resolve(name).resume();
      } else if (this.$worker) {
        return this.$worker.resume();
      }
    },
    queue(
      ctx: Context,
      name: string,
      action: string,
      params: any,
      options: any = {}
    ) {
      return this.$resolve(name).add(
        action,
        this.$getQueueData(ctx, params),
        _.merge(this.settings.bullmq.job || {}, options)
      );
    },
    localQueue(ctx: Context, action: string, params: any, options?: any) {
      return this.queue(ctx, this.$queueName(), action, params, options);
    },
    job(name: string, id: string) {
      if (arguments.length === 1) {
        id = name;
        name = this.$queueName();
      }
      return this.$resolve(name).getJob(id);
    },
    async $populateJob(ctx: Context<{}, { job: any }>) {
      ctx.locals.job =
        ctx.meta && ctx.meta.job
          ? await this.job(ctx.meta.job.queue, ctx.meta.job.id)
          : undefined;
    },
    flow(
      ctx: Context,
      name: string,
      action: string,
      params: any,
      children: any[],
      options: any = {}
    ) {
      const convertItemToQueueItem = (item: any) => {
        return {
          name: item.action || action,
          queueName: item.name || name,
          data: this.$getQueueData(ctx, item.params),
          children: item?.children?.map?.(convertItemToQueueItem),
          opts: _.merge(this.settings.bullmq.job || {}, item.options || {}),
        };
      };

      const flowProducer = new FlowProducer({
        connection: this.$connection,
      });

      return flowProducer.add(
        convertItemToQueueItem({ params, name, action, children, options })
      );
    },
    async $transformEvent(id: string, type: string, params: any) {
      const event = arguments.length === 1 ? [id] : [type];
      let emitOpts: any = { meta: { job: { queue: this.$queueName() } } };
      if (arguments.length >= 2 && id) {
        const job = await this.job(id);
        if (job && job.name) {
          event.unshift(job.name);
          const { meta, parentSpan } = job.data;
          meta.job = { id: job.id, queue: this.$queueName() };
          emitOpts = { meta, parentSpan };
        }
        params = params || {};
        params.id = id;
      }
      const name = event.join('.');

      this.broker.emit(`${this.$queueName()}.${name}`, params, emitOpts);
      this.broker.emit(name, params, this.$queueName(), {
        ...emitOpts,
        groups: this.$queueName(),
      });
    },
  },
};
