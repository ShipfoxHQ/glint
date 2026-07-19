export {AuthenticationError} from './core/authentication-error.js';
export type {AuthenticationService, AuthModuleConfig} from './core/authentication-service.js';
export {createAuthenticationService} from './core/authentication-service.js';
export {AccountsAuthorizationError} from './core/authorization-error.js';
export type {
  AccessibleAccount,
  AuthorizationService,
  AuthorizedAccess,
} from './core/authorization-service.js';
export {createAuthorizationService} from './core/authorization-service.js';
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
export {registerAccountRoutes} from './presentation/account-routes.js';
export {
  mutationGuard,
  registerAuthenticationRoutes,
  requireSession,
} from './presentation/authentication-routes.js';
export {
  requireCurrentNamespaceAccess,
  requireFreshOwner,
} from './presentation/authorization-guards.js';
export {createAccountsAuthModule} from './presentation/module.js';
