import {
  bool,
  collectSensitiveValues,
  defineEnvironmentSchema,
  type EnvironmentFor,
  environmentVariable,
  host,
  InvalidConfigurationError,
  loadEnvironment,
  num,
  port,
  str,
  url,
} from '@glint/node-config';

const DEVELOPMENT_COOKIE_SECRET = 'development-cookie-secret-not-for-production';
const DEVELOPMENT_SESSION_SECRET = 'development-session-token-secret-not-for-production';

const schema = defineEnvironmentSchema({
  GLINT_API_HOST: environmentVariable(host({default: '127.0.0.1'}), {
    description: 'Interface used by the local API listener.',
  }),
  GLINT_API_PORT: environmentVariable(port({default: 3001}), {
    description: 'TCP port used by the local API listener.',
  }),
  GLINT_ALLOWED_ORIGINS: environmentVariable(str({default: 'http://localhost:5173'}), {
    description: 'Comma-separated exact browser origins allowed to send credentialed API requests.',
  }),
  GLINT_ENVIRONMENT: environmentVariable(str({default: 'development'}), {
    description: 'Deployment environment recorded on OAuth attempts.',
  }),
  GLINT_GITHUB_APP_ID: environmentVariable(str({default: 'development-app'}), {
    description: 'GitHub App identifier.',
  }),
  GLINT_GITHUB_AUTHORIZE_URL: environmentVariable(
    url({default: 'https://github.com/login/oauth/authorize'}),
    {description: 'GitHub OAuth authorization endpoint.'},
  ),
  GLINT_GITHUB_CLIENT_ID: environmentVariable(str({default: 'development-client'}), {
    description: 'GitHub OAuth client identifier.',
  }),
  GLINT_GITHUB_CLIENT_SECRET: environmentVariable(str({default: 'development-client-secret'}), {
    description: 'GitHub OAuth client secret.',
    sensitive: true,
  }),
  GLINT_GITHUB_OAUTH_SCOPES: environmentVariable(str({default: 'read:user'}), {
    description: 'Space-separated GitHub OAuth scopes.',
  }),
  GLINT_GITHUB_PRIVATE_KEY: environmentVariable(str({default: 'development-private-key'}), {
    description: 'GitHub App private key.',
    sensitive: true,
  }),
  GLINT_GITHUB_WEBHOOK_SECRET: environmentVariable(str({default: 'development-webhook-secret'}), {
    description: 'GitHub webhook verification secret.',
    sensitive: true,
  }),
  GLINT_MUTATION_PREFLIGHT_HEADER: environmentVariable(str({default: 'x-glint-csrf'}), {
    description: 'Custom header required for browser session mutations.',
  }),
  GLINT_OAUTH_ATTEMPT_TTL_SECONDS: environmentVariable(num({default: 600}), {
    description: 'Lifetime of a pending OAuth callback in seconds.',
  }),
  GLINT_OAUTH_CALLBACK_URL: environmentVariable(
    url({default: 'http://127.0.0.1:3001/api/v1/auth/github/callback'}),
    {description: 'GitHub OAuth callback URL.'},
  ),
  GLINT_SESSION_ABSOLUTE_TTL_SECONDS: environmentVariable(num({default: 2_592_000}), {
    description: 'Absolute browser session lifetime in seconds.',
  }),
  GLINT_SESSION_COOKIE_NAME: environmentVariable(str({default: 'glint_session'}), {
    description: 'Base name for host-only browser session cookies.',
  }),
  GLINT_SESSION_COOKIE_SECURE: environmentVariable(bool({default: false}), {
    description: 'Whether browser session cookies require HTTPS; required outside development.',
  }),
  GLINT_SESSION_INACTIVITY_TTL_SECONDS: environmentVariable(num({default: 604_800}), {
    description: 'Idle browser session lifetime in seconds.',
  }),
  GLINT_SESSION_TOKEN_SECRET: environmentVariable(str({default: DEVELOPMENT_SESSION_SECRET}), {
    description: 'HMAC key for opaque session and OAuth-state digests.',
    sensitive: true,
  }),
  GLINT_COOKIE_SECRET: environmentVariable(str({default: DEVELOPMENT_COOKIE_SECRET}), {
    description: 'Signing key for pre-authentication browser cookies.',
    sensitive: true,
  }),
  GLINT_WEB_APP_URL: environmentVariable(url({default: 'http://localhost:5173'}), {
    description: 'Browser application origin used for post-login redirects.',
  }),
  GLINT_OBJECT_STORE_ACCESS_KEY_ID: environmentVariable(
    str({default: 'GK000000000000000000000000'}),
    {
      description: 'Object-store access key.',
      sensitive: true,
    },
  ),
  GLINT_OBJECT_STORE_BUCKET: environmentVariable(str({default: 'glint'}), {
    description: 'Private object-store bucket name.',
  }),
  GLINT_OBJECT_STORE_ENDPOINT: environmentVariable(url({default: 'http://127.0.0.1:3900'}), {
    description: 'S3-compatible object-store endpoint.',
  }),
  GLINT_OBJECT_STORE_REGION: environmentVariable(str({default: 'garage'}), {
    description: 'S3-compatible object-store region.',
  }),
  GLINT_OBJECT_STORE_SECRET_ACCESS_KEY: environmentVariable(
    str({default: '0000000000000000000000000000000000000000000000000000000000000000'}),
    {
      description: 'Object-store secret access key.',
      sensitive: true,
    },
  ),
});

export type ApiEnvironment = EnvironmentFor<typeof schema>;

export function loadApiEnvironment(environment: NodeJS.ProcessEnv = process.env): ApiEnvironment {
  const loaded = loadEnvironment(schema, environment);
  if (loaded.GLINT_ENVIRONMENT !== 'development') {
    const invalid = [
      [
        'GLINT_SESSION_COOKIE_SECURE',
        !loaded.GLINT_SESSION_COOKIE_SECURE,
        'Secure session cookies are required outside development.',
      ],
      [
        'GLINT_SESSION_TOKEN_SECRET',
        loaded.GLINT_SESSION_TOKEN_SECRET === DEVELOPMENT_SESSION_SECRET,
        'Set a unique session-token secret outside development.',
      ],
      [
        'GLINT_COOKIE_SECRET',
        loaded.GLINT_COOKIE_SECRET === DEVELOPMENT_COOKIE_SECRET,
        'Set a unique cookie-signing secret outside development.',
      ],
    ].flatMap(([key, invalid, problem]) =>
      invalid
        ? [
            {
              key: String(key),
              problem: String(problem),
              description: 'Production security invariant.',
            },
          ]
        : [],
    );
    if (invalid.length > 0) throw new InvalidConfigurationError(invalid);
  }
  return loaded;
}

export function apiEnvironmentSecrets(environment: ApiEnvironment): readonly string[] {
  return collectSensitiveValues(schema, environment);
}
