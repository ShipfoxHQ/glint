import {randomUUID} from 'node:crypto';
import {loadDatabaseEnvironment, PostgresDatabase, poolConfig} from '@glint/node-database';
import {closePostgresClient, createPostgresClient, type Pool} from '@shipfox/node-postgres';
import {afterAll, beforeAll, describe, expect, it} from '@shipfox/vitest/vi';
import {migrate} from './migrate.js';

const enabled = process.env.GLINT_POSTGRES_TEST === '1';

describe.runIf(enabled)('full migration composition', () => {
  let databaseName = '';
  let database: PostgresDatabase | undefined;
  let pool: Pool | undefined;
  beforeAll(async () => {
    const config = poolConfig(loadDatabaseEnvironment());
    databaseName = `glint_migrate_test_${randomUUID().replaceAll('-', '')}`;
    const admin = createPostgresClient({...config, database: 'postgres'});
    try {
      await admin.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await closePostgresClient();
    }
    pool = createPostgresClient({...config, database: databaseName});
    database = new PostgresDatabase({pool, close: closePostgresClient});
    await database.initialize();
  });
  afterAll(async () => {
    if (database) await database.close();
    else await closePostgresClient();
    if (!databaseName) return;
    const admin = createPostgresClient({
      ...poolConfig(loadDatabaseEnvironment()),
      database: 'postgres',
    });
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await closePostgresClient();
    }
  });
  it('creates all composed tables and remains a no-op on repeat', async () => {
    if (!database || !pool) throw new Error('PostgreSQL fixture was not initialized.');
    await expect(migrate(database)).resolves.toEqual(['outbox', 'accounts', 'projects']);
    const names = [
      'accounts',
      'accounts_installations',
      'repositories',
      'projects',
      'project_tokens',
      'idempotency_records',
    ];
    const tables = await pool.query<{table_name: string}>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(tables.rows.map(({table_name}) => table_name)).toEqual(expect.arrayContaining(names));
    await expect(migrate(database)).resolves.toEqual(['outbox', 'accounts', 'projects']);
  });
});
