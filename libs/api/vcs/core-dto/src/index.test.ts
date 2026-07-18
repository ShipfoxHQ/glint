import {describe, expect, it} from '@shipfox/vitest/vi';
import {VCS_CORE_EVENT_VERSION, vcsLifecycleEventSchema} from './index.js';

describe('VCS core DTO contracts', () => {
  it('serializes all provider-neutral E1 lifecycle events', () => {
    expect(VCS_CORE_EVENT_VERSION).toBe(1);
    const installation = {
      id: 'installation-1',
      provider: 'provider',
      namespaceId: 'namespace-1',
      state: 'active',
      repositorySelection: 'all',
    } as const;
    const repository = {
      id: 'repository-1',
      provider: 'provider',
      namespaceId: 'namespace-1',
      installationId: 'installation-1',
      state: 'active',
      owner: 'owner',
      name: 'repository',
      defaultBranch: 'main',
      visibility: 'private',
    } as const;
    const namespace = {
      id: 'namespace-1',
      provider: 'provider',
      kind: 'organization',
      state: 'active',
      login: 'owner',
    } as const;
    const events = [
      {
        type: 'installation',
        provider: 'provider',
        deliveryId: 'delivery-installation',
        action: 'created',
        installation,
      },
      {
        type: 'installation-repositories',
        provider: 'provider',
        deliveryId: 'delivery-repositories',
        installationId: installation.id,
        namespaceId: namespace.id,
        action: 'added',
        repositories: [repository],
      },
      {
        type: 'membership',
        provider: 'provider',
        deliveryId: 'delivery-membership',
        namespaceId: namespace.id,
        identityId: 'identity-1',
        access: 'owner',
      },
      {
        type: 'organization-lifecycle',
        provider: 'provider',
        deliveryId: 'delivery-organization',
        action: 'suspended',
        namespace,
      },
      {
        type: 'app-authorization-revocation',
        provider: 'provider',
        deliveryId: 'delivery-revocation',
        identityId: 'identity-1',
      },
    ] as const;

    for (const event of events) {
      expect(vcsLifecycleEventSchema.parse(event)).toMatchObject({type: event.type});
    }
    expect(() =>
      vcsLifecycleEventSchema.parse({type: 'github.installation', deliveryId: 'delivery-provider'}),
    ).toThrow();
  });

  it('rejects repositories scoped to a different installation', () => {
    expect(() =>
      vcsLifecycleEventSchema.parse({
        type: 'installation-repositories',
        provider: 'provider',
        deliveryId: 'delivery-1',
        installationId: 'installation-1',
        namespaceId: 'namespace-1',
        action: 'added',
        repositories: [
          {
            id: 'repository-1',
            provider: 'provider',
            namespaceId: 'namespace-1',
            installationId: 'other-installation',
            state: 'active',
            owner: 'owner',
            name: 'repository',
            defaultBranch: 'main',
            visibility: 'private',
          },
        ],
      }),
    ).toThrow();
  });
});
