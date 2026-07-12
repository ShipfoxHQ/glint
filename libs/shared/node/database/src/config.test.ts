import {describe, expect, it} from '@shipfox/vitest/vi';
import {
  databaseEnvironmentSecrets,
  describeDatabaseEnvironment,
  loadDatabaseEnvironment,
} from './config.js';
import {poolConfig} from './postgres.js';

describe('database environment', () => {
  it('loads the isolated local PostgreSQL defaults', () => {
    expect(loadDatabaseEnvironment({})).toEqual({
      POSTGRES_HOST: '127.0.0.1',
      POSTGRES_PORT: 5432,
      POSTGRES_USERNAME: 'glint',
      POSTGRES_PASSWORD: 'local-glint',
      POSTGRES_DATABASE: 'glint',
      POSTGRES_MAX_CONNECTIONS: 10,
      POSTGRES_CONNECTION_TIMEOUT_MS: 5_000,
      POSTGRES_IDLE_TIMEOUT_MS: 10_000,
      POSTGRES_TLS_MODE: 'disable',
    });
  });

  it('maps managed serverless configuration to one verified connection', () => {
    const environment = loadDatabaseEnvironment({
      POSTGRES_HOST: 'pool.example.neon.tech',
      POSTGRES_PORT: '5432',
      POSTGRES_USERNAME: 'glint_app',
      POSTGRES_PASSWORD: 'managed-secret',
      POSTGRES_DATABASE: 'glint',
      POSTGRES_MAX_CONNECTIONS: '1',
      POSTGRES_CONNECTION_TIMEOUT_MS: '5000',
      POSTGRES_IDLE_TIMEOUT_MS: '10000',
      POSTGRES_TLS_MODE: 'verify-full',
    });

    expect(poolConfig(environment)).toMatchObject({
      host: 'pool.example.neon.tech',
      max: 1,
      ssl: {rejectUnauthorized: true},
    });
    expect(databaseEnvironmentSecrets(environment)).toEqual(['managed-secret']);
  });

  it.each([
    ['POSTGRES_MAX_CONNECTIONS', '0'],
    ['POSTGRES_CONNECTION_TIMEOUT_MS', '-1'],
    ['POSTGRES_IDLE_TIMEOUT_MS', '-1'],
  ])('rejects invalid %s values', (key, value) => {
    expect(() => loadDatabaseEnvironment({[key]: value})).toThrow(key);
  });

  it('describes every variable and marks only the password as sensitive', () => {
    const descriptions = describeDatabaseEnvironment();
    expect(descriptions).toHaveLength(9);
    expect(descriptions.find(({key}) => key === 'POSTGRES_PASSWORD')).toMatchObject({
      sensitive: true,
    });
    expect(descriptions.every(({description}) => description.length > 0)).toBe(true);
  });
});
