import {VcsAccessRevocationError, VcsMissingInstallationError} from '@glint/api-vcs-core';
import {vcsIdentityProviderContractTests} from '@glint/api-vcs-core/contract-test-kit';
import {sign} from '@octokit/webhooks-methods';
import {describe, expect, it} from '@shipfox/vitest/vi';
import type {
  GitHubAccount,
  GitHubGateway,
  GitHubInstallation,
  GitHubMembership,
  GitHubNamespaceAccess,
  GitHubRepository,
  GitHubUser,
} from './gateway.js';
import {GithubVcsProvider} from './provider.js';

const webhookSecret = 'test-webhook-secret';
const identity: GitHubUser = {id: 1, login: 'noe', name: 'Noé Charmet'};
const member: GitHubUser = {id: 2, login: 'member'};
const organization: GitHubAccount = {id: 10, login: 'shipfox', type: 'Organization'};
const inactiveOrganization: GitHubAccount = {
  id: 11,
  login: 'suspended-shipfox',
  type: 'Organization',
  suspended_at: '2026-01-01T00:00:00Z',
};
const personal: GitHubAccount = {id: 1, login: 'noe', type: 'User'};
const inaccessibleOrganization: GitHubAccount = {
  id: 12,
  login: 'inaccessible',
  type: 'Organization',
};

class FakeGateway implements GitHubGateway {
  readonly #users = new Map<string, GitHubUser>([
    ['1', identity],
    ['2', member],
  ]);
  readonly #accounts = new Map<string, GitHubAccount>([
    ['10', organization],
    ['11', inactiveOrganization],
    ['1', personal],
    ['12', inaccessibleOrganization],
  ]);
  readonly #installations = new Map<string, GitHubInstallation>([
    ['100', {id: 100, account: organization, repository_selection: 'all'}],
    ['101', {id: 101, account: personal, repository_selection: 'selected'}],
    [
      '102',
      {
        id: 102,
        account: organization,
        repository_selection: 'all',
        suspended_at: '2026-01-01T00:00:00Z',
      },
    ],
    ['103', {id: 103, account: inaccessibleOrganization, repository_selection: 'all'}],
  ]);
  readonly #repositories = new Map<string, readonly GitHubRepository[]>([
    [
      '100',
      [
        {
          id: 1000,
          owner: {id: 10, login: 'shipfox'},
          name: 'glint',
          default_branch: 'main',
          private: true,
        },
        {
          id: 1001,
          owner: {id: 10, login: 'shipfox-renamed'},
          name: 'glint-renamed',
          default_branch: 'main',
          private: true,
          archived: true,
          removed: true,
        },
      ],
    ],
  ]);
  readonly #failures = new Map<string, Error>();
  #healthStatus: 'ready' | 'unavailable' = 'ready';

  injectFailure(operation: string, error: Error): void {
    this.#failures.set(operation, error);
  }

  renameIdentity(): void {
    this.#users.set('1', {id: 1, login: 'noe-renamed', name: 'Noé Renamed'});
  }

  setHealthStatus(status: 'ready' | 'unavailable'): void {
    this.#healthStatus = status;
  }

  removeInstallation(installationId: string): void {
    this.#installations.delete(installationId);
  }

  suspendNamespace(namespaceId: string): void {
    const account = this.#accounts.get(namespaceId);
    if (!account) return;
    this.#accounts.set(namespaceId, {...account, suspended_at: '2026-01-01T00:00:00Z'});
  }

  async exchangeAuthorization(input: {
    readonly authorizationCode: string;
    readonly codeVerifier: string;
    readonly redirectUri?: string;
  }): Promise<{readonly userToken: string; readonly user: GitHubUser}> {
    await Promise.resolve();
    this.#takeFailure('exchangeAuthorization');
    if (input.authorizationCode !== 'authorization-code') throw new VcsAccessRevocationError();
    const resolvedIdentity = this.#users.get('1');
    if (!resolvedIdentity) throw new VcsAccessRevocationError();
    return {userToken: 'token-1', user: structuredClone(resolvedIdentity)};
  }

  async getAuthenticatedUser(userToken: string): Promise<GitHubUser> {
    await Promise.resolve();
    this.#takeFailure('getIdentity');
    if (userToken !== 'token-1') throw new VcsAccessRevocationError();
    const resolvedIdentity = this.#users.get('1');
    if (!resolvedIdentity) throw new VcsAccessRevocationError();
    return structuredClone(resolvedIdentity);
  }

  async listUserInstallations(userToken: string): Promise<readonly GitHubInstallation[]> {
    await Promise.resolve();
    this.#takeFailure('listAuthorizedInstallations');
    if (userToken !== 'token-1') throw new VcsAccessRevocationError();
    return [...this.#installations.values()]
      .filter((candidate) => candidate.id !== 103)
      .map((candidate) => structuredClone(candidate));
  }

  async getNamespaceAccount(namespaceId: string): Promise<GitHubAccount | undefined> {
    await Promise.resolve();
    this.#takeFailure('getNamespace');
    return structuredClone(this.#accounts.get(namespaceId));
  }

  async getNamespaceAccess(
    namespaceId: string,
    identityId: string,
  ): Promise<GitHubNamespaceAccess> {
    await Promise.resolve();
    this.#takeFailure('getNamespaceAccess');
    const account = this.#accounts.get(namespaceId);
    const installation = [...this.#installations.values()].find(
      (candidate) => String(candidate.account.id) === namespaceId,
    );
    const membership: GitHubMembership | undefined =
      namespaceId === '10' && identityId === '1'
        ? {state: 'active', role: 'admin'}
        : namespaceId === '10' && identityId === 'member-identity'
          ? {state: 'active', role: 'member'}
          : undefined;
    return {
      account: structuredClone(account),
      installation: structuredClone(installation),
      membership,
    };
  }

  async getInstallation(installationId: string): Promise<GitHubInstallation> {
    await Promise.resolve();
    this.#takeFailure('getInstallation');
    const resolvedInstallation = this.#installations.get(installationId);
    if (!resolvedInstallation) throw new VcsMissingInstallationError();
    return structuredClone(resolvedInstallation);
  }

  async listInstallationRepositories(installationId: string): Promise<readonly GitHubRepository[]> {
    await Promise.resolve();
    this.#takeFailure('listRepositories');
    if (!this.#installations.has(installationId)) throw new VcsMissingInstallationError();
    return structuredClone(this.#repositories.get(installationId) ?? []);
  }

  async health(): Promise<{readonly status: 'ready' | 'unavailable'}> {
    await Promise.resolve();
    this.#takeFailure('health');
    return {status: this.#healthStatus};
  }

  #takeFailure(operation: string): void {
    const failure = this.#failures.get(operation);
    if (failure) {
      this.#failures.delete(operation);
      throw failure;
    }
  }
}

async function signedFixture(event: string, deliveryId: string, payload: object) {
  const rawBody = JSON.stringify(payload);
  return {
    input: {
      headers: {
        'x-github-delivery': deliveryId,
        'x-github-event': event,
        'x-hub-signature-256': await sign(webhookSecret, rawBody),
      },
      body: new TextEncoder().encode(rawBody),
    },
  };
}

vcsIdentityProviderContractTests('github', async () => {
  const gateway = new FakeGateway();
  const provider = new GithubVcsProvider(gateway, {webhookSecret, now: () => new Date(0)});
  const installationFixture = await signedFixture('installation', 'delivery-installation', {
    action: 'created',
    installation: {id: 100, account: organization, repository_selection: 'all'},
  });
  const repositoriesFixture = await signedFixture(
    'installation_repositories',
    'delivery-repositories',
    {
      action: 'added',
      installation: {id: 100, account: organization, repository_selection: 'all'},
      repositories_added: [
        {
          id: 1000,
          full_name: 'café/glint',
          name: 'glint',
          private: true,
        },
      ],
    },
  );
  const membershipFixture = await signedFixture('organization', 'delivery-membership', {
    action: 'member_added',
    organization,
    member: identity,
    membership: {role: 'admin'},
  });
  const organizationFixture = await signedFixture('organization', 'delivery-organization', {
    action: 'deleted',
    organization,
  });
  const revocationFixture = await signedFixture('github_app_authorization', 'delivery-revocation', {
    action: 'revoked',
    sender: identity,
  });
  const malformed = await signedFixture('push', 'delivery-malformed', {ref: 'refs/heads/main'});
  return {
    provider,
    authorizationCode: 'authorization-code',
    codeVerifier: 'code-verifier',
    identityId: '1',
    organizationNamespaceId: '10',
    inactiveOrganizationNamespaceId: '11',
    personalNamespaceId: '1',
    organizationInstallationId: '100',
    personalInstallationId: '101',
    suspendedInstallationId: '102',
    inaccessibleInstallationId: '103',
    unavailableInstallationId: '999',
    activeRepositoryId: '1000',
    removedRepositoryId: '1001',
    injectFailure: (operation, error) => gateway.injectFailure(operation, error),
    setHealthStatus: (status) => gateway.setHealthStatus(status),
    renameIdentity: () => gateway.renameIdentity(),
    webhookFixtures: {
      valid: [
        {
          ...installationFixture,
          expected: {
            type: 'installation' as const,
            provider: 'github',
            deliveryId: 'delivery-installation',
            action: 'created' as const,
            installation: {
              id: '100',
              provider: 'github',
              namespaceId: '10',
              state: 'active' as const,
              repositorySelection: 'all' as const,
            },
          },
        },
        {
          ...repositoriesFixture,
          expected: {
            type: 'installation-repositories' as const,
            provider: 'github',
            deliveryId: 'delivery-repositories',
            installationId: '100',
            namespaceId: '10',
            action: 'added' as const,
            repositories: [
              {
                id: '1000',
                provider: 'github',
                namespaceId: '10',
                installationId: '100',
                state: 'active' as const,
                owner: 'café',
                name: 'glint',
                defaultBranch: 'HEAD',
                visibility: 'private' as const,
              },
            ],
          },
        },
        {
          ...membershipFixture,
          expected: {
            type: 'membership' as const,
            provider: 'github',
            deliveryId: 'delivery-membership',
            namespaceId: '10',
            identityId: '1',
            access: 'owner' as const,
          },
        },
        {
          ...organizationFixture,
          expected: {
            type: 'organization-lifecycle' as const,
            provider: 'github',
            deliveryId: 'delivery-organization',
            action: 'deleted' as const,
            namespace: {
              id: '10',
              provider: 'github',
              kind: 'organization' as const,
              state: 'suspended' as const,
              login: 'shipfox',
            },
          },
        },
        {
          ...revocationFixture,
          expected: {
            type: 'app-authorization-revocation' as const,
            provider: 'github',
            deliveryId: 'delivery-revocation',
            identityId: '1',
          },
        },
      ],
      invalid: {headers: {}, body: new Uint8Array()},
      malformed: malformed.input,
    },
  };
});

describe('GithubVcsProvider access policy', () => {
  it('requires an active personal installation and an active namespace', async () => {
    const gateway = new FakeGateway();
    const provider = new GithubVcsProvider(gateway, {webhookSecret});
    gateway.removeInstallation('101');
    await expect(
      provider.getNamespaceAccess({namespaceId: '1', identityId: '1'}),
    ).resolves.toMatchObject({
      level: 'none',
    });
    gateway.suspendNamespace('10');
    await expect(
      provider.getNamespaceAccess({namespaceId: '10', identityId: '1'}),
    ).resolves.toMatchObject({
      level: 'none',
    });
  });

  it('rejects an unknown organization membership role', async () => {
    const gateway = new FakeGateway();
    const provider = new GithubVcsProvider(gateway, {webhookSecret});
    const fixture = await signedFixture('organization', 'delivery-unknown-role', {
      action: 'member_added',
      organization,
      member: identity,
      membership: {role: 'maintainer'},
    });
    await expect(provider.verifyAndMapWebhook(fixture.input)).rejects.toMatchObject({
      code: 'invalid_webhook',
    });
  });
});
