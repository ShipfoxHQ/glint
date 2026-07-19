import type {PostgresDatabase} from '@glint/node-database';
import type {
  AccountRepository,
  InstallationRepository,
  MembershipProjectionRepository,
  OAuthAttemptRepository,
  ProviderIdentityRepository,
  SessionRepository,
} from '../core/ports.js';
import {PostgresAccountRepository} from './account.repository.js';
import {PostgresInstallationRepository} from './installation.repository.js';
import {PostgresMembershipProjectionRepository} from './membership-projection.repository.js';
import {PostgresOAuthAttemptRepository} from './oauth-attempt.repository.js';
import {PostgresProviderIdentityRepository} from './provider-identity.repository.js';
import {PostgresSessionRepository} from './session.repository.js';

export interface AccountsRepositories {
  readonly accounts: AccountRepository;
  readonly installations: InstallationRepository;
  readonly memberships: MembershipProjectionRepository;
  readonly oauthAttempts: OAuthAttemptRepository;
  readonly providerIdentities: ProviderIdentityRepository;
  readonly sessions: SessionRepository;
}

/** Creates the module's PostgreSQL-backed service ports without exposing database implementations. */
export function createPostgresAccountsRepositories(
  database: PostgresDatabase,
): AccountsRepositories {
  return {
    accounts: new PostgresAccountRepository(database),
    installations: new PostgresInstallationRepository(database),
    memberships: new PostgresMembershipProjectionRepository(database),
    oauthAttempts: new PostgresOAuthAttemptRepository(database),
    providerIdentities: new PostgresProviderIdentityRepository(database),
    sessions: new PostgresSessionRepository(database),
  };
}
