import {randomUUID} from 'node:crypto';
import {closePostgresClient, createPostgresClient, type Pool} from '@shipfox/node-postgres';
import {afterAll, beforeAll, describe, expect, it, vi} from '@shipfox/vitest/vi';
import {sql} from 'drizzle-orm';
import {loadDatabaseEnvironment} from './config.js';
import {databaseContractTests} from './contract-test-kit.js';
import {PostgresDatabase, poolConfig} from './postgres.js';
import type {DatabaseTransaction} from './types.js';

const integrationEnabled = process.env.GLINT_POSTGRES_TEST === '1';

describe('PostgresDatabase readiness', () => {
  it('caches an actionable failure without logging credentials', async () => {
    const connectionError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), {
      code: 'ECONNREFUSED',
    });
    const query = vi.fn().mockRejectedValue(connectionError);
    const error = vi.fn();
    const pool = {end: vi.fn(), query} as unknown as Pool;
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
});

describe.runIf(integrationEnabled)('PostgresDatabase PostgreSQL 18 contract', () => {
  let databaseName = '';
  let database: PostgresDatabase;
  let pool: Pool;

  beforeAll(async () => {
    const baseConfig = poolConfig(loadDatabaseEnvironment());
    databaseName = `glint_database_test_${randomUUID().replaceAll('-', '')}`;
    const adminPool = createPostgresClient({...baseConfig, database: 'postgres'});
    await adminPool.query(`CREATE DATABASE ${databaseName}`);
    await closePostgresClient();

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
    await database.close();
    const adminPool = createPostgresClient({
      ...poolConfig(loadDatabaseEnvironment()),
      database: 'postgres',
    });
    await adminPool.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await closePostgresClient();
  });

  databaseContractTests('postgres', () => ({
    database,
    write: (transaction, key, value) =>
      database.useTransaction(transaction, async (tx) => {
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
      database.useTransaction(transaction, async (tx) => {
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
  }));

  it('maps PostgreSQL statement cancellation to the neutral timeout error', async () => {
    await expect(
      database.transaction(
        (transaction) =>
          database.useTransaction(transaction, async (tx) => {
            await tx.execute(sql`SELECT pg_sleep(0.05)`);
          }),
        {statementTimeoutMs: 5},
      ),
    ).rejects.toMatchObject({code: 'statement_timeout', timeoutMs: 5});
  });

  it('rejects a transaction handle after its callback ends', async () => {
    let completed: DatabaseTransaction | undefined;
    await database.transaction((transaction) => {
      completed = transaction;
      return Promise.resolve();
    });
    if (!completed) throw new Error('Expected a completed transaction handle.');
    const inactiveTransaction = completed as DatabaseTransaction;
    expect(() => database.useTransaction(inactiveTransaction, () => Promise.resolve())).toThrow(
      expect.objectContaining({code: 'transaction_not_active'}),
    );
  });

  it('reports readiness from cached state without querying PostgreSQL', async () => {
    const query = vi.spyOn(pool, 'query');
    const callsBeforeHealth = query.mock.calls.length;
    await expect(database.health()).resolves.toMatchObject({status: 'ready'});
    await expect(database.assertReady()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(callsBeforeHealth);
  });
});
