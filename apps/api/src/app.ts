import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import {
  AccountsAuthorizationError,
  AccountsPersistenceError,
  AuthenticationError,
} from '@glint/api-accounts';
import {type Database, databaseErrorCode} from '@glint/node-database';
import {
  composeModules,
  type GlintCapabilityTypes,
  type GlintModule,
  selectCapabilities,
} from '@glint/node-module';
import type {BlobStore} from '@glint/node-object-store';
import {HealthRegistry, type StructuredLogger} from '@glint/node-observability';
import type {JobQueue} from '@glint/node-queue';
import Fastify, {type FastifyInstance} from 'fastify';

export interface ApiCapabilities extends GlintCapabilityTypes {
  readonly routes: (app: FastifyInstance) => Promise<void> | void;
  readonly auth: unknown;
  readonly publishers: unknown;
  readonly subscribers: unknown;
  readonly jobs: unknown;
  readonly metrics: () => void;
}

export async function createApiApp(options: {
  readonly blobStore: BlobStore;
  readonly database: Database;
  readonly modules?: readonly GlintModule<ApiCapabilities>[];
  readonly queue: JobQueue;
  readonly logger?: StructuredLogger;
  readonly browserSecurity?: {
    readonly allowedOrigins: readonly string[];
    readonly cookieSecret: string;
    readonly mutationPreflightHeader: string;
  };
}): Promise<FastifyInstance> {
  const app = Fastify({logger: false});
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthenticationError) {
      const statusCode =
        error.code === 'SESSION_EXPIRED'
          ? 401
          : error.code === 'REQUEST_CONTENT_TYPE_INVALID'
            ? 415
            : error.code === 'REQUEST_ORIGIN_INVALID' || error.code === 'REQUEST_PREFLIGHT_MISSING'
              ? 403
              : 400;
      return reply.code(statusCode).send({error: {code: error.code}});
    }
    if (error instanceof AccountsAuthorizationError) {
      const statusCode =
        error.code === 'IDENTITY_NOT_FOUND'
          ? 401
          : error.code === 'INSTALLATION_REQUIRED'
            ? 409
            : error.code === 'PROVIDER_TIMEOUT' ||
                error.code === 'PROVIDER_RATE_LIMITED' ||
                error.code === 'PROVIDER_MALFORMED_RESPONSE' ||
                error.code === 'INSTALLATION_UNAVAILABLE'
              ? 503
              : 403;
      return reply.code(statusCode).send({error: {code: error.code}});
    }
    if (error instanceof AccountsPersistenceError || databaseErrorCode(error) === '42501') {
      options.logger?.error('Database authorization denied.', {
        error: error instanceof Error ? error.message : String(error),
        method: request.method,
        url: request.url,
      });
      return reply.code(503).send({error: {code: 'INTERNAL'}});
    }
    if (typeof error === 'object' && error !== null && 'statusCode' in error) {
      const statusCode = Reflect.get(error, 'statusCode');
      if (typeof statusCode === 'number') return reply.code(statusCode).send(error);
    }
    options.logger?.error('Unhandled API request error.', {
      error: error instanceof Error ? error.message : String(error),
      method: request.method,
      url: request.url,
    });
    return reply.code(500).send({error: {code: 'INTERNAL'}});
  });
  await app.register(fastifyCookie, {
    ...(options.browserSecurity ? {secret: options.browserSecurity.cookieSecret} : {}),
  });
  if (options.browserSecurity) {
    await app.register(fastifyCors, {
      allowedHeaders: ['content-type', options.browserSecurity.mutationPreflightHeader],
      credentials: true,
      origin: [...options.browserSecurity.allowedOrigins],
    });
  }
  // Logout mutations are JSON-gated but intentionally accept no request body.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', {parseAs: 'string'}, (_request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString();
    if (text.trim().length === 0) return done(null, {});
    try {
      return done(null, JSON.parse(text));
    } catch (error) {
      return done(error as Error);
    }
  });
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

  app.get('/live', (_request, reply) => {
    const report = health.liveness();
    return reply.code(report.status === 'live' ? 200 : 503).send(report);
  });
  app.get('/ready', async (_request, reply) => {
    const report = await health.readiness();
    return reply.code(report.status === 'ready' ? 200 : 503).send(report);
  });

  const composition = composeModules(options.modules ?? []);
  const capabilities = selectCapabilities(composition, ['routes', 'auth', 'metrics']);
  for (const route of capabilities.routes) await route.value(app);
  for (const metric of capabilities.metrics) metric.value();
  void capabilities.auth;
  return app;
}
