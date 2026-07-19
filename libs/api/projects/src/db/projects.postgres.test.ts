import {randomUUID} from 'node:crypto';
import {
  type DatabaseTransaction,
  loadDatabaseEnvironment,
  PostgresDatabase,
  type PostgresDrizzleTransaction,
  poolConfig,
  runOrderedMigrations,
  type TransactionOptions,
} from '@glint/node-database';
import {closePostgresClient, createPostgresClient, type Pool} from '@shipfox/node-postgres';
import {afterAll, beforeAll, describe, expect, it} from '@shipfox/vitest/vi';
import {sql} from 'drizzle-orm';
import {PROJECTS_MIGRATION} from '../migration.js';
import {createPostgresProjectsRepositories} from './factory.js';

const enabled = process.env.GLINT_POSTGRES_TEST === '1';
const accountA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const accountB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor = '11111111-1111-4111-8111-111111111111';

describe.runIf(enabled)('projects PostgreSQL migration and RLS', () => {
  let databaseName = '';
  let database: PostgresDatabase | undefined;
  let pool: Pool | undefined;
  let requestRole = '';
  let repositoryA = '';
  let repositoryB = '';
  let projectA = '';

  beforeAll(async () => {
    const config = poolConfig(loadDatabaseEnvironment());
    databaseName = `glint_projects_test_${randomUUID().replaceAll('-', '')}`;
    const admin = createPostgresClient({...config, database: 'postgres'});
    try {
      await admin.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await closePostgresClient();
    }
    pool = createPostgresClient({...config, database: databaseName});
    database = new PostgresDatabase({pool, close: closePostgresClient});
    await database.initialize();
    await runOrderedMigrations(database.drizzle, [PROJECTS_MIGRATION]);
    requestRole = `glint_projects_request_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE ROLE ${requestRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON repositories, projects, project_tokens, idempotency_records TO ${requestRole}`,
    );
    const seed = await pool.query<{id: string}>(
      `INSERT INTO repositories (account_id, provider, installation_id, provider_repository_id, owner_login, name, default_branch, visibility) VALUES ('${accountA}', 'github', '${randomUUID()}', 'a', 'glint', 'a', 'main', 'private'), ('${accountB}', 'github', '${randomUUID()}', 'b', 'glint', 'b', 'main', 'private') RETURNING id`,
    );
    repositoryA = seed.rows[0]?.id ?? '';
    repositoryB = seed.rows[1]?.id ?? '';
    const project = await pool.query<{id: string}>(
      `INSERT INTO projects (account_id, repository_id, slug, name, created_by) VALUES ('${accountA}', '${repositoryA}', 'a', 'A', '${actor}') RETURNING id`,
    );
    projectA = project.rows[0]?.id ?? '';
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
      await admin.query(`DROP ROLE IF EXISTS ${requestRole}`);
    } finally {
      await closePostgresClient();
    }
  });
  function asRequest<T>(
    options: TransactionOptions,
    operation: (tx: PostgresDrizzleTransaction) => Promise<T>,
  ): Promise<T> {
    const activeDatabase = database;
    if (!activeDatabase) throw new Error('PostgreSQL fixture was not initialized.');
    return activeDatabase.transaction(
      (transaction) =>
        activeDatabase.useTransaction(transaction, async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL ROLE ${requestRole}`));
          return operation(tx);
        }),
      options,
    );
  }
  function asRequestTransaction<T>(
    options: TransactionOptions,
    operation: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    const activeDatabase = database;
    if (!activeDatabase) throw new Error('PostgreSQL fixture was not initialized.');
    return activeDatabase.transaction(async (transaction) => {
      await activeDatabase.useTransaction(transaction, (tx) =>
        tx.execute(sql.raw(`SET LOCAL ROLE ${requestRole}`)),
      );
      return operation(transaction);
    }, options);
  }
  it('isolates every tenant table and fails cross-account writes closed', async () => {
    for (const table of ['repositories', 'projects', 'project_tokens', 'idempotency_records']) {
      const rows = await asRequest({tenant: {accountId: accountA}}, (tx) =>
        tx.execute(sql.raw(`SELECT * FROM ${table}`)),
      );
      expect(rows.rows.every((row) => row.account_id === accountA)).toBe(true);
      const global = await asRequest({}, (tx) => tx.execute(sql.raw(`SELECT * FROM ${table}`)));
      expect(global.rows).toEqual([]);
    }
    await expect(
      asRequest({tenant: {accountId: accountA}}, (tx) =>
        tx.execute(
          sql`INSERT INTO idempotency_records (account_id, actor, route, idempotency_key, request_digest, expires_at) VALUES (${accountB}, ${actor}, '/projects', 'cross-account', 'digest', now() + interval '1 day')`,
        ),
      ),
    ).rejects.toMatchObject({cause: {code: '42501'}});
  });
  it('enforces composite relationships and repeat migrations', async () => {
    if (!pool || !database) throw new Error('PostgreSQL fixture was not initialized.');
    await expect(
      pool.query(
        `INSERT INTO projects (account_id, repository_id, slug, name, created_by) VALUES ('${accountA}', '${repositoryB}', 'wrong-parent', 'Wrong', '${actor}')`,
      ),
    ).rejects.toMatchObject({code: '23503'});
    await expect(
      pool.query(
        `INSERT INTO project_tokens (account_id, project_id, label, token_prefix, token_digest, created_by) VALUES ('${accountB}', '${projectA}', 'wrong-parent', 'prefix-wrong', 'digest-wrong', '${actor}')`,
      ),
    ).rejects.toMatchObject({code: '23503'});
    await runOrderedMigrations(database.drizzle, [PROJECTS_MIGRATION]);
    expect(
      (await pool.query(`SELECT id FROM projects WHERE id = '${projectA}'`)).rows,
    ).toHaveLength(1);
  });
  it('converges repository/project/idempotency writes and permits token-label reuse after revocation', async () => {
    if (!database) throw new Error('PostgreSQL fixture was not initialized.');
    const ports = createPostgresProjectsRepositories(database);
    const inputs = ['one', 'two'].map((name) =>
      asRequestTransaction({tenant: {accountId: accountA}}, (transaction) =>
        ports.repositories.upsertByProviderRepository(transaction, {
          accountId: accountA,
          provider: 'github',
          installationId: randomUUID(),
          providerRepositoryId: 'convergent',
          ownerLogin: 'glint',
          name,
          defaultBranch: 'main',
          visibility: 'private',
          accessState: 'active',
        }),
      ),
    );
    const repositories = await Promise.all(inputs);
    expect(new Set(repositories.map(({id}) => id)).size).toBe(1);
    const repositoryId = repositories[0]?.id ?? '';
    await asRequestTransaction({tenant: {accountId: accountA}}, (transaction) =>
      ports.repositories.setAccessState(transaction, repositoryId, 'removed'),
    );
    await expect(
      asRequestTransaction({tenant: {accountId: accountA}}, (transaction) =>
        ports.repositories.upsertByProviderRepository(transaction, {
          accountId: accountA,
          provider: 'github',
          installationId: randomUUID(),
          providerRepositoryId: 'convergent',
          ownerLogin: 'glint',
          name: 'Reconnected',
          defaultBranch: 'main',
          visibility: 'private',
          accessState: 'active',
        }),
      ),
    ).resolves.toMatchObject({id: repositoryId, accessState: 'active'});
    const project = await asRequestTransaction({tenant: {accountId: accountA}}, (transaction) =>
      ports.projects.createForRepository(transaction, {
        accountId: accountA,
        repositoryId,
        slug: 'convergent',
        name: 'Convergent',
        visibility: 'private',
        state: 'active',
        createdBy: actor,
      }),
    );
    const initial = await asRequestTransaction({tenant: {accountId: accountA}}, (transaction) =>
      ports.projectTokens.create(transaction, {
        accountId: accountA,
        projectId: project.id,
        label: 'ci',
        tokenPrefix: 'prefix-ci-one',
        tokenDigest: 'digest-ci-one',
        scope: 'build-write',
        createdBy: actor,
      }),
    );
    await expect(
      asRequestTransaction({tenant: {accountId: accountA}}, (transaction) =>
        ports.projectTokens.listForProject(transaction, project.id),
      ),
    ).resolves.toMatchObject([{id: initial.id}]);
    await expect(
      asRequestTransaction({tenant: {accountId: accountA}}, (transaction) =>
        ports.projectTokens.create(transaction, {
          accountId: accountA,
          projectId: project.id,
          label: 'ci',
          tokenPrefix: 'prefix-ci-two',
          tokenDigest: 'digest-ci-two',
          scope: 'build-write',
          createdBy: actor,
        }),
      ),
    ).rejects.toMatchObject({code: 'PROJECT_TOKEN_CONFLICT'});
    await asRequestTransaction({tenant: {accountId: accountA}}, (transaction) =>
      ports.projectTokens.revoke(transaction, initial.id, new Date()),
    );
    await expect(
      asRequestTransaction({tenant: {accountId: accountA}}, (transaction) =>
        ports.projectTokens.touchLastUsed(transaction, initial.id, new Date()),
      ),
    ).resolves.toBeUndefined();
    await expect(
      asRequestTransaction({tenant: {accountId: accountA}}, (transaction) =>
        ports.projectTokens.create(transaction, {
          accountId: accountA,
          projectId: project.id,
          label: 'ci',
          tokenPrefix: 'prefix-ci-three',
          tokenDigest: 'digest-ci-three',
          scope: 'build-write',
          createdBy: actor,
        }),
      ),
    ).resolves.toMatchObject({label: 'ci'});
  });
  it('maps parent and slug constraints to persistence errors', async () => {
    if (!database) throw new Error('PostgreSQL fixture was not initialized.');
    const ports = createPostgresProjectsRepositories(database);
    await expect(
      asRequestTransaction({tenant: {accountId: accountA}}, (transaction) =>
        ports.projects.createForRepository(transaction, {
          accountId: accountA,
          repositoryId: randomUUID(),
          slug: 'missing-parent',
          name: 'Missing parent',
          visibility: 'private',
          state: 'active',
          createdBy: actor,
        }),
      ),
    ).rejects.toMatchObject({code: 'REPOSITORY_NOT_FOUND'});
    await expect(
      asRequestTransaction({tenant: {accountId: accountA}}, (transaction) =>
        ports.projectTokens.create(transaction, {
          accountId: accountA,
          projectId: randomUUID(),
          label: 'missing-parent',
          tokenPrefix: 'prefix-missing-parent',
          tokenDigest: 'digest-missing-parent',
          scope: 'build-write',
          createdBy: actor,
        }),
      ),
    ).rejects.toMatchObject({code: 'PROJECT_NOT_FOUND'});
    const secondRepository = await asRequestTransaction(
      {tenant: {accountId: accountA}},
      (transaction) =>
        ports.repositories.upsertByProviderRepository(transaction, {
          accountId: accountA,
          provider: 'github',
          installationId: randomUUID(),
          providerRepositoryId: 'slug-conflict',
          ownerLogin: 'glint',
          name: 'Slug conflict',
          defaultBranch: 'main',
          visibility: 'private',
          accessState: 'active',
        }),
    );
    await expect(
      asRequestTransaction({tenant: {accountId: accountA}}, (transaction) =>
        ports.projects.createForRepository(transaction, {
          accountId: accountA,
          repositoryId: secondRepository.id,
          slug: 'a',
          name: 'Slug conflict',
          visibility: 'private',
          state: 'active',
          createdBy: actor,
        }),
      ),
    ).rejects.toMatchObject({code: 'PROJECT_CONFLICT'});
  });
});
