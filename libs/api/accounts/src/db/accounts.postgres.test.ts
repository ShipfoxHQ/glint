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
import type {AccountsPersistenceError} from '../core/errors.js';
import {ACCOUNTS_MIGRATION} from '../migration.js';
import {PostgresAccountRepository} from './account.repository.js';
import {PostgresInstallationRepository} from './installation.repository.js';
import {PostgresMembershipProjectionRepository} from './membership-projection.repository.js';
import {PostgresOAuthAttemptRepository} from './oauth-attempt.repository.js';
import {PostgresProviderIdentityRepository} from './provider-identity.repository.js';
import {PostgresSessionRepository} from './session.repository.js';

const integrationEnabled = process.env.GLINT_POSTGRES_TEST === '1';
const identityA = '11111111-1111-4111-8111-111111111111';
const identityB = '22222222-2222-4222-8222-222222222222';
const accountA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const accountB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe.runIf(integrationEnabled)('accounts PostgreSQL migration and RLS', () => {
  let databaseName = '';
  let database: PostgresDatabase | undefined;
  let pool: Pool | undefined;
  let requestRole = '';

  beforeAll(async () => {
    const config = poolConfig(loadDatabaseEnvironment());
    databaseName = `glint_accounts_test_${randomUUID().replaceAll('-', '')}`;
    const admin = createPostgresClient({...config, database: 'postgres'});
    try {
      await admin.query(`CREATE DATABASE ${databaseName}`);
    } finally {
      await closePostgresClient();
    }
    pool = createPostgresClient({...config, database: databaseName});
    database = new PostgresDatabase({pool, close: closePostgresClient});
    await database.initialize();
    await runOrderedMigrations(database.drizzle, [ACCOUNTS_MIGRATION]);
    requestRole = `glint_accounts_request_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE ROLE ${requestRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await pool.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON accounts, accounts_installations, accounts_memberships TO ${requestRole};
      GRANT SELECT ON auth_provider_identities, auth_sessions, auth_oauth_attempts TO ${requestRole};
      INSERT INTO auth_provider_identities (id, provider, provider_user_id, login) VALUES
        ('${identityA}', 'github', 'a', 'identity-a'), ('${identityB}', 'github', 'b', 'identity-b');
      INSERT INTO auth_sessions (identity_id, token_digest, absolute_expires_at, inactivity_expires_at)
        VALUES ('${identityA}', 'global-token', now() + interval '1 day', now() + interval '1 day');
      INSERT INTO accounts (id, provider, provider_namespace_id, namespace_kind, slug, display_name) VALUES
        ('${accountA}', 'github', 'a-namespace', 'organization', 'account-a', 'Account A'),
        ('${accountB}', 'github', 'b-namespace', 'organization', 'account-b', 'Account B');
      INSERT INTO accounts_installations (account_id, provider, provider_installation_id, state, repository_selection, installed_at) VALUES
        ('${accountA}', 'github', 'install-a', 'active', 'all', now()), ('${accountB}', 'github', 'install-b', 'active', 'selected', now());
      INSERT INTO accounts_memberships (account_id, identity_id, role, state) VALUES
        ('${accountA}', '${identityA}', 'owner', 'active'), ('${accountB}', '${identityB}', 'reviewer', 'active');
    `);
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

  it('enforces identity and tenant visibility while global session lookup remains available', async () => {
    const identityRows = await asRequest({identity: {identityId: identityA}}, (tx) =>
      tx.execute<{id: string}>(sql`SELECT id FROM accounts ORDER BY id`),
    );
    expect(identityRows.rows).toEqual([{id: accountA}]);
    const identityMemberships = await asRequest({identity: {identityId: identityA}}, (tx) =>
      tx.execute<{account_id: string}>(sql`SELECT account_id FROM accounts_memberships`),
    );
    expect(identityMemberships.rows).toEqual([{account_id: accountA}]);
    const identityInstallations = await asRequest({identity: {identityId: identityA}}, (tx) =>
      tx.execute(sql`SELECT * FROM accounts_installations`),
    );
    expect(identityInstallations.rows).toEqual([]);
    const tenantRows = await asRequest({tenant: {accountId: accountA}}, (tx) =>
      tx.execute<{account_id: string}>(sql`SELECT account_id FROM accounts_memberships`),
    );
    expect(tenantRows.rows).toEqual([{account_id: accountA}]);
    const tenantInstallations = await asRequest({tenant: {accountId: accountA}}, (tx) =>
      tx.execute<{account_id: string}>(sql`SELECT account_id FROM accounts_installations`),
    );
    expect(tenantInstallations.rows).toEqual([{account_id: accountA}]);
    const tenantAccounts = await asRequest({tenant: {accountId: accountA}}, (tx) =>
      tx.execute<{id: string}>(sql`SELECT id FROM accounts`),
    );
    expect(tenantAccounts.rows).toEqual([{id: accountA}]);
    const globalAccounts = await asRequest({}, (tx) => tx.execute(sql`SELECT * FROM accounts`));
    const globalInstallations = await asRequest({}, (tx) =>
      tx.execute(sql`SELECT * FROM accounts_installations`),
    );
    const globalMemberships = await asRequest({}, (tx) =>
      tx.execute(sql`SELECT * FROM accounts_memberships`),
    );
    expect(globalAccounts.rows).toEqual([]);
    expect(globalInstallations.rows).toEqual([]);
    expect(globalMemberships.rows).toEqual([]);
    const globalRows = await asRequest({}, (tx) =>
      tx.execute<{token_digest: string}>(sql`SELECT token_digest FROM auth_sessions`),
    );
    expect(globalRows.rows).toEqual([{token_digest: 'global-token'}]);
  });

  it('allows same-account writes and fails closed for cross-account writes', async () => {
    const membershipId = randomUUID();
    await asRequest({tenant: {accountId: accountA}}, (tx) =>
      tx.execute(
        sql`INSERT INTO accounts_memberships (id, account_id, identity_id, role, state) VALUES (${membershipId}, ${accountA}, ${randomUUID()}, 'viewer', 'active')`,
      ),
    );
    const sameAccountUpdate = await asRequest({tenant: {accountId: accountA}}, (tx) =>
      tx.execute(
        sql`UPDATE accounts_memberships SET provider_role = 'member' WHERE id = ${membershipId}`,
      ),
    );
    expect(sameAccountUpdate.rowCount).toBe(1);
    await expect(
      asRequest({tenant: {accountId: accountA}}, (tx) =>
        tx.execute(
          sql`INSERT INTO accounts_memberships (account_id, identity_id, role, state) VALUES (${accountB}, ${identityA}, 'viewer', 'active')`,
        ),
      ),
    ).rejects.toMatchObject({cause: {code: '42501'}});
    await expect(
      asRequest({tenant: {accountId: accountA}}, (tx) =>
        tx.execute(
          sql`UPDATE accounts_memberships SET account_id = ${accountB} WHERE id = ${membershipId}`,
        ),
      ),
    ).rejects.toMatchObject({cause: {code: '42501'}});
    if (!pool) throw new Error('PostgreSQL fixture was not initialized.');
    await expect(
      pool.query(
        `INSERT INTO accounts_installations (account_id, provider, provider_installation_id, state, repository_selection, installed_at) VALUES ('${accountA}', 'gitlab', 'wrong-provider', 'active', 'all', now())`,
      ),
    ).rejects.toMatchObject({code: '23503'});
  });

  it('hides accounts with inactive memberships during identity discovery', async () => {
    if (!pool) throw new Error('PostgreSQL fixture was not initialized.');
    await pool.query(
      `INSERT INTO accounts_memberships (account_id, identity_id, role, state) VALUES ('${accountB}', '${identityA}', 'reviewer', 'inactive')`,
    );
    const rows = await asRequest({identity: {identityId: identityA}}, (tx) =>
      tx.execute<{id: string}>(sql`SELECT id FROM accounts ORDER BY id`),
    );
    expect(rows.rows).toEqual([{id: accountA}]);
  });

  it('allows authorization projection writes only in the verified tenant transaction', async () => {
    if (!database) throw new Error('PostgreSQL fixture was not initialized.');
    const accounts = new PostgresAccountRepository(database);
    const memberships = new PostgresMembershipProjectionRepository(database);
    const now = new Date('2031-01-01T00:00:00.000Z');

    const discovered = await asRequestTransaction(
      {identity: {identityId: identityA}},
      (transaction) => accounts.listSummariesForIdentity(transaction),
    );
    expect(discovered.map(({id}) => id)).toEqual([accountA]);

    await expect(
      asRequestTransaction({tenant: {accountId: accountA}}, (transaction) =>
        memberships.projectFromProviderAccess(transaction, {
          accountId: accountA,
          identityId: identityA,
          providerRole: 'admin',
          role: 'owner',
          state: 'active',
          verifiedAt: now,
          leaseExpiresAt: new Date('2031-01-01T00:15:00.000Z'),
        }),
      ),
    ).resolves.toMatchObject({accountId: accountA, identityId: identityA, role: 'owner'});

    await expect(
      asRequestTransaction({tenant: {accountId: accountA}}, (transaction) =>
        memberships.projectFromProviderAccess(transaction, {
          accountId: accountB,
          identityId: identityA,
          providerRole: 'member',
          role: 'reviewer',
          state: 'active',
          verifiedAt: now,
          leaseExpiresAt: new Date('2031-01-01T00:15:00.000Z'),
        }),
      ),
    ).rejects.toMatchObject({cause: {code: '42501'}});

    const phaseOne = await asRequestTransaction(
      {identity: {identityId: identityA}},
      (transaction) => memberships.findForAccountIdentity(transaction, accountA, identityA),
    );
    expect(phaseOne).toMatchObject({state: 'active', role: 'owner'});
  });

  it('runs owner provisioning writes and repeat migrations successfully', async () => {
    if (!pool || !database) throw new Error('PostgreSQL fixture was not initialized.');
    const provisioned = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await pool.query(
      `INSERT INTO accounts (id, provider, provider_namespace_id, namespace_kind, slug, display_name) VALUES ('${provisioned}', 'github', 'c-namespace', 'user', 'account-c', 'Account C')`,
    );
    await pool.query(
      `INSERT INTO accounts_installations (account_id, provider, provider_installation_id, state, repository_selection, installed_at) VALUES ('${provisioned}', 'github', 'install-c', 'active', 'all', now())`,
    );
    await pool.query(
      `INSERT INTO accounts_memberships (account_id, identity_id, role, state) VALUES ('${provisioned}', '${identityA}', 'owner', 'active')`,
    );
    await runOrderedMigrations(database.drizzle, [ACCOUNTS_MIGRATION]);
    const rows = await asRequest({identity: {identityId: identityA}}, (tx) =>
      tx.execute<{id: string}>(sql`SELECT id FROM accounts WHERE id = ${provisioned}`),
    );
    expect(rows.rows).toEqual([{id: provisioned}]);
  });

  it('retains every unique constraint under concurrent duplicate writes', async () => {
    if (!pool) throw new Error('PostgreSQL fixture was not initialized.');
    const duplicateIdentity = await Promise.allSettled([
      pool.query(
        "INSERT INTO auth_provider_identities (provider, provider_user_id, login) VALUES ('github', 'concurrent-user', 'first')",
      ),
      pool.query(
        "INSERT INTO auth_provider_identities (provider, provider_user_id, login) VALUES ('github', 'concurrent-user', 'second')",
      ),
    ]);
    expect(duplicateIdentity.filter(({status}) => status === 'fulfilled')).toHaveLength(1);
    expect(duplicateIdentity.filter(({status}) => status === 'rejected')).toHaveLength(1);

    const duplicateMembership = await Promise.allSettled([
      pool.query(
        `INSERT INTO accounts_memberships (account_id, identity_id, role, state) VALUES ('${accountA}', '${identityB}', 'reviewer', 'active')`,
      ),
      pool.query(
        `INSERT INTO accounts_memberships (account_id, identity_id, role, state) VALUES ('${accountA}', '${identityB}', 'reviewer', 'active')`,
      ),
    ]);
    expect(duplicateMembership.filter(({status}) => status === 'fulfilled')).toHaveLength(1);
    expect(duplicateMembership.filter(({status}) => status === 'rejected')).toHaveLength(1);

    const duplicateAccounts = await Promise.allSettled([
      pool.query(
        "INSERT INTO accounts (provider, provider_namespace_id, namespace_kind, slug, display_name) VALUES ('github', 'concurrent-namespace', 'organization', 'concurrent-account', 'First')",
      ),
      pool.query(
        "INSERT INTO accounts (provider, provider_namespace_id, namespace_kind, slug, display_name) VALUES ('github', 'concurrent-namespace', 'organization', 'concurrent-account', 'Second')",
      ),
    ]);
    expect(duplicateAccounts.filter(({status}) => status === 'fulfilled')).toHaveLength(1);
    expect(duplicateAccounts.filter(({status}) => status === 'rejected')).toHaveLength(1);

    const installationAccount = randomUUID();
    await pool.query(
      `INSERT INTO accounts (id, provider, provider_namespace_id, namespace_kind, slug, display_name) VALUES ('${installationAccount}', 'github', 'installation-namespace', 'organization', 'installation-account', 'Installation Account')`,
    );
    const duplicateInstallations = await Promise.allSettled([
      pool.query(
        `INSERT INTO accounts_installations (account_id, provider, provider_installation_id, state, repository_selection, installed_at) VALUES ('${installationAccount}', 'github', 'concurrent-installation', 'active', 'all', now())`,
      ),
      pool.query(
        `INSERT INTO accounts_installations (account_id, provider, provider_installation_id, state, repository_selection, installed_at) VALUES ('${installationAccount}', 'github', 'concurrent-installation', 'active', 'all', now())`,
      ),
    ]);
    expect(duplicateInstallations.filter(({status}) => status === 'fulfilled')).toHaveLength(1);
    expect(duplicateInstallations.filter(({status}) => status === 'rejected')).toHaveLength(1);

    const partialIndexAccount = randomUUID();
    await pool.query(
      `INSERT INTO accounts (id, provider, provider_namespace_id, namespace_kind, slug, display_name) VALUES ('${partialIndexAccount}', 'github', 'partial-namespace', 'organization', 'partial-account', 'Partial Account')`,
    );
    const secondCurrentInstallation = await Promise.allSettled([
      pool.query(
        `INSERT INTO accounts_installations (account_id, provider, provider_installation_id, state, repository_selection, installed_at) VALUES ('${partialIndexAccount}', 'github', 'partial-installation-a', 'active', 'all', now())`,
      ),
      pool.query(
        `INSERT INTO accounts_installations (account_id, provider, provider_installation_id, state, repository_selection, installed_at) VALUES ('${partialIndexAccount}', 'github', 'partial-installation-b', 'active', 'all', now())`,
      ),
    ]);
    expect(secondCurrentInstallation.filter(({status}) => status === 'fulfilled')).toHaveLength(1);
    expect(secondCurrentInstallation.filter(({status}) => status === 'rejected')).toHaveLength(1);
  });

  it('converges repository upserts and installation links under concurrent calls', async () => {
    if (!database) throw new Error('PostgreSQL fixture was not initialized.');
    const activeDatabase = database;
    const identities = new PostgresProviderIdentityRepository(activeDatabase);
    const accountRepository = new PostgresAccountRepository(activeDatabase);
    const installations = new PostgresInstallationRepository(activeDatabase);
    const concurrentIdentities = await Promise.all(
      ['first', 'second'].map((login) =>
        activeDatabase.transaction((transaction) =>
          identities.upsertByProviderUser(transaction, {
            provider: 'github',
            providerUserId: 'repository-concurrent-user',
            login,
          }),
        ),
      ),
    );
    const firstIdentity = concurrentIdentities[0];
    const secondIdentity = concurrentIdentities[1];
    if (!firstIdentity || !secondIdentity) throw new Error('Expected two identity upsert results.');
    expect(firstIdentity.id).toBe(secondIdentity.id);
    const concurrentAccounts = await Promise.all(
      Array.from({length: 12}, (_, index) => `Account ${index}`).map((displayName) =>
        activeDatabase.transaction((transaction) =>
          accountRepository.upsertByProviderNamespace(transaction, {
            provider: 'github',
            providerNamespaceId: 'repository-concurrent-namespace',
            namespaceKind: 'organization',
            slug: 'repository-concurrent-account',
            displayName,
            state: 'active',
          }),
        ),
      ),
    );
    const firstAccount = concurrentAccounts[0];
    const secondAccount = concurrentAccounts[1];
    if (!firstAccount || !secondAccount) throw new Error('Expected two account upsert results.');
    expect(firstAccount.id).toBe(secondAccount.id);
    const linked = await Promise.all(
      Array.from({length: 12}, (_, index) => (index % 2 === 0 ? 'all' : 'selected')).map(
        (repositorySelection) =>
          activeDatabase.transaction((transaction) =>
            installations.linkCurrent(transaction, {
              accountId: firstAccount.id,
              provider: 'github',
              providerInstallationId: 'repository-concurrent-installation',
              state: 'active',
              repositorySelection: repositorySelection as 'all' | 'selected',
              installedAt: new Date('2032-01-01T00:00:00.000Z'),
            }),
          ),
      ),
    );
    expect(new Set(linked.map(({id}) => id)).size).toBe(1);
  });

  it('does not revive sessions expired by either deadline', async () => {
    if (!database) throw new Error('PostgreSQL fixture was not initialized.');
    const sessions = new PostgresSessionRepository(database);
    const now = new Date('2031-01-01T00:00:00.000Z');
    const cases = [
      {
        tokenDigest: 'absolute-expired-session',
        absoluteExpiresAt: new Date('2030-12-31T23:59:59.000Z'),
        inactivityExpiresAt: new Date('2031-01-02T00:00:00.000Z'),
      },
      {
        tokenDigest: 'inactive-expired-session',
        absoluteExpiresAt: new Date('2031-01-02T00:00:00.000Z'),
        inactivityExpiresAt: new Date('2030-12-31T23:59:59.000Z'),
      },
    ];
    for (const input of cases) {
      const session = await database.transaction((transaction) =>
        sessions.create(transaction, {identityId: identityA, ...input}),
      );
      await database.transaction((transaction) =>
        expect(
          sessions.touchByTokenDigest(
            transaction,
            session.tokenDigest,
            now,
            new Date('2031-01-03T00:00:00.000Z'),
          ),
        ).resolves.toBeUndefined(),
      );
    }
  });

  it('slides sessions only after the five-minute inactivity hysteresis threshold', async () => {
    if (!database) throw new Error('PostgreSQL fixture was not initialized.');
    const sessions = new PostgresSessionRepository(database);
    const now = new Date('2031-01-01T00:00:00.000Z');
    const session = await database.transaction((transaction) =>
      sessions.create(transaction, {
        identityId: identityA,
        tokenDigest: 'hysteresis-session',
        absoluteExpiresAt: new Date('2031-02-01T00:00:00.000Z'),
        inactivityExpiresAt: new Date('2031-01-01T00:10:00.000Z'),
      }),
    );

    const belowThreshold = await database.transaction((transaction) =>
      sessions.touchByTokenDigest(
        transaction,
        session.tokenDigest,
        now,
        new Date('2031-01-01T00:14:00.000Z'),
      ),
    );
    expect(belowThreshold).toMatchObject({
      inactivityExpiresAt: new Date('2031-01-01T00:10:00.000Z'),
    });

    const aboveThreshold = await database.transaction((transaction) =>
      sessions.touchByTokenDigest(
        transaction,
        session.tokenDigest,
        now,
        new Date('2031-01-01T00:16:00.000Z'),
      ),
    );
    expect(aboveThreshold).toMatchObject({
      inactivityExpiresAt: new Date('2031-01-01T00:16:00.000Z'),
    });
  });

  it('executes repository branches without leaking raw database conflicts', async () => {
    if (!database || !pool) throw new Error('PostgreSQL fixture was not initialized.');
    const activeDatabase = database;
    const identities = new PostgresProviderIdentityRepository(activeDatabase);
    const oauthAttempts = new PostgresOAuthAttemptRepository(activeDatabase);
    const sessions = new PostgresSessionRepository(activeDatabase);
    const accountRepository = new PostgresAccountRepository(activeDatabase);
    const installations = new PostgresInstallationRepository(activeDatabase);
    const memberships = new PostgresMembershipProjectionRepository(activeDatabase);
    const now = new Date('2031-01-01T00:00:00.000Z');

    const identity = await activeDatabase.transaction((transaction) =>
      identities.upsertByProviderUser(transaction, {
        provider: 'github',
        providerUserId: 'repository-user',
        login: 'first',
        displayName: 'First',
        avatarUrl: 'https://example.test/one.png',
      }),
    );
    const updatedIdentity = await activeDatabase.transaction((transaction) =>
      identities.upsertByProviderUser(transaction, {
        provider: 'github',
        providerUserId: 'repository-user',
        login: 'second',
        displayName: 'Second',
        avatarUrl: 'https://example.test/two.png',
      }),
    );
    expect(updatedIdentity).toMatchObject({id: identity.id, login: 'second'});
    await activeDatabase.transaction((transaction) =>
      expect(identities.findById(transaction, randomUUID())).resolves.toBeUndefined(),
    );

    const attempt = await activeDatabase.transaction((transaction) =>
      oauthAttempts.create(transaction, {
        stateDigest: 'valid-attempt',
        pkceVerifier: 'recoverable-verifier',
        returnLocation: '/accounts',
        environment: 'test',
        expiresAt: new Date('2031-01-01T00:01:00.000Z'),
      }),
    );
    await activeDatabase.transaction((transaction) =>
      expect(
        oauthAttempts.consumeByStateDigest(transaction, attempt.stateDigest, now),
      ).resolves.toMatchObject({id: attempt.id}),
    );
    await activeDatabase.transaction((transaction) =>
      expect(
        oauthAttempts.consumeByStateDigest(transaction, attempt.stateDigest, now),
      ).resolves.toBeUndefined(),
    );
    await activeDatabase.transaction((transaction) =>
      oauthAttempts.create(transaction, {
        stateDigest: 'expired-attempt',
        pkceVerifier: 'expired-verifier',
        returnLocation: '/accounts',
        environment: 'test',
        expiresAt: new Date('2030-12-31T23:59:59.000Z'),
      }),
    );
    await activeDatabase.transaction((transaction) =>
      expect(
        oauthAttempts.consumeByStateDigest(transaction, 'expired-attempt', now),
      ).resolves.toBeUndefined(),
    );

    const session = await activeDatabase.transaction((transaction) =>
      sessions.create(transaction, {
        identityId: identity.id,
        tokenDigest: 'repository-session',
        absoluteExpiresAt: new Date('2031-02-01T00:00:00.000Z'),
        inactivityExpiresAt: new Date('2031-01-02T00:00:00.000Z'),
      }),
    );
    const touched = await activeDatabase.transaction((transaction) =>
      sessions.touchByTokenDigest(
        transaction,
        session.tokenDigest,
        new Date('2031-01-01T00:00:01.000Z'),
        new Date('2031-01-03T00:00:00.000Z'),
      ),
    );
    expect(touched).toMatchObject({
      id: session.id,
      lastSeenAt: new Date('2031-01-01T00:00:01.000Z'),
    });
    const staleTouch = await activeDatabase.transaction((transaction) =>
      sessions.touchByTokenDigest(
        transaction,
        session.tokenDigest,
        new Date('2030-12-31T23:59:59.000Z'),
        new Date('2031-01-01T12:00:00.000Z'),
      ),
    );
    expect(staleTouch).toMatchObject({
      lastSeenAt: new Date('2031-01-01T00:00:01.000Z'),
      inactivityExpiresAt: new Date('2031-01-03T00:00:00.000Z'),
    });
    await activeDatabase.transaction((transaction) =>
      sessions.revoke(transaction, session.id, now),
    );
    await activeDatabase.transaction((transaction) =>
      expect(
        sessions.touchByTokenDigest(
          transaction,
          session.tokenDigest,
          now,
          new Date('2031-01-03T00:00:00.000Z'),
        ),
      ).resolves.toBeUndefined(),
    );
    await activeDatabase.transaction((transaction) =>
      sessions.revokeAllForIdentity(transaction, identity.id, now),
    );
    const account = await activeDatabase.transaction((transaction) =>
      accountRepository.upsertByProviderNamespace(transaction, {
        provider: 'github',
        providerNamespaceId: 'repository-namespace',
        namespaceKind: 'organization',
        slug: 'repository-account',
        displayName: 'Repository Account',
        state: 'active',
      }),
    );
    await pool.query('SELECT pg_sleep(0.002)');
    const updatedAccount = await activeDatabase.transaction((transaction) =>
      accountRepository.upsertByProviderNamespace(transaction, {
        provider: 'github',
        providerNamespaceId: 'repository-namespace',
        namespaceKind: 'organization',
        slug: 'repository-account',
        displayName: 'Renamed Account',
        state: 'active',
      }),
    );
    expect(updatedAccount.updatedAt.getTime()).toBeGreaterThan(account.updatedAt.getTime());
    await activeDatabase.transaction((transaction) =>
      expect(accountRepository.findById(transaction, randomUUID())).resolves.toBeUndefined(),
    );

    const linked = await activeDatabase.transaction((transaction) =>
      installations.linkCurrent(transaction, {
        accountId: account.id,
        provider: 'github',
        providerInstallationId: 'repository-installation-a',
        state: 'active',
        repositorySelection: 'all',
        installedAt: now,
      }),
    );
    const reconnected = await activeDatabase.transaction((transaction) =>
      installations.linkCurrent(transaction, {
        accountId: account.id,
        provider: 'github',
        providerInstallationId: 'repository-installation-b',
        state: 'active',
        repositorySelection: 'selected',
        installedAt: new Date('2031-01-01T00:01:00.000Z'),
      }),
    );
    expect(reconnected).toMatchObject({accountId: account.id, repositorySelection: 'selected'});
    await asRequestTransaction({tenant: {accountId: account.id}}, (transaction) =>
      expect(installations.findCurrentForAccount(transaction)).resolves.toMatchObject({
        id: reconnected.id,
        accountId: account.id,
      }),
    );
    await asRequestTransaction({tenant: {accountId: accountB}}, (transaction) =>
      expect(installations.findCurrentForAccount(transaction)).resolves.toMatchObject({
        accountId: accountB,
      }),
    );
    await expect(
      activeDatabase.transaction((transaction) =>
        installations.linkCurrent(transaction, {
          accountId: accountB,
          provider: 'github',
          providerInstallationId: reconnected.providerInstallationId,
          state: 'active',
          repositorySelection: 'all',
          installedAt: now,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'INSTALLATION_CONFLICT',
    } satisfies Partial<AccountsPersistenceError>);
    const installationOwner = await pool.query<{account_id: string}>(
      `SELECT account_id FROM accounts_installations WHERE id = '${reconnected.id}'`,
    );
    expect(installationOwner.rows).toEqual([{account_id: account.id}]);
    const retired = await activeDatabase.transaction((transaction) =>
      installations.setState(transaction, reconnected.id, 'removed', now),
    );
    expect(retired).toMatchObject({state: 'removed'});
    expect(linked.id).not.toBe(reconnected.id);

    const projected = await activeDatabase.transaction((transaction) =>
      memberships.projectFromProviderAccess(transaction, {
        accountId: account.id,
        identityId: identity.id,
        providerRole: 'member',
        role: 'reviewer',
        state: 'active',
        verifiedAt: now,
        leaseExpiresAt: new Date('2031-01-01T00:15:00.000Z'),
      }),
    );
    const refreshed = await activeDatabase.transaction((transaction) =>
      memberships.projectFromProviderAccess(transaction, {
        accountId: account.id,
        identityId: identity.id,
        providerRole: 'admin',
        role: 'owner',
        state: 'active',
        verifiedAt: now,
        leaseExpiresAt: new Date('2031-01-01T00:30:00.000Z'),
      }),
    );
    expect(refreshed).toMatchObject({id: projected.id, role: 'owner'});
    await activeDatabase.transaction((transaction) =>
      expect(
        memberships.findForAccountIdentity(transaction, account.id, identity.id),
      ).resolves.toMatchObject({id: projected.id}),
    );
  });
});
