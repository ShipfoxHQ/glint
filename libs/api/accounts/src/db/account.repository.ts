import {databaseErrorCode, type PostgresDatabase} from '@glint/node-database';
import {sql} from 'drizzle-orm';
import {AccountsPersistenceError} from '../core/errors.js';
import type {AccountRepository} from '../core/ports.js';
import type {Account} from '../core/types.js';
import {accountFromRow, requiredRow} from './mapping.js';

export class PostgresAccountRepository implements AccountRepository {
  constructor(readonly database: PostgresDatabase) {}
  async upsertByProviderNamespace(
    transaction: Parameters<AccountRepository['upsertByProviderNamespace']>[0],
    input: Omit<Account, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<Account> {
    try {
      return await this.database.useTransaction(transaction, async (tx) => {
        // Serialize one provider namespace so the secondary provider/slug unique index cannot
        // race the namespace-targeted upsert before PostgreSQL reaches its ON CONFLICT branch.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`accounts:${input.provider}:${input.providerNamespaceId}`}, 0))`,
        );
        const result = await tx.execute<Record<string, unknown>>(
          sql`INSERT INTO accounts (provider, provider_namespace_id, namespace_kind, slug, display_name, avatar_url, state) VALUES (${input.provider}, ${input.providerNamespaceId}, ${input.namespaceKind}, ${input.slug}, ${input.displayName}, ${input.avatarUrl ?? null}, ${input.state}) ON CONFLICT (provider, provider_namespace_id) DO UPDATE SET namespace_kind = EXCLUDED.namespace_kind, slug = EXCLUDED.slug, display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url, state = EXCLUDED.state, updated_at = now() RETURNING *`,
        );
        return accountFromRow(requiredRow(result.rows));
      });
    } catch (error) {
      if (databaseErrorCode(error) === '23505') {
        throw new AccountsPersistenceError(
          'ACCOUNT_CONFLICT',
          'An account already uses this provider slug.',
        );
      }
      throw error;
    }
  }
  findById(
    transaction: Parameters<AccountRepository['findById']>[0],
    id: string,
  ): Promise<Account | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`SELECT * FROM accounts WHERE id = ${id}`,
      );
      return result.rows[0] ? accountFromRow(result.rows[0]) : undefined;
    });
  }
  listSummariesForIdentity(
    transaction: Parameters<AccountRepository['listSummariesForIdentity']>[0],
  ): Promise<readonly Account[]> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`SELECT * FROM accounts ORDER BY display_name, id`,
      );
      return result.rows.map(accountFromRow);
    });
  }
}
