import {randomUUID} from 'node:crypto';
import {
  loadDatabaseEnvironment,
  PostgresDatabase,
  poolConfig,
  runOrderedMigrations,
} from '@glint/node-database';
import {closePostgresClient, createPostgresClient, type Pool} from '@shipfox/node-postgres';
import {afterAll, beforeAll, describe, expect, it, vi} from '@shipfox/vitest/vi';
import {sql} from 'drizzle-orm';
import {transactionalOutboxContractTests} from './contract-test-kit.js';
import {POSTGRES_OUTBOX_MIGRATION, PostgresTransactionalOutbox} from './postgres.js';

const integrationEnabled = process.env.GLINT_POSTGRES_TEST === '1';

describe.runIf(integrationEnabled)('PostgresTransactionalOutbox PostgreSQL 18 contract', () => {
  let databaseName = '';
  let database: PostgresDatabase | undefined;
  let pool: Pool | undefined;

  beforeAll(async () => {
    const baseConfig = poolConfig(loadDatabaseEnvironment());
    databaseName = `glint_outbox_test_${randomUUID().replaceAll('-', '')}`;
    const adminPool = createPostgresClient({...baseConfig, database: 'postgres'});
    try {
      await adminPool.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await closePostgresClient();
    }

    pool = createPostgresClient({...baseConfig, database: databaseName});
    database = new PostgresDatabase({pool, close: closePostgresClient});
    await database.initialize();
    const beforeMigrations = await pool.query<{table_name: string | null}>(
      "SELECT to_regclass('public.glint_outbox')::text AS table_name",
    );
    expect(beforeMigrations.rows[0]?.table_name).toBeNull();

    await runOrderedMigrations(database.drizzle, [POSTGRES_OUTBOX_MIGRATION]);
    await pool.query(`
      CREATE TABLE glint_outbox_domain (
        id text PRIMARY KEY,
        value text NOT NULL
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

  transactionalOutboxContractTests('postgres', async () => {
    if (!database || !pool) throw new Error('PostgreSQL outbox fixture was not initialized.');
    await pool.query('TRUNCATE glint_outbox, glint_outbox_domain');
    let now = Date.parse('2030-01-01T00:00:00Z');
    const maxAttempts = 2;
    return {
      database,
      maxAttempts,
      outbox: new PostgresTransactionalOutbox({
        database,
        clock: () => new Date(now),
        maxAttempts,
      }),
      advanceBy: (milliseconds: number) => {
        now += milliseconds;
      },
    };
  });

  it('commits and rolls back a domain write with its event atomically', async () => {
    if (!database || !pool) throw new Error('PostgreSQL outbox fixture was not initialized.');
    const activeDatabase = database;
    await pool.query('TRUNCATE glint_outbox, glint_outbox_domain');
    const now = new Date('2030-01-01T00:00:00Z');
    const outbox = new PostgresTransactionalOutbox({database: activeDatabase, clock: () => now});

    await activeDatabase.transaction(async (transaction) => {
      await activeDatabase.useTransaction(transaction, async (tx) => {
        await tx.execute(sql`
          INSERT INTO glint_outbox_domain (id, value) VALUES ('committed', 'yes')
        `);
      });
      await outbox.append(transaction, {
        id: 'domain:committed',
        topic: 'foundation.probe.v1',
        payload: {id: 'committed'},
        occurredAt: now,
        correlationId: '',
        traceParent: '',
      });
    });

    await expect(
      activeDatabase.transaction(async (transaction) => {
        await activeDatabase.useTransaction(transaction, async (tx) => {
          await tx.execute(sql`
            INSERT INTO glint_outbox_domain (id, value) VALUES ('rolled-back', 'no')
          `);
        });
        await outbox.append(transaction, {
          id: 'domain:rolled-back',
          topic: 'foundation.probe.v1',
          payload: {id: 'rolled-back'},
          occurredAt: now,
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const domainRows = await pool.query<{id: string}>('SELECT id FROM glint_outbox_domain');
    expect(domainRows.rows).toEqual([{id: 'committed'}]);
    const [delivery] = await outbox.claim({
      dispatcherId: 'dispatcher',
      maximumEvents: 10,
      leaseDurationMs: 1_000,
    });
    expect(delivery?.event).toMatchObject({
      id: 'domain:committed',
      correlationId: '',
      traceParent: '',
    });
  });

  it('exposes bounded dead-letter results through the neutral adapter', async () => {
    if (!database || !pool) throw new Error('PostgreSQL outbox fixture was not initialized.');
    await pool.query('TRUNCATE glint_outbox');
    const now = new Date('2030-01-01T00:00:00Z');
    const outbox = new PostgresTransactionalOutbox({
      database,
      clock: () => now,
      maxAttempts: 1,
    });
    await database.transaction((transaction) =>
      outbox.append(transaction, {
        id: 'poison-event',
        topic: 'foundation.probe.v1',
        payload: {},
        occurredAt: now,
      }),
    );
    const [delivery] = await outbox.claim({
      dispatcherId: 'dispatcher',
      maximumEvents: 1,
      leaseDurationMs: 1_000,
    });
    if (!delivery) throw new Error('Expected a poison-event delivery.');
    await expect(
      outbox.retry({...delivery, delayMs: 1_000, failure: new Error('poison')}),
    ).resolves.toEqual({status: 'dead-lettered'});
    await expect(
      outbox.claim({dispatcherId: 'dispatcher', maximumEvents: 1, leaseDurationMs: 1_000}),
    ).resolves.toEqual([]);
  });

  it('reports cached health without querying PostgreSQL', async () => {
    if (!database || !pool) throw new Error('PostgreSQL outbox fixture was not initialized.');
    const outbox = new PostgresTransactionalOutbox({database});
    const query = vi.spyOn(pool, 'query');
    const callsBeforeHealth = query.mock.calls.length;

    await expect(outbox.health()).resolves.toMatchObject({status: 'ready'});
    expect(query).toHaveBeenCalledTimes(callsBeforeHealth);
  });
});
