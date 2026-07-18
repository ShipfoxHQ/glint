import {describe, expect, it} from '@shipfox/vitest/vi';
import {accountErrorCodeSchema, accountRepresentationSchema, accountRoleSchema} from './index.js';

describe('account DTO contracts', () => {
  it('keeps Glint roles separate from provider access levels', () => {
    expect(accountRoleSchema.options).toEqual(['owner', 'reviewer', 'viewer']);
    expect(accountErrorCodeSchema.parse('INSTALLATION_REQUIRED')).toBe('INSTALLATION_REQUIRED');
  });

  it('rejects an installation from a different namespace', () => {
    expect(() =>
      accountRepresentationSchema.parse({
        id: 'account-1',
        namespace: {
          id: 'namespace-1',
          provider: 'provider',
          kind: 'organization',
          state: 'active',
          login: 'glint',
        },
        installation: {
          id: 'installation-1',
          provider: 'provider',
          namespaceId: 'other-namespace',
          state: 'active',
          repositorySelection: 'all',
        },
        state: 'active',
      }),
    ).toThrow();
  });
});
