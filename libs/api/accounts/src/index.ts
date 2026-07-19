export {AuthenticationError} from './core/authentication-error.js';
export type {AuthenticationService, AuthModuleConfig} from './core/authentication-service.js';
export {createAuthenticationService} from './core/authentication-service.js';
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
export {
  mutationGuard,
  registerAuthenticationRoutes,
  requireSession,
} from './presentation/authentication-routes.js';
export {createAccountsAuthModule} from './presentation/module.js';
