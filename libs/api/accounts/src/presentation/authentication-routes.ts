import type {AuthErrorCode} from '@glint/api-accounts-dto';
import '@fastify/cookie';
import type {FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler} from 'fastify';
import {AuthenticationError} from '../core/authentication-error.js';
import type {AuthenticationService, AuthModuleConfig} from '../core/authentication-service.js';
import type {AuthorizationService} from '../core/authorization-service.js';
import type {Session} from '../core/types.js';
import {accountNamespaceRepresentation} from './account-representations.js';

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
  }
}

function preAuthCookieName(config: AuthModuleConfig): string {
  return `${config.cookieSecure ? '__Host-' : ''}${config.cookieName}-oauth-state`;
}

export function sessionCookieName(config: AuthModuleConfig): string {
  return `${config.cookieSecure ? '__Host-' : ''}${config.cookieName}`;
}

function cookieOptions(config: AuthModuleConfig, maxAge: number) {
  return {
    httpOnly: true,
    maxAge,
    path: '/',
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
  };
}

function sessionMaxAge(session: Session): number {
  return Math.max(
    0,
    Math.floor(
      (Math.min(session.absoluteExpiresAt.getTime(), session.inactivityExpiresAt.getTime()) -
        session.lastSeenAt.getTime()) /
        1_000,
    ),
  );
}

function readQuery(request: FastifyRequest, key: string): string | undefined {
  const query = request.query;
  if (!query || typeof query !== 'object') return undefined;
  const value = Reflect.get(query, key);
  return typeof value === 'string' ? value : undefined;
}

function callbackFailure(reply: FastifyReply, config: AuthModuleConfig, code: AuthErrorCode) {
  const destination = new URL('/login', config.webAppUrl);
  destination.searchParams.set('error', code);
  return reply.redirect(destination.toString());
}

export function mutationGuard(config: AuthModuleConfig): preHandlerHookHandler {
  const origins = new Set(config.allowedOrigins);
  const requiredHeader = config.mutationPreflightHeader.toLowerCase();
  return (request) => {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !origins.has(origin)) {
      throw new AuthenticationError('REQUEST_ORIGIN_INVALID');
    }
    const contentType = request.headers['content-type'];
    if (
      typeof contentType !== 'string' ||
      !contentType.toLowerCase().startsWith('application/json')
    ) {
      throw new AuthenticationError('REQUEST_CONTENT_TYPE_INVALID');
    }
    if (!(requiredHeader in request.headers)) {
      throw new AuthenticationError('REQUEST_PREFLIGHT_MISSING');
    }
    return Promise.resolve();
  };
}

/** Shared session pre-handler for later authenticated feature routes. */
export function requireSession(
  service: AuthenticationService,
  cookieName: string,
): preHandlerHookHandler {
  return async (request) => {
    const token = request.cookies[cookieName];
    request.session = await service.resolveSession({...(token ? {token} : {})});
  };
}

export function attachSessionCookie(
  reply: FastifyReply,
  config: AuthModuleConfig,
  token: string,
  session: Session,
): void {
  reply.setCookie(sessionCookieName(config), token, cookieOptions(config, sessionMaxAge(session)));
}

export function registerAuthenticationRoutes(
  app: FastifyInstance,
  options: {
    readonly authorizationService?: AuthorizationService;
    readonly config: AuthModuleConfig;
    readonly reportUnexpectedError?: (error: unknown) => void;
    readonly service: AuthenticationService;
  },
): void {
  const {config, service} = options;
  const guard = mutationGuard(config);
  const sessionRequired = async (request: FastifyRequest) => {
    const token = request.cookies[sessionCookieName(config)];
    request.session = await service.resolveSession({...(token ? {token} : {})});
  };
  const stateCookie = preAuthCookieName(config);

  app.get('/api/v1/auth/github/start', async (request, reply) => {
    const returnTo = readQuery(request, 'return_to');
    const started = await service.startLogin({...(returnTo ? {returnTo} : {})});
    reply.setCookie(stateCookie, started.state, {
      ...cookieOptions(config, config.attemptTtlSeconds),
      signed: true,
    });
    return reply.redirect(started.authorizeUrl);
  });

  app.get('/api/v1/auth/github/callback', async (request, reply) => {
    const signedCookie = request.cookies[stateCookie];
    const unsignedCookie = signedCookie ? request.unsignCookie(signedCookie) : undefined;
    const preAuthCookieState = unsignedCookie?.valid ? unsignedCookie.value : undefined;
    reply.clearCookie(stateCookie, cookieOptions(config, 0));
    try {
      const code = readQuery(request, 'code');
      const errorParam = readQuery(request, 'error');
      const state = readQuery(request, 'state');
      const result = await service.completeCallback({
        ...(code ? {code} : {}),
        ...(errorParam ? {errorParam} : {}),
        ...(preAuthCookieState ? {preAuthCookieState} : {}),
        ...(state ? {state} : {}),
      });
      attachSessionCookie(reply, config, result.token, result.session);
      return reply.redirect(result.returnLocation);
    } catch (error) {
      if (!(error instanceof AuthenticationError)) options.reportUnexpectedError?.(error);
      const code =
        error instanceof AuthenticationError ? error.code : 'IDENTITY_PROVIDER_UNAVAILABLE';
      return callbackFailure(reply, config, code);
    }
  });

  app.get('/api/v1/session', {preHandler: sessionRequired}, async (request, reply) => {
    const session = request.session;
    if (!session) throw new AuthenticationError('SESSION_EXPIRED');
    const identity = await service.findIdentity(session.identityId);
    if (!identity) throw new AuthenticationError('SESSION_EXPIRED');
    const token = request.cookies[sessionCookieName(config)];
    if (token) attachSessionCookie(reply, config, token, session);
    const accounts = await options.authorizationService?.listAccessibleAccounts({
      identityId: session.identityId,
    });
    return {
      session: {
        id: session.id,
        identityId: session.identityId,
        expiresAt: new Date(
          Math.min(session.absoluteExpiresAt.getTime(), session.inactivityExpiresAt.getTime()),
        ).toISOString(),
      },
      identity,
      accounts: (accounts ?? []).map(({account, membership}) => ({
        id: account.id,
        namespace: accountNamespaceRepresentation(account),
        slug: account.slug,
        displayName: account.displayName,
        role: membership.role,
        state: account.state,
        ...(membership.verifiedAt ? {verifiedAt: membership.verifiedAt.toISOString()} : {}),
        ...(membership.leaseExpiresAt
          ? {leaseExpiresAt: membership.leaseExpiresAt.toISOString()}
          : {}),
      })),
    };
  });

  app.post(
    '/api/v1/session/logout',
    {preHandler: [guard, sessionRequired]},
    async (request, reply) => {
      const session = request.session;
      if (!session) throw new AuthenticationError('SESSION_EXPIRED');
      await service.logout({sessionId: session.id});
      reply.clearCookie(sessionCookieName(config), cookieOptions(config, 0));
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/v1/session/logout-all',
    {preHandler: [guard, sessionRequired]},
    async (request, reply) => {
      const session = request.session;
      if (!session) throw new AuthenticationError('SESSION_EXPIRED');
      await service.logoutAll({identityId: session.identityId});
      reply.clearCookie(sessionCookieName(config), cookieOptions(config, 0));
      return reply.code(204).send();
    },
  );
}
