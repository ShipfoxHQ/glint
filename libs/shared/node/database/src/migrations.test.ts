import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {closePostgresClient, createPostgresClient, type Pool} from '@shipfox/node-postgres';
import {afterAll, beforeAll, describe, expect, it} from '@shipfox/vitest/vi';
import {loadDatabaseEnvironment} from './config.js';
import {migrationTableName, runOrderedMigrations} from './migrations.js';
import {PostgresDatabase, poolConfig} from './postgres.js';

const integrationEnabled = process.env.GLINT_POSTGRES_TEST === '1';
const foundationDirectory = fileURLToPath(
  new URL('./test-fixtures/migrations/foundation', import.meta.url),
);
const dependentDirectory = fileURLToPath(
  new URL('./test-fixtures/migrations/dependent', import.meta.url),
);

describe('ordered migration model', () => {
  it('creates stable, isolated PostgreSQL identifiers', () => {
    expect(migrationTableName('Outbox')).toMatch(/^glint_outbox_[a-f0-9]{10}_migrations$/);
    expect(migrationTableName('Outbox')).toBe(migrationTableName(' outbox '));
    expect(migrationTableName('a'.repeat(100))).toHaveLength(60);
  });

  it('rejects duplicate module names before applying the duplicate', async () => {
    const fakeDatabase = {} as PostgresDatabase['drizzle'];
    await expect(
      runOrderedMigrations(fakeDatabase, [
        {name: 'same', directory: foundationDirectory},
        {name: ' SAME ', directory: dependentDirectory},
      ]),
    ).rejects.toThrow('Duplicate migration module');
  });
});

describe.runIf(integrationEnabled)('ordered PostgreSQL 18 migrations', () => {
  let databaseName = '';
  let database: PostgresDatabase | undefined;
  let pool: Pool | undefined;

  beforeAll(async () => {
    const baseConfig = poolConfig(loadDatabaseEnvironment());
    databaseName = `glint_migration_test_${randomUUID().replaceAll('-', '')}`;
    const adminPool = createPostgresClient({...baseConfig, database: 'postgres'});
    try {
      await adminPool.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await closePostgresClient();
    }
    pool = createPostgresClient({...baseConfig, database: databaseName});
    database = new PostgresDatabase({pool, close: closePostgresClient});
    await database.initialize();
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

  it('runs fresh migrations once in the provided dependency order', async () => {
    if (!database || !pool) throw new Error('PostgreSQL migration fixture was not initialized.');
    const ordered = [
      {name: 'foundation', directory: foundationDirectory},
      {name: 'dependent', directory: dependentDirectory},
    ] as const;

    await runOrderedMigrations(database.drizzle, ordered);
    await runOrderedMigrations(database.drizzle, ordered);

    const rows = await pool.query<{module_name: string; position: number}>(
      'SELECT position, module_name FROM glint_migration_order ORDER BY position',
    );
    expect(rows.rows).toEqual([
      {position: 1, module_name: 'foundation'},
      {position: 2, module_name: 'dependent'},
    ]);

    const histories = await pool.query<{table_name: string}>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'drizzle'
      ORDER BY table_name
    `);
    expect(histories.rows.map(({table_name}) => table_name)).toEqual([
      migrationTableName('dependent'),
      migrationTableName('foundation'),
    ]);
  });
});
