import {describe, expect, it} from '@shipfox/vitest/vi';
import {
  collectSensitiveValues,
  defineEnvironmentSchema,
  describeEnvironment,
  environmentVariable,
  type InvalidConfigurationError,
  loadEnvironment,
  port,
  str,
} from './index.js';

const schema = defineEnvironmentSchema({
  DATABASE_URL: environmentVariable(str(), {
    description: 'PostgreSQL connection URL used by API, worker, and migration processes.',
    sensitive: true,
  }),
  PORT: environmentVariable(port({default: 3000}), {
    description: 'Port where the process accepts traffic.',
  }),
  RUNTIME_NAME: environmentVariable(str(), {
    description: 'Stable runtime name included in diagnostics.',
  }),
});

describe('loadEnvironment', () => {
  it('loads a flat typed environment and applies defaults', () => {
    const config = loadEnvironment(schema, {
      DATABASE_URL: 'postgres://glint:secret@localhost/glint',
      RUNTIME_NAME: 'api',
    });

    expect(config.PORT).toBe(3000);
    expect(config.RUNTIME_NAME).toBe('api');
  });

  it('fails startup with every invalid key and its self-hosting description', () => {
    expect(() =>
      loadEnvironment(schema, {
        PORT: 'not-a-port',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<InvalidConfigurationError>>({
        message: expect.stringContaining(
          'RUNTIME_NAME: Required value is missing. Stable runtime name included in diagnostics.',
        ),
        issues: expect.arrayContaining([
          expect.objectContaining({key: 'DATABASE_URL', problem: 'Invalid or missing secret.'}),
          expect.objectContaining({key: 'PORT'}),
          expect.objectContaining({key: 'RUNTIME_NAME'}),
        ]),
      }),
    );
  });

  it('never includes a configured secret in validation errors', () => {
    const secret = 'postgres://glint:do-not-log@localhost/glint';
    const secretSchema = defineEnvironmentSchema({
      DATABASE_URL: environmentVariable(port(), {
        description: 'A deliberately mismatched secret validator for this test.',
        sensitive: true,
      }),
    });

    expect(() => loadEnvironment(secretSchema, {DATABASE_URL: secret})).toThrowError(
      expect.not.objectContaining({message: expect.stringContaining(secret)}),
    );
  });
});

describe('environment schema metadata', () => {
  it('publishes descriptions and configured values for redaction without exposing values in docs', () => {
    const config = loadEnvironment(schema, {
      DATABASE_URL: 'postgres://glint:secret@localhost/glint',
      RUNTIME_NAME: 'worker',
    });

    expect(describeEnvironment(schema)).toEqual([
      {
        description: 'PostgreSQL connection URL used by API, worker, and migration processes.',
        key: 'DATABASE_URL',
        sensitive: true,
      },
      {
        description: 'Port where the process accepts traffic.',
        key: 'PORT',
        sensitive: false,
      },
      {
        description: 'Stable runtime name included in diagnostics.',
        key: 'RUNTIME_NAME',
        sensitive: false,
      },
    ]);
    expect(collectSensitiveValues(schema, config)).toEqual([
      'postgres://glint:secret@localhost/glint',
    ]);
  });

  it('rejects nested-looking keys and missing descriptions when defining a schema', () => {
    expect(() =>
      defineEnvironmentSchema({
        'DATABASE.URL': environmentVariable(str(), {description: 'Not flat.'}),
      }),
    ).toThrow('flat UPPER_SNAKE_CASE');
    expect(() =>
      defineEnvironmentSchema({EMPTY_DESCRIPTION: environmentVariable(str(), {description: ' '})}),
    ).toThrow('must include a description');
  });
});
