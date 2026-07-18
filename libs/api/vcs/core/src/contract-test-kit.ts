import {describe, expect, it} from '@shipfox/vitest/vi';
import type {
  VcsCheck,
  VcsEvent,
  VcsIdentityProvider,
  VcsInstallationProvider,
  VcsNamespaceAccessProvider,
  VcsProvider,
  VcsUserCredential,
  VcsWebhookProvider,
} from './types.js';
import {
  VcsAccessRevocationError,
  VcsMalformedResponseError,
  VcsMissingInstallationError,
  VcsRateLimitError,
  VcsTimeoutError,
} from './types.js';

export interface VcsContractHarness {
  readonly provider: VcsProvider;
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
  readonly branch: string;
  readonly headSha: string;
  readonly ancestorSha: string;
  readonly intermediateSha: string;
  readonly unrelatedSha: string;
  readonly validWebhook: {
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  };
  readonly invalidWebhook: {
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  };
  readonly malformedWebhook: {
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  };
}

const check = (repositoryId: string, version: number, summary: string): VcsCheck => ({
  logicalId: 'glint:project:build:commit',
  repositoryId,
  commitSha: 'head',
  name: 'Glint',
  version,
  status: 'completed',
  conclusion: 'success',
  summary,
  detailsUrl: 'https://glint.invalid/build',
});

export function vcsProviderContractTests(
  name: string,
  createHarness: () => Promise<VcsContractHarness> | VcsContractHarness,
): void {
  describe(`${name} VCS-provider contract`, () => {
    it('resolves provider-neutral repositories, branches, pull requests, and ancestry', async () => {
      const harness = await createHarness();
      await expect(harness.provider.getRepository(harness.repositoryId)).resolves.toMatchObject({
        id: harness.repositoryId,
      });
      await expect(
        harness.provider.getBranch(harness.repositoryId, harness.branch),
      ).resolves.toMatchObject({headSha: harness.headSha});
      await expect(
        harness.provider.getPullRequest(harness.repositoryId, harness.pullRequestNumber),
      ).resolves.toMatchObject({headSha: harness.headSha});
      await expect(
        harness.provider.listPullRequestsForCommit(harness.repositoryId, harness.headSha),
      ).resolves.toHaveLength(1);
      await expect(
        harness.provider.isAncestor(harness.repositoryId, harness.ancestorSha, harness.headSha),
      ).resolves.toBe(true);
      await expect(
        harness.provider.isAncestor(
          harness.repositoryId,
          harness.ancestorSha,
          harness.intermediateSha,
        ),
      ).resolves.toBe(true);
      await expect(
        harness.provider.isAncestor(harness.repositoryId, harness.intermediateSha, harness.headSha),
      ).resolves.toBe(true);
      await expect(
        harness.provider.isAncestor(harness.repositoryId, harness.unrelatedSha, harness.headSha),
      ).resolves.toBe(false);
    });

    it('keeps one logical check and rejects out-of-order updates', async () => {
      const {provider, repositoryId} = await createHarness();
      await expect(provider.upsertCheck(check(repositoryId, 2, 'newest'))).resolves.toMatchObject({
        status: 'applied',
      });
      await expect(provider.upsertCheck(check(repositoryId, 1, 'stale'))).resolves.toMatchObject({
        status: 'stale',
        check: {version: 2, summary: 'newest'},
      });
      await expect(
        provider.upsertCheck(check(repositoryId, 2, 'idempotent retry')),
      ).resolves.toMatchObject({status: 'applied', check: {version: 2}});
    });

    it('authenticates and maps webhooks before exposing provider-neutral events', async () => {
      const {provider, validWebhook, invalidWebhook, malformedWebhook} = await createHarness();
      await expect(provider.verifyWebhook(validWebhook)).resolves.toMatchObject({type: 'push'});
      await expect(provider.verifyWebhook(invalidWebhook)).rejects.toMatchObject({
        code: 'invalid_webhook',
      });
      await expect(provider.verifyWebhook(malformedWebhook)).rejects.toMatchObject({
        code: 'invalid_webhook',
      });
    });

    it('reports provider-neutral readiness', async () => {
      const {provider} = await createHarness();
      await expect(provider.health()).resolves.toMatchObject({
        status: 'ready',
        provider: provider.provider,
      });
    });
  });
}

export interface VcsIdentityProviderContractHarness {
  readonly provider: VcsIdentityProvider &
    VcsNamespaceAccessProvider &
    VcsInstallationProvider &
    VcsWebhookProvider;
  readonly authorizationCode: string;
  readonly codeVerifier: string;
  readonly identityId: string;
  readonly organizationNamespaceId: string;
  readonly inactiveOrganizationNamespaceId: string;
  readonly personalNamespaceId: string;
  readonly organizationInstallationId: string;
  readonly personalInstallationId: string;
  readonly suspendedInstallationId: string;
  readonly inaccessibleInstallationId: string;
  readonly unavailableInstallationId: string;
  readonly activeRepositoryId: string;
  readonly removedRepositoryId: string;
  injectFailure(operation: string, error: Error): void;
  setHealthStatus(status: 'ready' | 'unavailable'): void;
  renameIdentity(): void;
  readonly webhookFixtures: {
    readonly valid: readonly {
      readonly input: {
        readonly headers: Readonly<Record<string, string>>;
        readonly body: Uint8Array;
      };
      readonly expected: VcsEvent;
    }[];
    readonly invalid: {
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
    };
    readonly malformed: {
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
    };
  };
}

export function vcsIdentityProviderContractTests(
  name: string,
  createHarness: () =>
    | Promise<VcsIdentityProviderContractHarness>
    | VcsIdentityProviderContractHarness,
): void {
  describe(`${name} identity-provider contract`, () => {
    it('exchanges authorization and resolves a provider-neutral stable identity', async () => {
      const harness = await createHarness();
      const authorization = await harness.provider.exchangeAuthorization({
        authorizationCode: harness.authorizationCode,
        codeVerifier: harness.codeVerifier,
      });
      expect(authorization.identity).toMatchObject({
        id: harness.identityId,
        provider: harness.provider.provider,
      });
      await expect(harness.provider.getIdentity(authorization.credential)).resolves.toMatchObject({
        id: harness.identityId,
      });
      harness.renameIdentity();
      await expect(harness.provider.getIdentity(authorization.credential)).resolves.toMatchObject({
        id: harness.identityId,
      });
    });

    it('fails authorization exchange with a retryable provider-unavailable error', async () => {
      const harness = await createHarness();
      harness.injectFailure('exchangeAuthorization', new VcsTimeoutError());
      await expect(
        harness.provider.exchangeAuthorization({
          authorizationCode: harness.authorizationCode,
          codeVerifier: harness.codeVerifier,
        }),
      ).rejects.toMatchObject({code: 'timeout', retryable: true});
    });

    it('fails an unrecognized authorization grant closed', async () => {
      const harness = await createHarness();
      await expect(
        harness.provider.exchangeAuthorization({
          authorizationCode: 'unrecognized-authorization-code',
          codeVerifier: harness.codeVerifier,
        }),
      ).rejects.toMatchObject({code: 'access_revocation', retryable: false});
    });

    it('lists installations authorized by the current provider identity', async () => {
      const harness = await createHarness();
      const {credential} = await harness.provider.exchangeAuthorization({
        authorizationCode: harness.authorizationCode,
        codeVerifier: harness.codeVerifier,
      });
      const installations = await harness.provider.listAuthorizedInstallations(credential);
      expect(installations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({id: harness.organizationInstallationId}),
          expect.objectContaining({id: harness.personalInstallationId}),
        ]),
      );
      expect(installations).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({id: harness.suspendedInstallationId}),
          expect.objectContaining({id: harness.inaccessibleInstallationId}),
        ]),
      );
    });

    it('normalizes organization owner, member, and inactive access fail-closed', async () => {
      const harness = await createHarness();
      await expect(
        harness.provider.getNamespaceAccess({
          namespaceId: harness.organizationNamespaceId,
          identityId: harness.identityId,
        }),
      ).resolves.toMatchObject({level: 'owner'});
      await expect(
        harness.provider.getNamespaceAccess({
          namespaceId: harness.organizationNamespaceId,
          identityId: 'member-identity',
        }),
      ).resolves.toMatchObject({level: 'member'});
      await expect(
        harness.provider.getNamespaceAccess({
          namespaceId: harness.inactiveOrganizationNamespaceId,
          identityId: harness.identityId,
        }),
      ).resolves.toMatchObject({level: 'none'});
      await expect(
        harness.provider.getNamespaceAccess({
          namespaceId: harness.organizationNamespaceId,
          identityId: 'unrelated-identity',
        }),
      ).resolves.toMatchObject({level: 'none'});
    });

    it('resolves organization, personal, suspended, and missing namespaces by stable ID', async () => {
      const harness = await createHarness();
      await expect(
        harness.provider.getNamespace(harness.organizationNamespaceId),
      ).resolves.toMatchObject({
        id: harness.organizationNamespaceId,
        kind: 'organization',
        state: 'active',
      });
      await expect(
        harness.provider.getNamespace(harness.personalNamespaceId),
      ).resolves.toMatchObject({
        id: harness.personalNamespaceId,
        kind: 'user',
        state: 'active',
      });
      await expect(
        harness.provider.getNamespace(harness.inactiveOrganizationNamespaceId),
      ).resolves.toMatchObject({
        id: harness.inactiveOrganizationNamespaceId,
        kind: 'organization',
        state: 'suspended',
      });
      await expect(harness.provider.getNamespace('missing-namespace')).resolves.toBeUndefined();
    });

    it('normalizes personal namespace access by matching stable identity only', async () => {
      const harness = await createHarness();
      await expect(
        harness.provider.getNamespaceAccess({
          namespaceId: harness.personalNamespaceId,
          identityId: harness.identityId,
        }),
      ).resolves.toMatchObject({level: 'owner'});
      await expect(
        harness.provider.getNamespaceAccess({
          namespaceId: harness.personalNamespaceId,
          identityId: 'other-identity',
        }),
      ).resolves.toMatchObject({level: 'none'});
    });

    it('keeps installations and repository relationships keyed by stable IDs', async () => {
      const harness = await createHarness();
      await expect(
        harness.provider.getInstallation(harness.organizationInstallationId),
      ).resolves.toMatchObject({
        namespaceId: harness.organizationNamespaceId,
        repositorySelection: 'all',
      });
      await expect(
        harness.provider.getInstallation(harness.personalInstallationId),
      ).resolves.toMatchObject({
        namespaceId: harness.personalNamespaceId,
        repositorySelection: 'selected',
      });
      await expect(
        harness.provider.listRepositories(harness.organizationInstallationId),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: harness.activeRepositoryId,
            namespaceId: harness.organizationNamespaceId,
            installationId: harness.organizationInstallationId,
            state: 'active',
          }),
          expect.objectContaining({
            id: harness.removedRepositoryId,
            namespaceId: harness.organizationNamespaceId,
            installationId: harness.organizationInstallationId,
            state: 'removed',
          }),
        ]),
      );
    });

    it('fails closed with a typed missing-installation error', async () => {
      const harness = await createHarness();
      await expect(
        harness.provider.getInstallation(harness.unavailableInstallationId),
      ).rejects.toMatchObject({
        code: 'missing_installation',
        retryable: false,
      });
      await expect(
        harness.provider.listRepositories(harness.unavailableInstallationId),
      ).rejects.toMatchObject({
        code: 'missing_installation',
        retryable: false,
      });
    });

    it('maps provider-native signed lifecycle fixtures from exact raw bytes', async () => {
      const harness = await createHarness();
      for (const fixture of harness.webhookFixtures.valid) {
        await expect(harness.provider.verifyAndMapWebhook(fixture.input)).resolves.toEqual(
          fixture.expected,
        );
      }
    });

    it('rejects invalid and malformed webhooks with the folded provider error', async () => {
      const harness = await createHarness();
      await expect(
        harness.provider.verifyAndMapWebhook(harness.webhookFixtures.invalid),
      ).rejects.toMatchObject({
        code: 'invalid_webhook',
        retryable: false,
      });
      await expect(
        harness.provider.verifyAndMapWebhook(harness.webhookFixtures.malformed),
      ).rejects.toMatchObject({code: 'invalid_webhook', retryable: false});
    });

    it('rejects revoked credentials through the Promise contract', async () => {
      const harness = await createHarness();
      const revokedCredential = {} as VcsUserCredential;
      await expect(harness.provider.getIdentity(revokedCredential)).rejects.toMatchObject({
        code: 'access_revocation',
        retryable: false,
      });
      await expect(
        harness.provider.listAuthorizedInstallations(revokedCredential),
      ).rejects.toMatchObject({
        code: 'access_revocation',
        retryable: false,
      });
    });

    it('reports ready and unavailable provider health', async () => {
      const harness = await createHarness();
      await expect(harness.provider.health()).resolves.toMatchObject({status: 'ready'});
      harness.setHealthStatus('unavailable');
      await expect(harness.provider.health()).resolves.toMatchObject({status: 'unavailable'});
    });

    it('preserves typed provider failure semantics', async () => {
      const harness = await createHarness();
      const errors = [
        ['getNamespaceAccess', new VcsTimeoutError(), 'timeout', true],
        ['getNamespaceAccess', new VcsRateLimitError(new Date(0)), 'rate_limit', true],
        ['getIdentity', new VcsMalformedResponseError(), 'malformed_response', false],
        ['listRepositories', new VcsMalformedResponseError(), 'malformed_response', false],
        ['getInstallation', new VcsMissingInstallationError(), 'missing_installation', false],
        ['getNamespaceAccess', new VcsAccessRevocationError(), 'access_revocation', false],
      ] as const;
      for (const [operation, error, code, retryable] of errors) {
        harness.injectFailure(operation, error);
        const request =
          operation === 'getIdentity'
            ? harness.provider
                .exchangeAuthorization({
                  authorizationCode: harness.authorizationCode,
                  codeVerifier: harness.codeVerifier,
                })
                .then(({credential}) => harness.provider.getIdentity(credential))
            : operation === 'getInstallation'
              ? harness.provider.getInstallation(harness.organizationInstallationId)
              : operation === 'listRepositories'
                ? harness.provider.listRepositories(harness.organizationInstallationId)
                : harness.provider.getNamespaceAccess({
                    namespaceId: harness.organizationNamespaceId,
                    identityId: harness.identityId,
                  });
        await expect(request).rejects.toMatchObject({code, retryable});
        if (error instanceof VcsRateLimitError) expect(error.retryAt).toEqual(new Date(0));
      }
    });
  });
}
