import {
  VcsAccessRevocationError,
  type VcsNamespaceAccessProvider,
  VcsRateLimitError,
  VcsTimeoutError,
} from '@glint/api-vcs-core';
import type {Database, DatabaseTransaction, TransactionOptions} from '@glint/node-database';
import {describe, expect, it, vi} from '@shipfox/vitest/vi';
import {AccountsAuthorizationError} from './authorization-error.js';
import {createAuthorizationService} from './authorization-service.js';
import type {
  AccountRepository,
  MembershipProjectionRepository,
  ProviderIdentityRepository,
} from './ports.js';
import type {Account, MembershipProjection, ProviderIdentity} from './types.js';

const now = new Date('2030-01-01T00:00:00.000Z');
const account: Account = {
  id: 'account',
  provider: 'github',
  providerNamespaceId: 'provider-account',
  namespaceKind: 'organization',
  slug: 'glint',
  displayName: 'Glint',
  state: 'active',
  createdAt: now,
  updatedAt: now,
};
const identity: ProviderIdentity = {
  id: 'identity',
  provider: 'github',
  providerUserId: 'provider-user',
  login: 'octocat',
  createdAt: now,
  updatedAt: now,
};

function membership(overrides: Partial<MembershipProjection> = {}): MembershipProjection {
  return {
    id: 'membership',
    accountId: account.id,
    identityId: identity.id,
    role: 'owner',
    state: 'active',
    verifiedAt: now,
    leaseExpiresAt: new Date('2030-01-01T00:15:00.000Z'),
    ...overrides,
  };
}

function withoutLease(): MembershipProjection {
  const result = membership();
  delete (result as {leaseExpiresAt?: Date}).leaseExpiresAt;
  return result;
}

function fixture(
  overrides: {
    readonly account?: Account | undefined;
    readonly membership?: MembershipProjection | undefined;
    readonly providerAccess?: 'owner' | 'member' | 'none';
    readonly providerFailure?: Error;
  } = {},
) {
  const transaction = {id: 'transaction'} as DatabaseTransaction;
  const transactionOptions: TransactionOptions[] = [];
  const database: Database = {
    health: () => Promise.resolve({status: 'ready', checkedAtMs: 0}),
    transaction: (operation, options) => {
      transactionOptions.push(options ?? {});
      return operation(transaction);
    },
  };
  const accounts: AccountRepository = {
    findById: vi.fn(() =>
      Promise.resolve(overrides.account === undefined ? account : overrides.account),
    ),
    listSummariesForIdentity: vi.fn(() => Promise.resolve([account])),
    upsertByProviderNamespace: vi.fn(),
  };
  const memberships: MembershipProjectionRepository = {
    findForAccountIdentity: vi.fn(() =>
      Promise.resolve(overrides.membership === undefined ? membership() : overrides.membership),
    ),
    listForIdentity: vi.fn(() => Promise.resolve([membership()])),
    projectFromProviderAccess: vi.fn((_transaction, input) =>
      Promise.resolve(membership({...input, id: 'refreshed'})),
    ),
  };
  const providerIdentities: ProviderIdentityRepository = {
    findById: vi.fn(() => Promise.resolve(identity)),
    upsertByProviderUser: vi.fn(),
  };
  const namespaceAccessProvider: VcsNamespaceAccessProvider = {
    provider: 'github',
    getNamespace: vi.fn(),
    getNamespaceAccess: vi.fn(() => {
      if (overrides.providerFailure) return Promise.reject(overrides.providerFailure);
      return Promise.resolve({
        namespaceId: account.providerNamespaceId,
        identityId: identity.providerUserId,
        level: overrides.providerAccess ?? 'owner',
      });
    }),
  };
  return {
    accounts,
    memberships,
    namespaceAccessProvider,
    providerIdentities,
    transactionOptions,
    service: createAuthorizationService({
      accounts,
      clock: () => now,
      config: {authorizationLeaseTtlSeconds: 900},
      database,
      memberships,
      namespaceAccessProvider,
      providerIdentities,
    }),
  };
}

describe('authorization service', () => {
  it('returns a valid read lease in one identity-scoped transaction', async () => {
    const {service, namespaceAccessProvider, transactionOptions, providerIdentities, accounts} =
      fixture();
    await expect(
      service.authorizeAccountAccess({
        action: 'read',
        accountId: account.id,
        identityId: identity.id,
      }),
    ).resolves.toMatchObject({role: 'owner'});
    expect(namespaceAccessProvider.getNamespaceAccess).not.toHaveBeenCalled();
    expect(providerIdentities.findById).not.toHaveBeenCalled();
    expect(accounts.findById).not.toHaveBeenCalled();
    expect(transactionOptions).toEqual([{identity: {identityId: identity.id}}]);
  });

  it('refreshes expired and null leases, then writes a tenant-scoped lease', async () => {
    for (const staleMembership of [
      membership({leaseExpiresAt: new Date('2029-12-31T23:59:59.000Z')}),
      withoutLease(),
    ]) {
      const {service, memberships, namespaceAccessProvider, transactionOptions} = fixture({
        membership: staleMembership,
      });
      await expect(
        service.authorizeAccountAccess({
          action: 'read',
          accountId: account.id,
          identityId: identity.id,
        }),
      ).resolves.toMatchObject({role: 'owner'});
      expect(namespaceAccessProvider.getNamespaceAccess).toHaveBeenCalledTimes(1);
      expect(memberships.projectFromProviderAccess).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          role: 'owner',
          state: 'active',
          leaseExpiresAt: new Date('2030-01-01T00:15:00.000Z'),
        }),
      );
      expect(transactionOptions.at(-1)).toEqual({tenant: {accountId: account.id}});
    }
  });

  it('coalesces concurrent checks and clears a rejected check for retry', async () => {
    const {service, namespaceAccessProvider} = fixture({
      membership: withoutLease(),
    });
    let resolveAccess:
      | ((value: {namespaceId: string; identityId: string; level: 'owner'}) => void)
      | undefined;
    vi.mocked(namespaceAccessProvider.getNamespaceAccess).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAccess = resolve;
        }),
    );
    const first = service.authorizeAccountAccess({
      action: 'read',
      accountId: account.id,
      identityId: identity.id,
    });
    const second = service.authorizeAccountAccess({
      action: 'read',
      accountId: account.id,
      identityId: identity.id,
    });
    await vi.waitFor(() =>
      expect(namespaceAccessProvider.getNamespaceAccess).toHaveBeenCalledTimes(1),
    );
    resolveAccess?.({
      namespaceId: account.providerNamespaceId,
      identityId: identity.providerUserId,
      level: 'owner',
    });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    vi.mocked(namespaceAccessProvider.getNamespaceAccess)
      .mockRejectedValueOnce(new VcsTimeoutError())
      .mockResolvedValueOnce({
        namespaceId: account.providerNamespaceId,
        identityId: identity.providerUserId,
        level: 'owner',
      });
    await expect(
      service.authorizeAccountAccess({
        action: 'read',
        accountId: account.id,
        identityId: identity.id,
      }),
    ).rejects.toMatchObject({code: 'PROVIDER_TIMEOUT'});
    await expect(
      service.authorizeAccountAccess({
        action: 'read',
        accountId: account.id,
        identityId: identity.id,
      }),
    ).resolves.toMatchObject({role: 'owner'});
  });

  it('always refreshes owner mutations and rejects reviewers', async () => {
    const {service, namespaceAccessProvider} = fixture({providerAccess: 'member'});
    await expect(
      service.authorizeAccountAccess({
        action: 'owner-mutation',
        accountId: account.id,
        identityId: identity.id,
      }),
    ).rejects.toEqual(expect.objectContaining({code: 'OWNER_REQUIRED'}));
    expect(namespaceAccessProvider.getNamespaceAccess).toHaveBeenCalledTimes(1);
  });

  it('fails closed without projection writes for provider failures and inactivates lost access', async () => {
    for (const [failure, code] of [
      [new VcsTimeoutError(), 'PROVIDER_TIMEOUT'],
      [new VcsRateLimitError(), 'PROVIDER_RATE_LIMITED'],
      [new Error('unexpected provider response'), 'PROVIDER_MALFORMED_RESPONSE'],
    ] as const) {
      const {service, memberships} = fixture({
        membership: withoutLease(),
        providerFailure: failure,
      });
      await expect(
        service.authorizeAccountAccess({
          action: 'read',
          accountId: account.id,
          identityId: identity.id,
        }),
      ).rejects.toEqual(expect.objectContaining({code}));
      expect(memberships.projectFromProviderAccess).not.toHaveBeenCalled();
    }
    const {service, memberships} = fixture({
      membership: withoutLease(),
      providerFailure: new VcsAccessRevocationError(),
    });
    await expect(
      service.authorizeAccountAccess({
        action: 'read',
        accountId: account.id,
        identityId: identity.id,
      }),
    ).rejects.toEqual(expect.any(AccountsAuthorizationError));
    expect(memberships.projectFromProviderAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({state: 'inactive'}),
    );
  });

  it('rejects a personal namespace before making a provider request', async () => {
    const {service, namespaceAccessProvider} = fixture({
      account: {...account, namespaceKind: 'user', providerNamespaceId: 'different-user'},
      membership: withoutLease(),
    });
    await expect(
      service.authorizeAccountAccess({
        action: 'read',
        accountId: account.id,
        identityId: identity.id,
      }),
    ).rejects.toMatchObject({code: 'PERSONAL_NAMESPACE_IDENTITY_MISMATCH'});
    expect(namespaceAccessProvider.getNamespaceAccess).not.toHaveBeenCalled();
  });
});
