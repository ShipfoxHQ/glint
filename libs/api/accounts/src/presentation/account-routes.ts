import type {Database} from '@glint/node-database';
import type {FastifyInstance, FastifyRequest} from 'fastify';
import {AuthenticationError} from '../core/authentication-error.js';
import type {AuthenticationService, AuthModuleConfig} from '../core/authentication-service.js';
import {AccountsAuthorizationError} from '../core/authorization-error.js';
import type {AuthorizationService} from '../core/authorization-service.js';
import type {AccountRepository, InstallationRepository} from '../core/ports.js';
import type {Account, Installation, MembershipProjection} from '../core/types.js';
import {accountNamespaceRepresentation} from './account-representations.js';
import {
  attachSessionCookie,
  mutationGuard,
  requireSession,
  sessionCookieName,
} from './authentication-routes.js';
import {requireCurrentNamespaceAccess} from './authorization-guards.js';

declare module 'fastify' {
  interface FastifyRequest {
    access?: import('../core/authorization-service.js').AuthorizedAccess;
  }
}

function summary(account: Account, membership: MembershipProjection) {
  return {
    id: account.id,
    namespace: accountNamespaceRepresentation(account),
    slug: account.slug,
    displayName: account.displayName,
    role: membership.role,
    state: account.state,
    ...(membership.verifiedAt ? {verifiedAt: membership.verifiedAt.toISOString()} : {}),
    ...(membership.leaseExpiresAt ? {leaseExpiresAt: membership.leaseExpiresAt.toISOString()} : {}),
  };
}

function detail(account: Account, installation: Installation | undefined) {
  return {
    id: account.id,
    namespace: accountNamespaceRepresentation(account),
    state: account.state,
    ...(installation
      ? {
          installation: {
            id: installation.providerInstallationId,
            provider: installation.provider,
            namespaceId: account.providerNamespaceId,
            state: installation.state,
            repositorySelection: installation.repositorySelection,
          },
        }
      : {}),
  };
}

function requestAccountId(request: FastifyRequest): string {
  const params = request.params;
  const accountId =
    params && typeof params === 'object' ? Reflect.get(params, 'accountId') : undefined;
  if (typeof accountId !== 'string') throw new AccountsAuthorizationError('ACCOUNT_ACCESS_REVOKED');
  return accountId;
}

function refreshAccountId(request: FastifyRequest): string | undefined {
  const body = request.body;
  if (!body || typeof body !== 'object') return undefined;
  const accountId = Reflect.get(body, 'account_id');
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
}

export function registerAccountRoutes(
  app: FastifyInstance,
  options: {
    readonly accounts: AccountRepository;
    readonly authenticationService: AuthenticationService;
    readonly authorizationService: AuthorizationService;
    readonly config: AuthModuleConfig;
    readonly database: Database;
    readonly installations: InstallationRepository;
  },
): void {
  const sessionRequired = requireSession(
    options.authenticationService,
    sessionCookieName(options.config),
  );
  const currentAccess = requireCurrentNamespaceAccess({
    authenticationService: options.authenticationService,
    authorizationService: options.authorizationService,
    config: options.config,
  });

  app.get('/api/v1/accounts', {preHandler: sessionRequired}, async (request) => {
    const session = request.session;
    if (!session) throw new AuthenticationError('SESSION_EXPIRED');
    const accounts = await options.authorizationService.listAccessibleAccounts({
      identityId: session.identityId,
    });
    return {accounts: accounts.map(({account, membership}) => summary(account, membership))};
  });

  app.get('/api/v1/accounts/:accountId', {preHandler: currentAccess}, async (request) => {
    const accountId = requestAccountId(request);
    const result = await options.database.transaction(
      async (transaction) => {
        const [account, installation] = await Promise.all([
          options.accounts.findById(transaction, accountId),
          options.installations.findCurrentForAccount(transaction),
        ]);
        return {account, installation};
      },
      {tenant: {accountId}},
    );
    if (!result.account) throw new AccountsAuthorizationError('ACCOUNT_ACCESS_REVOKED');
    if (!result.installation) throw new AccountsAuthorizationError('INSTALLATION_REQUIRED');
    if (result.installation.state !== 'active') {
      throw new AccountsAuthorizationError('INSTALLATION_UNAVAILABLE');
    }
    return detail(result.account, result.installation);
  });

  app.post(
    '/api/v1/session/refresh',
    {preHandler: [mutationGuard(options.config), sessionRequired]},
    async (request, reply) => {
      const session = request.session;
      if (!session) throw new AuthenticationError('SESSION_EXPIRED');
      const accountId = refreshAccountId(request);
      if (!accountId) return reply.code(400).send({error: {code: 'BAD_REQUEST'}});
      await options.authorizationService.authorizeAccountAccess({
        action: 'read',
        accountId,
        forceRefresh: true,
        identityId: session.identityId,
      });
      const token = request.cookies[sessionCookieName(options.config)];
      if (!token) throw new AuthenticationError('SESSION_EXPIRED');
      const rotated = await options.authenticationService.rotateSession({token});
      attachSessionCookie(reply, options.config, rotated.token, rotated.session);
      return {
        session: {
          id: rotated.session.id,
          identityId: rotated.session.identityId,
          expiresAt: new Date(
            Math.min(
              rotated.session.absoluteExpiresAt.getTime(),
              rotated.session.inactivityExpiresAt.getTime(),
            ),
          ).toISOString(),
        },
      };
    },
  );
}
