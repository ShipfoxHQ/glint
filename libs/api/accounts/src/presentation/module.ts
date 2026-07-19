import type {VcsIdentityProvider} from '@glint/api-vcs-core';
import type {PostgresDatabase} from '@glint/node-database';
import type {GlintCapabilityTypes, GlintModule} from '@glint/node-module';
import {
  type AuthModuleConfig,
  createAuthenticationService,
} from '../core/authentication-service.js';
import {createPostgresAccountsRepositories} from '../db/factory.js';
import {registerAuthenticationRoutes} from './authentication-routes.js';

interface AccountsAuthCapabilities extends GlintCapabilityTypes {
  readonly routes: (
    app: Parameters<typeof registerAuthenticationRoutes>[0],
  ) => Promise<void> | void;
}

export function createAccountsAuthModule<TCapabilities extends AccountsAuthCapabilities>(options: {
  readonly clock?: () => Date;
  readonly config: AuthModuleConfig;
  readonly database: PostgresDatabase;
  readonly identityProvider: VcsIdentityProvider;
  readonly reportUnexpectedError?: (error: unknown) => void;
}): GlintModule<TCapabilities> {
  const repositories = createPostgresAccountsRepositories(options.database);
  const service = createAuthenticationService({...options, ...repositories});
  return {
    name: 'accounts-auth',
    routes: [
      {
        name: 'accounts-auth.routes',
        value: (app) => registerAuthenticationRoutes(app, {...options, service}),
      },
    ],
  } as GlintModule<TCapabilities>;
}
