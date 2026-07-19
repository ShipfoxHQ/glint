import {createAccountsAuthModule} from '@glint/api-accounts';
import {createGithubVcsProvider} from '@glint/api-vcs-github';
import {
  createPostgresDatabase,
  databaseEnvironmentSecrets,
  loadDatabaseEnvironment,
} from '@glint/node-database';
import {createS3BlobStore} from '@glint/node-object-store';
import {
  createGlintLogger,
  loadObservabilityEnvironment,
  observabilityEnvironmentSecrets,
} from '@glint/node-observability';
import {InMemoryJobQueue} from '@glint/node-queue';
import {type ApiCapabilities, createApiApp} from './app.js';
import {apiEnvironmentSecrets, loadApiEnvironment} from './config.js';

const apiEnvironment = loadApiEnvironment();
const databaseEnvironment = loadDatabaseEnvironment();
const observabilityEnvironment = loadObservabilityEnvironment();
const logger = await createGlintLogger({
  secrets: [
    ...databaseEnvironmentSecrets(databaseEnvironment),
    ...observabilityEnvironmentSecrets(observabilityEnvironment),
    ...apiEnvironmentSecrets(apiEnvironment),
  ],
});
const database = await createPostgresDatabase({environment: databaseEnvironment, logger});
const blobStore = createS3BlobStore({
  bucket: apiEnvironment.GLINT_OBJECT_STORE_BUCKET,
  region: apiEnvironment.GLINT_OBJECT_STORE_REGION,
  endpoint: apiEnvironment.GLINT_OBJECT_STORE_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: apiEnvironment.GLINT_OBJECT_STORE_ACCESS_KEY_ID,
    secretAccessKey: apiEnvironment.GLINT_OBJECT_STORE_SECRET_ACCESS_KEY,
  },
});
const queue = new InMemoryJobQueue();
const identityProvider = createGithubVcsProvider({
  appId: apiEnvironment.GLINT_GITHUB_APP_ID,
  clientId: apiEnvironment.GLINT_GITHUB_CLIENT_ID,
  clientSecret: apiEnvironment.GLINT_GITHUB_CLIENT_SECRET,
  privateKey: apiEnvironment.GLINT_GITHUB_PRIVATE_KEY,
  webhookSecret: apiEnvironment.GLINT_GITHUB_WEBHOOK_SECRET,
});
const authConfig = {
  absoluteTtlSeconds: apiEnvironment.GLINT_SESSION_ABSOLUTE_TTL_SECONDS,
  allowedOrigins: apiEnvironment.GLINT_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  attemptTtlSeconds: apiEnvironment.GLINT_OAUTH_ATTEMPT_TTL_SECONDS,
  authorizeUrl: apiEnvironment.GLINT_GITHUB_AUTHORIZE_URL,
  callbackUrl: apiEnvironment.GLINT_OAUTH_CALLBACK_URL,
  clientId: apiEnvironment.GLINT_GITHUB_CLIENT_ID,
  cookieName: apiEnvironment.GLINT_SESSION_COOKIE_NAME,
  cookieSecure: apiEnvironment.GLINT_SESSION_COOKIE_SECURE,
  environment: apiEnvironment.GLINT_ENVIRONMENT,
  inactivityTtlSeconds: apiEnvironment.GLINT_SESSION_INACTIVITY_TTL_SECONDS,
  mutationPreflightHeader: apiEnvironment.GLINT_MUTATION_PREFLIGHT_HEADER,
  oauthScopes: apiEnvironment.GLINT_GITHUB_OAUTH_SCOPES,
  sessionTokenSecret: apiEnvironment.GLINT_SESSION_TOKEN_SECRET,
  webAppUrl: apiEnvironment.GLINT_WEB_APP_URL,
};
const app = await createApiApp({
  blobStore,
  database,
  queue,
  logger,
  browserSecurity: {
    allowedOrigins: authConfig.allowedOrigins,
    cookieSecret: apiEnvironment.GLINT_COOKIE_SECRET,
    mutationPreflightHeader: authConfig.mutationPreflightHeader,
  },
  modules: [
    createAccountsAuthModule<ApiCapabilities>({
      database,
      identityProvider,
      config: authConfig,
      reportUnexpectedError: (error) =>
        logger.error('OAuth callback failed unexpectedly.', {
          error: error instanceof Error ? error.message : String(error),
        }),
    }),
  ],
});

async function shutdown(signal: string) {
  logger.info('Stopping API process.', {signal});
  await app.close();
  await database.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error('API shutdown failed.', {
          error: error instanceof Error ? error.message : String(error),
          signal,
        });
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen({host: apiEnvironment.GLINT_API_HOST, port: apiEnvironment.GLINT_API_PORT});
  logger.info('API process is ready.', {port: apiEnvironment.GLINT_API_PORT});
} catch (error) {
  logger.error('API process failed to start.', {
    error: error instanceof Error ? error.message : String(error),
  });
  await Promise.allSettled([app.close(), database.close()]);
  process.exit(1);
}
