import type {VcsIdentityProvider} from '@glint/api-vcs-core';
import type {Database, DatabaseTransaction} from '@glint/node-database';
import {describe, expect, it, vi} from '@shipfox/vitest/vi';
import {AuthenticationError} from './authentication-error.js';
import {type AuthModuleConfig, createAuthenticationService} from './authentication-service.js';
import type {
  OAuthAttemptRepository,
  ProviderIdentityRepository,
  SessionRepository,
} from './ports.js';
import type {Session} from './types.js';

const config: AuthModuleConfig = {
  absoluteTtlSeconds: 2_592_000,
  allowedOrigins: ['https://app.glint.test'],
  attemptTtlSeconds: 600,
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  callbackUrl: 'https://api.glint.test/api/v1/auth/github/callback',
  clientId: 'client',
  cookieName: 'glint_session',
  cookieSecure: true,
  environment: 'test',
  inactivityTtlSeconds: 604_800,
  mutationPreflightHeader: 'x-glint-csrf',
  oauthScopes: 'read:user',
  sessionTokenSecret: 'secret',
  webAppUrl: 'https://app.glint.test',
};

const now = new Date('2030-01-01T00:00:00.000Z');
const activeSession: Session = {
  id: 'old-session',
  identityId: 'identity',
  tokenDigest: 'digest',
  createdAt: now,
  lastSeenAt: now,
  absoluteExpiresAt: new Date('2030-02-01T00:00:00.000Z'),
  inactivityExpiresAt: new Date('2030-01-08T00:00:00.000Z'),
  updatedAt: now,
};

function fixture(overrides: Partial<SessionRepository> = {}) {
  const transaction = {id: 'transaction'} as DatabaseTransaction;
  const database: Database = {
    health: () => Promise.resolve({status: 'ready', checkedAtMs: 0}),
    transaction: (operation) => operation(transaction),
  };
  const sessions: SessionRepository = {
    create: vi.fn(() => Promise.resolve({...activeSession, id: 'new-session'})),
    findByTokenDigest: vi.fn(() => Promise.resolve(undefined)),
    revoke: vi.fn(() => Promise.resolve()),
    revokeAllForIdentity: vi.fn(() => Promise.resolve()),
    touch: vi.fn(() => Promise.resolve(undefined)),
    touchByTokenDigest: vi.fn(() => Promise.resolve(activeSession)),
    ...overrides,
  };
  const oauthAttempts: OAuthAttemptRepository = {
    create: vi.fn(),
    consumeByStateDigest: vi.fn(() => Promise.resolve(undefined)),
  };
  const providerIdentities: ProviderIdentityRepository = {
    findById: vi.fn(() => Promise.resolve(undefined)),
    upsertByProviderUser: vi.fn(),
  };
  const identityProvider: VcsIdentityProvider = {
    provider: 'github',
    exchangeAuthorization: vi.fn(),
    getIdentity: vi.fn(),
    listAuthorizedInstallations: vi.fn(),
  };
  return {
    service: createAuthenticationService({
      clock: () => now,
      config,
      database,
      identityProvider,
      oauthAttempts,
      providerIdentities,
      sessions,
    }),
    sessions,
  };
}

describe('authentication service', () => {
  it('rejects missing sessions without touching persistence', async () => {
    const {service, sessions} = fixture();
    await expect(service.resolveSession({})).rejects.toMatchObject({code: 'SESSION_EXPIRED'});
    expect(sessions.touchByTokenDigest).not.toHaveBeenCalled();
  });

  it('rejects callbacks whose state is not bound to the initiating browser', async () => {
    const {service} = fixture();
    await expect(
      service.completeCallback({
        code: 'code',
        state: 'query-state',
        preAuthCookieState: 'other-state',
      }),
    ).rejects.toEqual(expect.any(AuthenticationError));
  });

  it('rotates by creating and revoking inside one database transaction', async () => {
    const {service, sessions} = fixture();
    const result = await service.rotateSession({token: 'old-token'});
    expect(result.session.id).toBe('new-session');
    expect(sessions.create).toHaveBeenCalledTimes(1);
    expect(sessions.revoke).toHaveBeenCalledWith(
      expect.objectContaining({id: 'transaction'}),
      'old-session',
      now,
    );
  });
});
