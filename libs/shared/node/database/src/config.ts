import {
  defineEnvironmentSchema,
  describeEnvironment,
  type EnvironmentVariableDescription,
  environmentVariable,
  host,
  loadEnvironment,
  num,
  port,
  str,
} from '@glint/node-config';

const databaseEnvironmentSchema = defineEnvironmentSchema({
  POSTGRES_HOST: environmentVariable(host({default: '127.0.0.1'}), {
    description:
      'PostgreSQL hostname. Use the pooled endpoint for application traffic and the direct endpoint for migrations.',
  }),
  POSTGRES_PORT: environmentVariable(port({default: 5432}), {
    description: 'PostgreSQL TCP port.',
  }),
  POSTGRES_USERNAME: environmentVariable(str({default: 'glint'}), {
    description: 'PostgreSQL role used by this process.',
  }),
  POSTGRES_PASSWORD: environmentVariable(str({default: 'local-glint'}), {
    description: 'PostgreSQL password. Use a managed secret outside local development.',
    sensitive: true,
  }),
  POSTGRES_DATABASE: environmentVariable(str({default: 'glint'}), {
    description: 'PostgreSQL database used by this process.',
  }),
  POSTGRES_MAX_CONNECTIONS: environmentVariable(num({default: 10}), {
    description:
      'Maximum local pool size. Serverless application processes should set this to one.',
  }),
  POSTGRES_CONNECTION_TIMEOUT_MS: environmentVariable(num({default: 5_000}), {
    description: 'Maximum time allowed to establish a PostgreSQL connection, in milliseconds.',
  }),
  POSTGRES_IDLE_TIMEOUT_MS: environmentVariable(num({default: 10_000}), {
    description: 'Time an unused PostgreSQL connection remains in the local pool, in milliseconds.',
  }),
  POSTGRES_TLS_MODE: environmentVariable(
    str({choices: ['disable', 'verify-full'], default: 'disable'}),
    {
      description:
        'PostgreSQL TLS policy. Plaintext is accepted only for loopback and the local Compose service.',
    },
  ),
});

export interface DatabaseEnvironment {
  readonly POSTGRES_HOST: string;
  readonly POSTGRES_PORT: number;
  readonly POSTGRES_USERNAME: string;
  readonly POSTGRES_PASSWORD: string;
  readonly POSTGRES_DATABASE: string;
  readonly POSTGRES_MAX_CONNECTIONS: number;
  readonly POSTGRES_CONNECTION_TIMEOUT_MS: number;
  readonly POSTGRES_IDLE_TIMEOUT_MS: number;
  readonly POSTGRES_TLS_MODE: 'disable' | 'verify-full';
}

export function loadDatabaseEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseEnvironment {
  const loaded = loadEnvironment(databaseEnvironmentSchema, environment);
  assertPositive('POSTGRES_MAX_CONNECTIONS', loaded.POSTGRES_MAX_CONNECTIONS);
  assertNonNegative('POSTGRES_CONNECTION_TIMEOUT_MS', loaded.POSTGRES_CONNECTION_TIMEOUT_MS);
  assertNonNegative('POSTGRES_IDLE_TIMEOUT_MS', loaded.POSTGRES_IDLE_TIMEOUT_MS);
  if (loaded.POSTGRES_TLS_MODE !== 'disable' && loaded.POSTGRES_TLS_MODE !== 'verify-full') {
    throw new Error('POSTGRES_TLS_MODE must be disable or verify-full.');
  }
  if (loaded.POSTGRES_TLS_MODE === 'disable' && !isLocalPostgresHost(loaded.POSTGRES_HOST)) {
    throw new Error(
      'POSTGRES_TLS_MODE must be verify-full when POSTGRES_HOST is not local or the Compose postgres service.',
    );
  }
  return {...loaded, POSTGRES_TLS_MODE: loaded.POSTGRES_TLS_MODE};
}

export function describeDatabaseEnvironment(): readonly EnvironmentVariableDescription[] {
  return describeEnvironment(databaseEnvironmentSchema);
}

export function databaseEnvironmentSecrets(environment: DatabaseEnvironment): readonly string[] {
  return environment.POSTGRES_PASSWORD ? [environment.POSTGRES_PASSWORD] : [];
}

function assertPositive(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function assertNonNegative(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

function isLocalPostgresHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === 'postgres') return true;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  const octets = normalized.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}
