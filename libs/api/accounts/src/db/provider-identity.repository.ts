import type {PostgresDatabase} from '@glint/node-database';
import {sql} from 'drizzle-orm';
import type {ProviderIdentityRepository} from '../core/ports.js';
import type {ProviderIdentity} from '../core/types.js';
import {providerIdentityFromRow, requiredRow} from './mapping.js';

export class PostgresProviderIdentityRepository implements ProviderIdentityRepository {
  constructor(readonly database: PostgresDatabase) {}
  upsertByProviderUser(
    transaction: Parameters<ProviderIdentityRepository['upsertByProviderUser']>[0],
    input: Omit<ProviderIdentity, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ProviderIdentity> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(sql`
        INSERT INTO auth_provider_identities (provider, provider_user_id, login, display_name, avatar_url)
        VALUES (${input.provider}, ${input.providerUserId}, ${input.login}, ${input.displayName ?? null}, ${input.avatarUrl ?? null})
        ON CONFLICT (provider, provider_user_id) DO UPDATE SET login = EXCLUDED.login, display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url, updated_at = now()
        RETURNING *`);
      return providerIdentityFromRow(requiredRow(result.rows));
    });
  }
  findById(
    transaction: Parameters<ProviderIdentityRepository['findById']>[0],
    id: string,
  ): Promise<ProviderIdentity | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`SELECT * FROM auth_provider_identities WHERE id = ${id}`,
      );
      return result.rows[0] ? providerIdentityFromRow(result.rows[0]) : undefined;
    });
  }
}
