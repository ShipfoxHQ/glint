import type {Database} from '@glint/node-database';
import {
  composeModules,
  type GlintCapabilityTypes,
  type GlintModule,
  selectCapabilities,
} from '@glint/node-module';
import type {BlobStore} from '@glint/node-object-store';
import {HealthRegistry} from '@glint/node-observability';
import type {JobQueue} from '@glint/node-queue';
import Fastify, {type FastifyInstance} from 'fastify';

export interface WorkerCapabilities extends GlintCapabilityTypes {
  readonly routes: unknown;
  readonly auth: unknown;
  readonly publishers: unknown;
  readonly subscribers: unknown;
  readonly jobs: () => Promise<void> | void;
  readonly metrics: () => void;
}

export async function createWorkerApp(options: {
  readonly blobStore: BlobStore;
  readonly database: Database;
  readonly modules?: readonly GlintModule<WorkerCapabilities>[];
  readonly odiffReady: () => Promise<void> | void;
  readonly queue: JobQueue;
}): Promise<FastifyInstance> {
  const app = Fastify({logger: false});
  const health = new HealthRegistry();
  health.registerReadinessCheck({
    name: 'database',
    check: async () => {
      const status = await options.database.health();
      if (status.status !== 'ready') throw new Error(status.detail ?? 'Database is unavailable.');
    },
  });
  health.registerReadinessCheck({
    name: 'object-store',
    check: async () => {
      const status = await options.blobStore.health();
      if (status.status !== 'ready')
        throw new Error(status.detail ?? 'Object store is unavailable.');
    },
  });
  health.registerReadinessCheck({
    name: 'queue',
    check: async () => {
      const status = await options.queue.health();
      if (status.status !== 'ready') throw new Error(status.detail ?? 'Queue is unavailable.');
    },
  });
  health.registerReadinessCheck({name: 'odiff-4.3.8', check: options.odiffReady});

  app.get('/live', (_request, reply) => {
    const report = health.liveness();
    return reply.code(report.status === 'live' ? 200 : 503).send(report);
  });
  app.get('/ready', async (_request, reply) => {
    const report = await health.readiness();
    return reply.code(report.status === 'ready' ? 200 : 503).send(report);
  });

  const composition = composeModules(options.modules ?? []);
  const capabilities = selectCapabilities(composition, ['jobs', 'subscribers', 'metrics']);
  for (const job of capabilities.jobs) await job.value();
  for (const metric of capabilities.metrics) metric.value();
  void capabilities.subscribers;
  return app;
}
