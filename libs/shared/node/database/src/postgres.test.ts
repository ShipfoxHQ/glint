import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {closePostgresClient, createPostgresClient, type Pool} from '@shipfox/node-postgres';
import {afterAll, beforeAll, describe, expect, it, vi} from '@shipfox/vitest/vi';
import {sql} from 'drizzle-orm';
import {loadDatabaseEnvironment} from './config.js';
import {databaseContractTests} from './contract-test-kit.js';
import {mapPostgresError, PostgresDatabase, poolConfig} from './postgres.js';
import type {DatabaseTransaction} from './types.js';

const integrationEnabled = process.env.GLINT_POSTGRES_TEST === '1';

describe('PostgresDatabase readiness', () => {
  it('caches an actionable failure without logging credentials', async () => {
    const connectionError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), {
      code: 'ECONNREFUSED',
    });
    const query = vi.fn().mockRejectedValue(connectionError);
    const error = vi.fn();
    const pool = Object.assign(new EventEmitter(), {end: vi.fn(), query}) as unknown as Pool;
    const database = new PostgresDatabase({
      pool,
      logger: {
        child: vi.fn(),
        debug: vi.fn(),
        error,
        fatal: vi.fn(),
        info: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(),
      },
    });

    await expect(database.initialize()).rejects.toBe(connectionError);
    await expect(database.health()).resolves.toMatchObject({
      status: 'unavailable',
      detail: expect.stringContaining('ECONNREFUSED'),
    });
    await expect(database.assertReady()).rejects.toThrow('ECONNREFUSED');
    expect(error).toHaveBeenCalledWith('PostgreSQL connection is unavailable.', {
      code: 'ECONNREFUSED',
      errorType: 'Error',
      operation: 'startup',
    });
  });

  it('logs discarded idle clients without permanently failing readiness', async () => {
    const warn = vi.fn();
    const pool = Object.assign(new EventEmitter(), {
      end: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({rowCount: 1, rows: [{lc_messages: 'C'}]}),
    }) as unknown as Pool;
    const database = new PostgresDatabase({
      pool,
      logger: {
        child: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        info: vi.fn(),
        trace: vi.fn(),
        warn,
      },
    });
    await database.initialize();

    pool.emit('error', new Error('Connection terminated unexpectedly'));

    await expect(database.health()).resolves.toMatchObject({status: 'ready'});
    expect(warn).toHaveBeenCalledWith(
      'PostgreSQL discarded an idle client after a connection error.',
      {
        errorType: 'Error',
        operation: 'idle',
      },
    );
    await database.close();
  });

  it('rejects locales that make cancellation messages unsafe to classify', async () => {
    const pool = Object.assign(new EventEmitter(), {
      end: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({rowCount: 1, rows: [{lc_messages: 'fr_FR.UTF-8'}]}),
    }) as unknown as Pool;
    const database = new PostgresDatabase({pool});

    await expect(database.initialize()).rejects.toThrow(
      'PostgreSQL lc_messages must use an English locale',
    );
    await expect(database.health()).resolves.toMatchObject({status: 'unavailable'});
    await database.close();
  });

  it('observes code-less connection failures outside managed transactions', async () => {
    const error = vi.fn();
    const pool = Object.assign(new EventEmitter(), {
      end: vi.fn().mockResolvedValue(undefined),
      query: vi.fn(),
    }) as unknown as Pool;
    const database = new PostgresDatabase({
      pool,
      logger: {
        child: vi.fn(),
        debug: vi.fn(),
        error,
        fatal: vi.fn(),
        info: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(),
      },
    });
    const connectionError = new Error('timeout exceeded when trying to connect');

    await expect(
      database.runObserved('outbox.claim', () => Promise.reject(connectionError)),
    ).rejects.toBe(connectionError);
    await expect(database.health()).resolves.toMatchObject({status: 'unavailable'});
    expect(error).toHaveBeenCalledWith('PostgreSQL connection is unavailable.', {
      errorType: 'Error',
      operation: 'outbox.claim',
    });
    await database.close();
  });

  it('requires a successful probe before an observed callback restores readiness', async () => {
    const connectionError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), {
      code: 'ECONNREFUSED',
    });
    const pool = Object.assign(new EventEmitter(), {
      end: vi.fn().mockResolvedValue(undefined),
      query: vi
        .fn()
        .mockResolvedValueOnce({rowCount: 1, rows: [{lc_messages: 'C'}]})
        .mockRejectedValue(connectionError),
    }) as unknown as Pool;
    const database = new PostgresDatabase({pool});

    await database.initialize();
    await expect(
      database.runObserved('outbox.claim', () => Promise.reject(connectionError)),
    ).rejects.toBe(connectionError);
    await expect(database.runObserved('outbox.claim', () => Promise.resolve([]))).rejects.toBe(
      connectionError,
    );
    await expect(database.health()).resolves.toMatchObject({status: 'unavailable'});
    expect(pool.query).toHaveBeenCalledWith("SELECT current_setting('lc_messages') AS lc_messages");
    await database.close();
  });

  it('records non-connection recovery failures with current diagnostics', async () => {
    const connectionError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), {
      code: 'ECONNREFUSED',
    });
    const error = vi.fn();
    const pool = Object.assign(new EventEmitter(), {
      end: vi.fn().mockResolvedValue(undefined),
      query: vi
        .fn()
        .mockResolvedValueOnce({rowCount: 1, rows: [{lc_messages: 'C'}]})
        .mockResolvedValueOnce({rowCount: 0, rows: []}),
    }) as unknown as Pool;
    const database = new PostgresDatabase({
      pool,
      logger: {
        child: vi.fn(),
        debug: vi.fn(),
        error,
        fatal: vi.fn(),
        info: vi.fn(),
        trace: vi.fn(),
        warn: vi.fn(),
      },
    });

    await database.initialize();
    await expect(
      database.runObserved('outbox.claim', () => Promise.reject(connectionError)),
    ).rejects.toBe(connectionError);
    await expect(database.runObserved('outbox.claim', () => Promise.resolve([]))).rejects.toThrow(
      'PostgreSQL readiness query returned no row.',
    );
    await expect(database.health()).resolves.toMatchObject({
      status: 'unavailable',
      detail: 'PostgreSQL: PostgreSQL readiness query returned no row.',
    });
    expect(error).toHaveBeenLastCalledWith('PostgreSQL connection is unavailable.', {
      errorType: 'Error',
      operation: 'readiness-recovery',
    });
    await database.close();
  });

  it('shares one recovery probe across concurrent observed operations', async () => {
    const connectionError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), {
      code: 'ECONNREFUSED',
    });
    let resolveRecovery:
      | ((result: {rowCount: number; rows: {lc_messages: string}[]}) => void)
      | undefined;
    const recovery = new Promise<{rowCount: number; rows: {lc_messages: string}[]}>((resolve) => {
      resolveRecovery = resolve;
    });
    const query = vi
      .fn()
      .mockResolvedValueOnce({rowCount: 1, rows: [{lc_messages: 'C'}]})
      .mockReturnValueOnce(recovery);
    const pool = Object.assign(new EventEmitter(), {
      end: vi.fn().mockResolvedValue(undefined),
      query,
    }) as unknown as Pool;
    const database = new PostgresDatabase({pool});

    await database.initialize();
    await expect(
      database.runObserved('outbox.claim', () => Promise.reject(connectionError)),
    ).rejects.toBe(connectionError);
    const operations = [
      database.runObserved('outbox.claim', () => Promise.resolve('claim')),
      database.runObserved('outbox.acknowledge', () => Promise.resolve('acknowledge')),
      database.runObserved('outbox.retry', () => Promise.resolve('retry')),
    ];
    await Promise.resolve();
    expect(query).toHaveBeenCalledTimes(2);
    if (!resolveRecovery) throw new Error('Expected a pending recovery query.');
    resolveRecovery({rowCount: 1, rows: [{lc_messages: 'C'}]});

    await expect(Promise.all(operations)).resolves.toEqual(['claim', 'acknowledge', 'retry']);
    await expect(database.health()).resolves.toMatchObject({status: 'ready'});
    expect(query).toHaveBeenCalledTimes(2);
    await database.close();
  });

  it('maps only statement-timeout cancellations to the neutral timeout error', () => {
    const externalCancellation = Object.assign(
      new Error('canceling statement due to user request'),
      {code: '57014'},
    );
    const statementTimeout = new Error('database operation failed', {
      cause: Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      }),
    });

    expect(mapPostgresError(externalCancellation, {statementTimeoutMs: 5})).toBe(
      externalCancellation,
    );
    expect(mapPostgresError(statementTimeout, {statementTimeoutMs: 5})).toMatchObject({
      code: 'statement_timeout',
      timeoutMs: 5,
    });
  });
});

describe.runIf(integrationEnabled)('PostgresDatabase PostgreSQL 18 contract', () => {
  let databaseName = '';
  let database: PostgresDatabase | undefined;
  let pool: Pool | undefined;

  beforeAll(async () => {
    const baseConfig = poolConfig(loadDatabaseEnvironment());
    databaseName = `glint_database_test_${randomUUID().replaceAll('-', '')}`;
    const adminPool = createPostgresClient({...baseConfig, database: 'postgres'});
    try {
      await adminPool.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await closePostgresClient();
    }

    pool = createPostgresClient({...baseConfig, database: databaseName});
    database = new PostgresDatabase({pool, close: closePostgresClient});
    await database.initialize();

    const startupState = await pool.query<{outbox: string | null}>(
      "SELECT to_regclass('public.glint_outbox')::text AS outbox",
    );
    expect(startupState.rows[0]?.outbox).toBeNull();

    await pool.query(`
      CREATE TABLE glint_database_contract_values (
        account_id text NOT NULL,
        key text NOT NULL,
        value text NOT NULL,
        PRIMARY KEY (account_id, key)
      )
    `);
  });

  afterAll(async () => {
    if (database) {
      await database.close();
    } else {
      await closePostgresClient();
    }
    if (!databaseName) return;
    const adminPool = createPostgresClient({
      ...poolConfig(loadDatabaseEnvironment()),
      database: 'postgres',
    });
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await closePostgresClient();
    }
  });

  databaseContractTests('postgres', () => {
    if (!database) throw new Error('PostgreSQL database fixture was not initialized.');
    const activeDatabase = database;
    return {
      database: activeDatabase,
      write: (transaction, key, value) =>
        activeDatabase.useTransaction(transaction, async (tx) => {
          await tx.execute(sql`
          INSERT INTO glint_database_contract_values (account_id, key, value)
          VALUES (
            COALESCE(NULLIF(current_setting('glint.account_id', true), ''), 'global'),
            ${key},
            ${value}
          )
          ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value
          `);
        }),
      read: (transaction, key) =>
        activeDatabase.useTransaction(transaction, async (tx) => {
          const result = await tx.execute<{value: string}>(sql`
          SELECT value
          FROM glint_database_contract_values
          WHERE account_id = COALESCE(
            NULLIF(current_setting('glint.account_id', true), ''),
            'global'
          ) AND key = ${key}
          `);
          return result.rows[0]?.value;
        }),
    };
  });

  it('maps PostgreSQL statement cancellation to the neutral timeout error', async () => {
    if (!database) throw new Error('PostgreSQL database fixture was not initialized.');
    const activeDatabase = database;
    await expect(
      activeDatabase.transaction(
        (transaction) =>
          activeDatabase.useTransaction(transaction, async (tx) => {
            await tx.execute(sql`SELECT pg_sleep(0.05)`);
          }),
        {statementTimeoutMs: 5},
      ),
    ).rejects.toMatchObject({code: 'statement_timeout', timeoutMs: 5});
  });

  it('rejects a transaction handle after its callback ends', async () => {
    if (!database) throw new Error('PostgreSQL database fixture was not initialized.');
    const activeDatabase = database;
    let completed: DatabaseTransaction | undefined;
    await activeDatabase.transaction((transaction) => {
      completed = transaction;
      return Promise.resolve();
    });
    if (!completed) throw new Error('Expected a completed transaction handle.');
    const inactiveTransaction = completed as DatabaseTransaction;
    expect(() =>
      activeDatabase.useTransaction(inactiveTransaction, () => Promise.resolve()),
    ).toThrow(expect.objectContaining({code: 'transaction_not_active'}));
  });

  it('reports readiness from cached state without querying PostgreSQL', async () => {
    if (!database || !pool) throw new Error('PostgreSQL database fixture was not initialized.');
    const query = vi.spyOn(pool, 'query');
    const callsBeforeHealth = query.mock.calls.length;
    await expect(database.health()).resolves.toMatchObject({status: 'ready'});
    await expect(database.assertReady()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(callsBeforeHealth);
  });
});
