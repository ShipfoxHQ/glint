import fastifyCookie from '@fastify/cookie';
import {describe, expect, it} from '@shipfox/vitest/vi';
import Fastify from 'fastify';
import type {AuthenticationService, AuthModuleConfig} from '../core/authentication-service.js';
import {registerAuthenticationRoutes} from './authentication-routes.js';

const config: AuthModuleConfig = {
  absoluteTtlSeconds: 2_592_000,
  allowedOrigins: ['https://app.glint.test'],
  attemptTtlSeconds: 600,
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  callbackUrl: 'https://api.glint.test/api/v1/auth/github/callback',
  clientId: 'client-id',
  cookieName: 'glint_session',
  cookieSecure: true,
  environment: 'test',
  inactivityTtlSeconds: 604_800,
  mutationPreflightHeader: 'x-glint-csrf',
  oauthScopes: 'read:user',
  sessionTokenSecret: 'test-secret',
  webAppUrl: 'https://app.glint.test',
};

function service(): AuthenticationService {
  return {
    startLogin: () =>
      Promise.resolve({
        authorizeUrl: 'https://github.com/login/oauth/authorize?state=state-value',
        state: 'state-value',
      }),
    completeCallback: () =>
      Promise.resolve({
        returnLocation: 'https://app.glint.test/projects',
        session: {
          id: 'session-1',
          identityId: 'identity-1',
          tokenDigest: 'digest',
          createdAt: new Date('2030-01-01T00:00:00.000Z'),
          lastSeenAt: new Date('2030-01-01T00:00:00.000Z'),
          absoluteExpiresAt: new Date('2030-02-01T00:00:00.000Z'),
          inactivityExpiresAt: new Date('2030-01-08T00:00:00.000Z'),
          updatedAt: new Date('2030-01-01T00:00:00.000Z'),
        },
        token: 'opaque-token',
      }),
    resolveSession: () => Promise.reject(new Error('not used in this test')),
    findIdentity: () => Promise.resolve(undefined),
    rotateSession: () => Promise.reject(new Error('not used in this test')),
    logout: () => Promise.resolve(),
    logoutAll: () => Promise.resolve(),
  };
}

describe('authentication routes', () => {
  it('starts OAuth with a signed host-only state cookie and completes with a session cookie', async () => {
    const app = Fastify();
    await app.register(fastifyCookie, {secret: config.sessionTokenSecret});
    registerAuthenticationRoutes(app, {config, service: service()});

    const start = await app.inject({method: 'GET', url: '/api/v1/auth/github/start'});
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toContain('state=state-value');
    expect(start.headers['set-cookie']).toContain('__Host-glint_session-oauth-state=');
    expect(start.headers['set-cookie']).toContain('HttpOnly');
    expect(start.headers['set-cookie']).toContain('Secure');

    const callback = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/callback?state=state-value&code=code',
      headers: {cookie: start.headers['set-cookie'] ?? ''},
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('https://app.glint.test/projects');
    const callbackCookies = Array.isArray(callback.headers['set-cookie'])
      ? callback.headers['set-cookie']
      : [callback.headers['set-cookie']];
    expect(
      callbackCookies.some((cookie) => cookie?.includes('__Host-glint_session=opaque-token')),
    ).toBe(true);
    expect(callbackCookies.some((cookie) => cookie?.includes('SameSite=Lax'))).toBe(true);
    expect(callbackCookies.some((cookie) => cookie?.includes('Domain='))).toBe(false);
    await app.close();
  });
});
