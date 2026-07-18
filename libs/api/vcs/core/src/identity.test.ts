import {vcsIdentityProviderContractTests} from './contract-test-kit.js';
import {InMemoryVcsIdentityProvider} from './in-memory.js';
import type {VcsEvent} from './types.js';

vcsIdentityProviderContractTests('in-memory', () => {
  const provider = new InMemoryVcsIdentityProvider(() => new Date(0));
  provider.seedIdentity({id: 'identity-1', provider: 'in-memory', login: 'noe'});
  provider.seedIdentity({id: 'member-identity', provider: 'in-memory', login: 'member'});
  provider.seedAuthorizationCode('authorization-code', 'identity-1');
  provider.seedNamespace({
    id: 'organization-1',
    provider: 'in-memory',
    kind: 'organization',
    state: 'active',
    login: 'shipfox',
  });
  provider.seedNamespace({
    id: 'organization-inactive',
    provider: 'in-memory',
    kind: 'organization',
    state: 'suspended',
    login: 'suspended-shipfox',
  });
  provider.seedNamespace({
    id: 'identity-1',
    provider: 'in-memory',
    kind: 'user',
    state: 'active',
    login: 'noe',
  });
  provider.seedNamespace({
    id: 'organization-inaccessible',
    provider: 'in-memory',
    kind: 'organization',
    state: 'active',
    login: 'inaccessible',
  });
  provider.seedNamespaceAccess('organization-1', 'identity-1', 'owner');
  provider.seedNamespaceAccess('organization-1', 'member-identity', 'member');
  provider.seedInstallation({
    id: 'installation-organization',
    provider: 'in-memory',
    namespaceId: 'organization-1',
    state: 'active',
    repositorySelection: 'all',
  });
  provider.seedInstallation({
    id: 'installation-personal',
    provider: 'in-memory',
    namespaceId: 'identity-1',
    state: 'active',
    repositorySelection: 'selected',
  });
  provider.seedInstallation({
    id: 'installation-suspended',
    provider: 'in-memory',
    namespaceId: 'organization-1',
    state: 'suspended',
    repositorySelection: 'all',
  });
  provider.seedInstallation({
    id: 'installation-inaccessible',
    provider: 'in-memory',
    namespaceId: 'organization-inaccessible',
    state: 'active',
    repositorySelection: 'all',
  });
  provider.seedRepository({
    id: 'repository-active',
    provider: 'in-memory',
    namespaceId: 'organization-1',
    installationId: 'installation-organization',
    state: 'active',
    owner: 'shipfox',
    name: 'glint',
    defaultBranch: 'main',
    visibility: 'private',
  });
  provider.seedRepository({
    id: 'repository-removed',
    provider: 'in-memory',
    namespaceId: 'organization-1',
    installationId: 'installation-organization',
    state: 'removed',
    owner: 'shipfox-renamed',
    name: 'glint-renamed',
    defaultBranch: 'main',
    visibility: 'private',
  });
  const signedFixture = (expected: VcsEvent) => ({
    input: {
      headers: {'x-glint-signature': 'valid'},
      body: new TextEncoder().encode(JSON.stringify(expected)),
    },
    expected,
  });
  return {
    provider,
    authorizationCode: 'authorization-code',
    codeVerifier: 'code-verifier',
    identityId: 'identity-1',
    organizationNamespaceId: 'organization-1',
    inactiveOrganizationNamespaceId: 'organization-inactive',
    personalNamespaceId: 'identity-1',
    organizationInstallationId: 'installation-organization',
    personalInstallationId: 'installation-personal',
    suspendedInstallationId: 'installation-suspended',
    inaccessibleInstallationId: 'installation-inaccessible',
    unavailableInstallationId: 'missing-installation',
    activeRepositoryId: 'repository-active',
    removedRepositoryId: 'repository-removed',
    injectFailure: (operation, error) =>
      provider.injectFailure(
        operation as Parameters<typeof provider.injectFailure>[0],
        error as Parameters<typeof provider.injectFailure>[1],
      ),
    setHealthStatus: (status) => provider.setHealthStatus(status),
    renameIdentity: () =>
      provider.seedIdentity({
        id: 'identity-1',
        provider: 'in-memory',
        login: 'noe-renamed',
        displayName: 'Noé Renamed',
      }),
    webhookFixtures: {
      valid: [
        signedFixture({
          type: 'installation',
          provider: 'in-memory',
          deliveryId: 'delivery-installation',
          action: 'created',
          installation: {
            id: 'installation-organization',
            provider: 'in-memory',
            namespaceId: 'organization-1',
            state: 'active',
            repositorySelection: 'all',
          },
        }),
        signedFixture({
          type: 'installation-repositories',
          provider: 'in-memory',
          deliveryId: 'delivery-repositories',
          installationId: 'installation-organization',
          namespaceId: 'organization-1',
          action: 'added',
          repositories: [
            {
              id: 'repository-active',
              provider: 'in-memory',
              namespaceId: 'organization-1',
              installationId: 'installation-organization',
              state: 'active',
              owner: 'shipfox',
              name: 'glint',
              defaultBranch: 'main',
              visibility: 'private',
            },
          ],
        }),
        signedFixture({
          type: 'membership',
          provider: 'in-memory',
          deliveryId: 'delivery-membership',
          namespaceId: 'organization-1',
          identityId: 'identity-1',
          access: 'owner',
        }),
        signedFixture({
          type: 'organization-lifecycle',
          provider: 'in-memory',
          deliveryId: 'delivery-organization',
          action: 'suspended',
          namespace: {
            id: 'organization-1',
            provider: 'in-memory',
            kind: 'organization',
            state: 'suspended',
            login: 'café',
          },
        }),
        signedFixture({
          type: 'app-authorization-revocation',
          provider: 'in-memory',
          deliveryId: 'delivery-revocation',
          identityId: 'identity-1',
        }),
      ],
      invalid: {headers: {}, body: new Uint8Array()},
      malformed: {
        headers: {'x-glint-signature': 'valid'},
        body: new TextEncoder().encode('{"type":"unknown","deliveryId":"delivery-malformed"}'),
      },
    },
  };
});
