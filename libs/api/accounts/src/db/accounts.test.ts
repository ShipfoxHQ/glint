import {describe, expect, it} from '@shipfox/vitest/vi';
import * as accountsApi from '../index.js';
import {ACCOUNTS_MIGRATION} from '../migration.js';
import {accountFromRow, providerIdentityFromRow} from './mapping.js';
import {PostgresMembershipProjectionRepository} from './membership-projection.repository.js';

describe('accounts persistence mapping and ports', () => {
  it('maps provider metadata without introducing email-based identity linking', () => {
    const identity = providerIdentityFromRow({
      id: 'identity',
      provider: 'github',
      provider_user_id: '42',
      login: 'octocat',
      display_name: null,
      avatar_url: null,
      created_at: '2030-01-01T00:00:00.000Z',
      updated_at: '2030-01-01T00:00:00.000Z',
    });
    expect(identity).toEqual({
      id: 'identity',
      provider: 'github',
      providerUserId: '42',
      login: 'octocat',
      createdAt: new Date('2030-01-01T00:00:00.000Z'),
      updatedAt: new Date('2030-01-01T00:00:00.000Z'),
    });
  });

  it('maps the provider namespace key and preserves the schema migration declaration', () => {
    expect(
      accountFromRow({
        id: 'account',
        provider: 'github',
        provider_namespace_id: '99',
        namespace_kind: 'organization',
        slug: 'glint',
        display_name: 'Glint',
        avatar_url: null,
        state: 'active',
        created_at: '2030-01-01T00:00:00.000Z',
        updated_at: '2030-01-01T00:00:00.000Z',
      }),
    ).toMatchObject({provider: 'github', providerNamespaceId: '99', namespaceKind: 'organization'});
    expect(ACCOUNTS_MIGRATION).toMatchObject({name: 'accounts'});
  });

  it('does not expose manual membership-role mutation', () => {
    expect('setRole' in PostgresMembershipProjectionRepository.prototype).toBe(false);
    expect('updateRole' in PostgresMembershipProjectionRepository.prototype).toBe(false);
  });

  it('exports factories and ports without exposing concrete database repositories', () => {
    expect(accountsApi.createPostgresAccountsRepositories).toBeTypeOf('function');
    expect('PostgresAccountRepository' in accountsApi).toBe(false);
    expect('PostgresInstallationRepository' in accountsApi).toBe(false);
  });
});
