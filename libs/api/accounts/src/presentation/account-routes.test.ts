import fastifyCookie from '@fastify/cookie';
import type {Database, DatabaseTransaction} from '@glint/node-database';
import {describe, expect, it, vi} from '@shipfox/vitest/vi';
import Fastify from 'fastify';
import type {AuthenticationService, AuthModuleConfig} from '../core/authentication-service.js';
import type {AuthorizationService} from '../core/authorization-service.js';
import type {AccountRepository, InstallationRepository} from '../core/ports.js';
import type {Account, Installation, Session} from '../core/types.js';
import {registerAccountRoutes} from './account-routes.js';

const now = new Date('2030-01-01T00:00:00.000Z');
const config: AuthModuleConfig = {
  authorizationLeaseTtlSeconds: 900,
  absoluteTtlSeconds: 2_592_000,
  allowedOrigins: ['https://app.glint.test'],
  attemptTtlSeconds: 600,
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  callbackUrl: 'https://api.glint.test/api/v1/auth/github/callback',
  clientId: 'client',
  cookieName: 'glint_session',
  cookieSecure: false,
  environment: 'test',
  inactivityTtlSeconds: 604_800,
  mutationPreflightHeader: 'x-glint-csrf',
  oauthScopes: 'read:user',
  sessionTokenSecret: 'secret',
  webAppUrl: 'https://app.glint.test',
};
const session: Session = {
  id: 'session',
  identityId: 'identity',
  tokenDigest: 'digest',
  createdAt: now,
  lastSeenAt: now,
  absoluteExpiresAt: new Date('2030-02-01T00:00:00.000Z'),
  inactivityExpiresAt: new Date('2030-01-08T00:00:00.000Z'),
  updatedAt: now,
};
const account: Account = {
  id: 'account',
  provider: 'github',
  providerNamespaceId: 'namespace',
  namespaceKind: 'organization',
  slug: 'glint',
  displayName: 'Glint',
  state: 'active',
  createdAt: now,
  updatedAt: now,
};
const installation: Installation = {
  id: 'installation',
  accountId: account.id,
  provider: 'github',
  providerInstallationId: 'provider-installation',
  state: 'active',
  repositorySelection: 'all',
  installedAt: now,
};

function fixture() {
  const transaction = {id: 'transaction'} as DatabaseTransaction;
  const database: Database = {
    health: () => Promise.resolve({status: 'ready', checkedAtMs: 0}),
    transaction: (operation) => operation(transaction),
  };
  const authenticationService: AuthenticationService = {
    startLogin: vi.fn(),
    completeCallback: vi.fn(),
    resolveSession: vi.fn(() => Promise.resolve(session)),
    findIdentity: vi.fn(),
    rotateSession: vi.fn(() => Promise.resolve({session, token: 'rotated-token'})),
    logout: vi.fn(),
    logoutAll: vi.fn(),
  };
  const authorizationService: AuthorizationService = {
    authorizeAccountAccess: vi.fn(() =>
      Promise.resolve({
        accountId: account.id,
        identityId: session.identityId,
        role: 'owner' as const,
        verifiedAt: now,
        leaseExpiresAt: new Date('2030-01-01T00:15:00.000Z'),
      }),
    ),
    listAccessibleAccounts: vi.fn(() =>
      Promise.resolve([
        {
          account,
          membership: {
            id: 'membership',
            accountId: account.id,
            identityId: session.identityId,
            role: 'owner' as const,
            state: 'active' as const,
            verifiedAt: now,
            leaseExpiresAt: new Date('2030-01-01T00:15:00.000Z'),
          },
        },
      ]),
    ),
  };
  const accounts: AccountRepository = {
    findById: vi.fn(() => Promise.resolve(account)),
    listSummariesForIdentity: vi.fn(),
    upsertByProviderNamespace: vi.fn(),
  };
  const installations: InstallationRepository = {
    findCurrentForAccount: vi.fn(() => Promise.resolve(installation)),
    linkCurrent: vi.fn(),
    setState: vi.fn(),
  };
  return {accounts, authenticationService, authorizationService, database, installations};
}

describe('account routes', () => {
  it('lists active access and protects account detail reads', async () => {
    const options = fixture();
    const app = Fastify();
    await app.register(fastifyCookie);
    registerAccountRoutes(app, {...options, config});
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/accounts',
      cookies: {glint_session: 'opaque'},
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({accounts: [{id: account.id, role: 'owner'}]});

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/accounts/${account.id}`,
      cookies: {glint_session: 'opaque'},
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({id: account.id, installation: {state: 'active'}});
    expect(options.authorizationService.authorizeAccountAccess).toHaveBeenCalledWith(
      expect.objectContaining({action: 'read', accountId: account.id}),
    );
    await app.close();
  });

  it('forces authorization before rotating a session and rejects malformed refresh bodies', async () => {
    const options = fixture();
    const app = Fastify();
    await app.register(fastifyCookie);
    registerAccountRoutes(app, {...options, config});
    const headers = {
      origin: 'https://app.glint.test',
      'content-type': 'application/json',
      'x-glint-csrf': '1',
    };
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/session/refresh',
      cookies: {glint_session: 'opaque'},
      headers,
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/session/refresh',
      cookies: {glint_session: 'opaque'},
      headers,
      payload: {account_id: account.id},
    });
    expect(refresh.statusCode).toBe(200);
    expect(options.authorizationService.authorizeAccountAccess).toHaveBeenCalledWith({
      action: 'read',
      accountId: account.id,
      forceRefresh: true,
      identityId: session.identityId,
    });
    expect(options.authenticationService.rotateSession).toHaveBeenCalledWith({token: 'opaque'});
    await app.close();
  });
});
