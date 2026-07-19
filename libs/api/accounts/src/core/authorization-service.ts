import {
  classifyVcsProviderError,
  type VcsAccessLevel,
  type VcsNamespaceAccess,
  type VcsNamespaceAccessProvider,
} from '@glint/api-vcs-core';
import type {Database} from '@glint/node-database';
import {AccountsAuthorizationError} from './authorization-error.js';
import type {
  AccountRepository,
  MembershipProjectionRepository,
  ProviderIdentityRepository,
} from './ports.js';
import type {Account, MembershipProjection} from './types.js';

export interface AuthorizedAccess {
  readonly accountId: string;
  readonly identityId: string;
  readonly leaseExpiresAt?: Date;
  readonly role: 'owner' | 'reviewer';
  readonly verifiedAt?: Date;
}

export interface AccessibleAccount {
  readonly account: Account;
  readonly membership: MembershipProjection;
}

export interface AuthorizationService {
  authorizeAccountAccess(input: {
    readonly action: 'read' | 'owner-mutation';
    readonly accountId: string;
    readonly forceRefresh?: boolean;
    readonly identityId: string;
  }): Promise<AuthorizedAccess>;
  listAccessibleAccounts(input: {
    readonly identityId: string;
  }): Promise<readonly AccessibleAccount[]>;
}

function plusSeconds(now: Date, seconds: number): Date {
  return new Date(now.getTime() + seconds * 1_000);
}

function toAuthorizedAccess(membership: MembershipProjection): AuthorizedAccess {
  if (membership.role !== 'owner' && membership.role !== 'reviewer') {
    throw new AccountsAuthorizationError('ACCOUNT_ACCESS_REVOKED');
  }
  return {
    accountId: membership.accountId,
    identityId: membership.identityId,
    ...(membership.verifiedAt ? {verifiedAt: membership.verifiedAt} : {}),
    ...(membership.leaseExpiresAt ? {leaseExpiresAt: membership.leaseExpiresAt} : {}),
    role: membership.role,
  };
}

function roleForAccess(level: VcsAccessLevel): 'owner' | 'reviewer' | undefined {
  return level === 'owner' ? 'owner' : level === 'member' ? 'reviewer' : undefined;
}

function mapProviderError(error: unknown): AccountsAuthorizationError {
  switch (classifyVcsProviderError(error)) {
    case 'timeout':
      return new AccountsAuthorizationError('PROVIDER_TIMEOUT');
    case 'rate_limit':
      return new AccountsAuthorizationError('PROVIDER_RATE_LIMITED');
    case 'missing_installation':
      return new AccountsAuthorizationError('INSTALLATION_UNAVAILABLE');
    case 'malformed_response':
    case 'invalid_webhook':
    case 'unknown':
      return new AccountsAuthorizationError('PROVIDER_MALFORMED_RESPONSE');
    case 'access_revocation':
      return new AccountsAuthorizationError('ACCOUNT_ACCESS_REVOKED');
    default:
      return new AccountsAuthorizationError('PROVIDER_MALFORMED_RESPONSE');
  }
}

export function createAuthorizationService(options: {
  readonly accounts: AccountRepository;
  readonly clock?: () => Date;
  readonly config: Pick<
    import('./authentication-service.js').AuthModuleConfig,
    'authorizationLeaseTtlSeconds'
  >;
  readonly database: Database;
  readonly memberships: MembershipProjectionRepository;
  readonly namespaceAccessProvider: VcsNamespaceAccessProvider;
  readonly providerIdentities: ProviderIdentityRepository;
}): AuthorizationService {
  const clock = options.clock ?? (() => new Date());
  const pendingAccessChecks = new Map<string, Promise<VcsNamespaceAccess>>();
  const getNamespaceAccess = (input: {
    readonly accountId: string;
    readonly identityId: string;
    readonly namespaceId: string;
  }): Promise<VcsNamespaceAccess> => {
    const key = `${input.accountId}:${input.identityId}`;
    const current = pendingAccessChecks.get(key);
    if (current) return current;
    const pending = options.namespaceAccessProvider
      .getNamespaceAccess({namespaceId: input.namespaceId, identityId: input.identityId})
      .finally(() => pendingAccessChecks.delete(key));
    pendingAccessChecks.set(key, pending);
    return pending;
  };

  return {
    async authorizeAccountAccess({action, accountId, forceRefresh = false, identityId}) {
      const now = clock();
      const membership = await options.database.transaction(
        (transaction) =>
          options.memberships.findForAccountIdentity(transaction, accountId, identityId),
        {identity: {identityId}},
      );
      if (
        action === 'read' &&
        !forceRefresh &&
        membership?.state === 'active' &&
        membership.leaseExpiresAt !== undefined &&
        membership.leaseExpiresAt > now
      ) {
        return toAuthorizedAccess(membership);
      }

      const identity = await options.database.transaction((transaction) =>
        options.providerIdentities.findById(transaction, identityId),
      );
      if (!identity) throw new AccountsAuthorizationError('IDENTITY_NOT_FOUND');

      const account = await options.database.transaction(
        (transaction) => options.accounts.findById(transaction, accountId),
        {identity: {identityId}},
      );
      if (!account) throw new AccountsAuthorizationError('ACCOUNT_ACCESS_REVOKED');
      if (account.state === 'suspended') throw new AccountsAuthorizationError('ACCOUNT_SUSPENDED');
      if (
        account.namespaceKind === 'user' &&
        identity.providerUserId !== account.providerNamespaceId
      ) {
        throw new AccountsAuthorizationError('PERSONAL_NAMESPACE_IDENTITY_MISMATCH');
      }

      let access: VcsNamespaceAccess;
      try {
        access = await getNamespaceAccess({
          accountId,
          identityId,
          namespaceId: account.providerNamespaceId,
        });
      } catch (error) {
        if (classifyVcsProviderError(error) !== 'access_revocation') throw mapProviderError(error);
        access = {
          namespaceId: account.providerNamespaceId,
          identityId: identity.providerUserId,
          level: 'none',
        };
      }

      const role = roleForAccess(access.level);
      const projected = await options.database.transaction(
        (transaction) =>
          options.memberships.projectFromProviderAccess(transaction, {
            accountId,
            identityId,
            ...(role ? {providerRole: access.level} : {}),
            role: role ?? 'reviewer',
            state: role ? 'active' : 'inactive',
            ...(role
              ? {
                  verifiedAt: now,
                  leaseExpiresAt: plusSeconds(now, options.config.authorizationLeaseTtlSeconds),
                }
              : {}),
          }),
        {tenant: {accountId}},
      );
      if (!role) throw new AccountsAuthorizationError('ACCOUNT_ACCESS_REVOKED');
      if (action === 'owner-mutation' && role !== 'owner') {
        throw new AccountsAuthorizationError('OWNER_REQUIRED');
      }
      return toAuthorizedAccess(projected);
    },

    listAccessibleAccounts({identityId}) {
      return options.database.transaction(
        async (transaction) => {
          const [memberships, accounts] = await Promise.all([
            options.memberships.listForIdentity(transaction),
            options.accounts.listSummariesForIdentity(transaction),
          ]);
          const activeMemberships = new Map(
            memberships
              .filter((membership) => membership.state === 'active')
              .map((membership) => [membership.accountId, membership]),
          );
          return accounts.flatMap((account) => {
            const membership = activeMemberships.get(account.id);
            return membership ? [{account, membership}] : [];
          });
        },
        {identity: {identityId}},
      );
    },
  };
}
