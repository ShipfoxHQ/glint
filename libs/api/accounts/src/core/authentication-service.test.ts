import {
  VcsAccessRevocationError,
  type VcsIdentityProvider,
  VcsTimeoutError,
} from '@glint/api-vcs-core';
import type {Database, DatabaseTransaction} from '@glint/node-database';
import {describe, expect, it, vi} from '@shipfox/vitest/vi';
import {AuthenticationError} from './authentication-error.js';
import {type AuthModuleConfig, createAuthenticationService} from './authentication-service.js';
import type {
  OAuthAttemptRepository,
  ProviderIdentityRepository,
  SessionRepository,
} from './ports.js';
import type {OAuthAttempt, ProviderIdentity, Session} from './types.js';

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
const activeAttempt: OAuthAttempt = {
  id: 'attempt',
  stateDigest: 'digest',
  pkceVerifier: 'pkce-verifier',
  returnLocation: '/accounts',
  environment: 'test',
  expiresAt: new Date('2030-01-01T00:10:00.000Z'),
};
const providerIdentity: ProviderIdentity = {
  id: 'identity',
  provider: 'github',
  providerUserId: 'provider-user',
  login: 'octocat',
  createdAt: now,
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
    revoke: vi.fn(() => Promise.resolve()),
    revokeAllForIdentity: vi.fn(() => Promise.resolve()),
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
    oauthAttempts,
    providerIdentities,
    identityProvider,
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

  it('creates a session after a valid OAuth callback', async () => {
    const {service, identityProvider, oauthAttempts, providerIdentities, sessions} = fixture();
    vi.mocked(oauthAttempts.consumeByStateDigest).mockResolvedValue(activeAttempt);
    vi.mocked(identityProvider.exchangeAuthorization).mockResolvedValue({
      credential: {} as never,
      identity: {
        id: 'provider-user',
        provider: 'github',
        login: 'octocat',
        displayName: 'The Octocat',
        avatarUrl: 'https://avatars.example.test/octocat.png',
      },
    });
    vi.mocked(providerIdentities.upsertByProviderUser).mockResolvedValue(providerIdentity);

    await expect(
      service.completeCallback({
        code: 'authorization-code',
        state: 'state',
        preAuthCookieState: 'state',
      }),
    ).resolves.toMatchObject({returnLocation: '/accounts', session: {id: 'new-session'}});

    expect(identityProvider.exchangeAuthorization).toHaveBeenCalledWith({
      authorizationCode: 'authorization-code',
      codeVerifier: activeAttempt.pkceVerifier,
      redirectUri: config.callbackUrl,
    });
    expect(providerIdentities.upsertByProviderUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: 'github',
        providerUserId: 'provider-user',
        login: 'octocat',
      }),
    );
    expect(sessions.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({identityId: providerIdentity.id}),
    );
  });

  it('maps an OAuth denial to a stable authentication error', async () => {
    const {service} = fixture();
    await expect(service.completeCallback({errorParam: 'access_denied'})).rejects.toMatchObject({
      code: 'OAUTH_ACCESS_DENIED',
    });
  });

  it('rejects expired or replayed OAuth attempts', async () => {
    const {service, oauthAttempts} = fixture();
    vi.mocked(oauthAttempts.consumeByStateDigest).mockResolvedValue(undefined);
    await expect(
      service.completeCallback({code: 'code', state: 'state', preAuthCookieState: 'state'}),
    ).rejects.toMatchObject({code: 'OAUTH_STATE_INVALID'});
  });

  it('rejects attempts created in a different environment', async () => {
    const {service, oauthAttempts} = fixture();
    vi.mocked(oauthAttempts.consumeByStateDigest).mockResolvedValue({
      ...activeAttempt,
      environment: 'production',
    });
    await expect(
      service.completeCallback({code: 'code', state: 'state', preAuthCookieState: 'state'}),
    ).rejects.toMatchObject({code: 'OAUTH_STATE_INVALID'});
  });

  it('maps provider authorization failures without leaking provider details', async () => {
    for (const [error, code] of [
      [new VcsAccessRevocationError(), 'OAUTH_EXCHANGE_FAILED'],
      [new VcsTimeoutError(), 'IDENTITY_PROVIDER_UNAVAILABLE'],
    ] as const) {
      const {service, identityProvider, oauthAttempts} = fixture();
      vi.mocked(oauthAttempts.consumeByStateDigest).mockResolvedValue(activeAttempt);
      vi.mocked(identityProvider.exchangeAuthorization).mockRejectedValue(error);
      await expect(
        service.completeCallback({code: 'code', state: 'state', preAuthCookieState: 'state'}),
      ).rejects.toMatchObject({code});
    }
  });

  it('rejects a present token when the atomic touch finds no active session', async () => {
    const {service, sessions} = fixture({
      touchByTokenDigest: vi.fn(() => Promise.resolve(undefined)),
    });
    await expect(service.resolveSession({token: 'expired-token'})).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    expect(sessions.touchByTokenDigest).toHaveBeenCalledTimes(1);
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

  it('revokes either the current session or all sessions for an identity', async () => {
    const {service, sessions} = fixture();
    await service.logout({sessionId: activeSession.id});
    await service.logoutAll({identityId: activeSession.identityId});
    expect(sessions.revoke).toHaveBeenCalledWith(expect.anything(), activeSession.id, now);
    expect(sessions.revokeAllForIdentity).toHaveBeenCalledWith(
      expect.anything(),
      activeSession.identityId,
      now,
    );
  });
});
