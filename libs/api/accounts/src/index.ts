export {AccountsPersistenceError} from './core/errors.js';
export type {
  AccountRepository,
  InstallationRepository,
  MembershipProjectionRepository,
  OAuthAttemptRepository,
  ProviderIdentityRepository,
  SessionRepository,
} from './core/ports.js';
export type {
  Account,
  Installation,
  MembershipProjection,
  OAuthAttempt,
  ProviderIdentity,
  Session,
} from './core/types.js';
export type {AccountsRepositories} from './db/factory.js';
export {createPostgresAccountsRepositories} from './db/factory.js';
export {ACCOUNTS_MIGRATION, accountsModule} from './migration.js';
