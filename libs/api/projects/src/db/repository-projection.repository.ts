import type {PostgresDatabase} from '@glint/node-database';
import {sql} from 'drizzle-orm';
import type {RepositoryProjectionRepository} from '../core/ports.js';
import type {RepositoryProjection} from '../core/types.js';
import {repositoryProjectionFromRow, requiredRow} from './mapping.js';

export class PostgresRepositoryProjectionRepository implements RepositoryProjectionRepository {
  constructor(readonly database: PostgresDatabase) {}
  upsertByProviderRepository(
    transaction: Parameters<RepositoryProjectionRepository['upsertByProviderRepository']>[0],
    input: Omit<RepositoryProjection, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<RepositoryProjection> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        // A provider-listed repository is a verified reconnection. Suspension/removal flows use
        // setAccessState; this path intentionally restores the durable projection to active.
        sql`INSERT INTO repositories (account_id, provider, installation_id, provider_repository_id, owner_login, name, default_branch, visibility, access_state) VALUES (${input.accountId}, ${input.provider}, ${input.installationId}, ${input.providerRepositoryId}, ${input.ownerLogin}, ${input.name}, ${input.defaultBranch}, ${input.visibility}, ${input.accessState}) ON CONFLICT (account_id, provider, provider_repository_id) DO UPDATE SET installation_id = EXCLUDED.installation_id, owner_login = EXCLUDED.owner_login, name = EXCLUDED.name, default_branch = EXCLUDED.default_branch, visibility = EXCLUDED.visibility, access_state = 'active', updated_at = now() RETURNING *`,
      );
      return repositoryProjectionFromRow(requiredRow(result.rows));
    });
  }
  findById(
    transaction: Parameters<RepositoryProjectionRepository['findById']>[0],
    id: string,
  ): Promise<RepositoryProjection | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`SELECT * FROM repositories WHERE id = ${id}`,
      );
      return result.rows[0] ? repositoryProjectionFromRow(result.rows[0]) : undefined;
    });
  }
  setAccessState(
    transaction: Parameters<RepositoryProjectionRepository['setAccessState']>[0],
    id: string,
    accessState: RepositoryProjection['accessState'],
  ): Promise<RepositoryProjection | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`UPDATE repositories SET access_state = ${accessState}, updated_at = now() WHERE id = ${id} RETURNING *`,
      );
      return result.rows[0] ? repositoryProjectionFromRow(result.rows[0]) : undefined;
    });
  }
  listForAccount(
    transaction: Parameters<RepositoryProjectionRepository['listForAccount']>[0],
  ): Promise<readonly RepositoryProjection[]> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`SELECT * FROM repositories ORDER BY owner_login, name, id`,
      );
      return result.rows.map(repositoryProjectionFromRow);
    });
  }
}
