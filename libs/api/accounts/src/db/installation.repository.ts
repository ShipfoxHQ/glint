import type {PostgresDatabase} from '@glint/node-database';
import {sql} from 'drizzle-orm';
import {AccountsPersistenceError} from '../core/errors.js';
import type {InstallationRepository} from '../core/ports.js';
import type {Installation} from '../core/types.js';
import {installationFromRow, requiredRow} from './mapping.js';

export class PostgresInstallationRepository implements InstallationRepository {
  constructor(readonly database: PostgresDatabase) {}
  linkCurrent(
    transaction: Parameters<InstallationRepository['linkCurrent']>[0],
    input: Omit<Installation, 'id' | 'suspendedAt' | 'removedAt'>,
  ): Promise<Installation> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`WITH existing AS MATERIALIZED (
            SELECT account_id FROM accounts_installations
            WHERE provider = ${input.provider} AND provider_installation_id = ${input.providerInstallationId}
          ), retired AS (
            UPDATE accounts_installations SET state = 'removed', removed_at = ${input.installedAt}, updated_at = now()
            WHERE account_id = ${input.accountId} AND provider = ${input.provider} AND state <> 'removed'
              AND provider_installation_id <> ${input.providerInstallationId}
              AND NOT EXISTS (SELECT 1 FROM existing WHERE account_id <> ${input.accountId})
            RETURNING id
          ), retirement_complete AS (
            SELECT count(*) FROM retired
          ), linked AS (
            INSERT INTO accounts_installations (account_id, provider, provider_installation_id, state, repository_selection, installed_at, suspended_at, removed_at)
            SELECT ${input.accountId}, ${input.provider}, ${input.providerInstallationId}, ${input.state}, ${input.repositorySelection}, ${input.installedAt},
              CASE WHEN ${input.state}::accounts_installation_state = 'suspended' THEN ${input.installedAt}::timestamptz ELSE NULL END,
              CASE WHEN ${input.state}::accounts_installation_state = 'removed' THEN ${input.installedAt}::timestamptz ELSE NULL END
            FROM retirement_complete
            ON CONFLICT (provider, provider_installation_id) DO UPDATE
              SET state = EXCLUDED.state, repository_selection = EXCLUDED.repository_selection,
                installed_at = EXCLUDED.installed_at, suspended_at = EXCLUDED.suspended_at,
                removed_at = EXCLUDED.removed_at, updated_at = now()
              WHERE accounts_installations.account_id = EXCLUDED.account_id
            RETURNING *
          ) SELECT * FROM linked`,
      );
      if (!result.rows[0]) {
        throw new AccountsPersistenceError(
          'INSTALLATION_CONFLICT',
          'The provider installation is already linked to another account.',
        );
      }
      return installationFromRow(requiredRow(result.rows));
    });
  }
  findCurrentForAccount(
    transaction: Parameters<InstallationRepository['findCurrentForAccount']>[0],
  ): Promise<Installation | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`SELECT * FROM accounts_installations WHERE state <> 'removed' ORDER BY installed_at DESC, id DESC LIMIT 1`,
      );
      return result.rows[0] ? installationFromRow(result.rows[0]) : undefined;
    });
  }
  setState(
    transaction: Parameters<InstallationRepository['setState']>[0],
    id: string,
    state: Installation['state'],
    now: Date,
  ): Promise<Installation | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`UPDATE accounts_installations SET state = ${state}, suspended_at = CASE WHEN ${state} = 'suspended' THEN ${now} ELSE suspended_at END, removed_at = CASE WHEN ${state} = 'removed' THEN ${now} ELSE removed_at END, updated_at = now() WHERE id = ${id} RETURNING *`,
      );
      return result.rows[0] ? installationFromRow(result.rows[0]) : undefined;
    });
  }
}
