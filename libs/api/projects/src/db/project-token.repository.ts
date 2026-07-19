import {databaseErrorCode, type PostgresDatabase} from '@glint/node-database';
import {sql} from 'drizzle-orm';
import {ProjectsPersistenceError} from '../core/errors.js';
import type {ProjectTokenRepository} from '../core/ports.js';
import type {ProjectToken} from '../core/types.js';
import {projectTokenFromRow, requiredRow} from './mapping.js';

export class PostgresProjectTokenRepository implements ProjectTokenRepository {
  constructor(readonly database: PostgresDatabase) {}
  async create(
    transaction: Parameters<ProjectTokenRepository['create']>[0],
    input: Omit<ProjectToken, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'revokedAt'>,
  ): Promise<ProjectToken> {
    try {
      return await this.database.useTransaction(transaction, async (tx) => {
        const result = await tx.execute<Record<string, unknown>>(
          sql`INSERT INTO project_tokens (account_id, project_id, label, token_prefix, token_digest, scope, created_by) VALUES (${input.accountId}, ${input.projectId}, ${input.label}, ${input.tokenPrefix}, ${input.tokenDigest}, ${input.scope}, ${input.createdBy}) RETURNING *`,
        );
        return projectTokenFromRow(requiredRow(result.rows));
      });
    } catch (error) {
      if (databaseErrorCode(error) === '23503')
        throw new ProjectsPersistenceError(
          'PROJECT_NOT_FOUND',
          'Project does not exist in this account.',
        );
      if (databaseErrorCode(error) === '23505')
        throw new ProjectsPersistenceError(
          'PROJECT_TOKEN_CONFLICT',
          'A project token conflicts with an existing token.',
        );
      throw error;
    }
  }
  listForProject(
    transaction: Parameters<ProjectTokenRepository['listForProject']>[0],
    projectId: string,
  ): Promise<readonly ProjectToken[]> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`SELECT * FROM project_tokens WHERE project_id = ${projectId} ORDER BY created_at, id`,
      );
      return result.rows.map(projectTokenFromRow);
    });
  }
  revoke(
    transaction: Parameters<ProjectTokenRepository['revoke']>[0],
    id: string,
    now: Date,
  ): Promise<ProjectToken | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`UPDATE project_tokens SET revoked_at = COALESCE(revoked_at, ${now}), updated_at = now() WHERE id = ${id} RETURNING *`,
      );
      return result.rows[0] ? projectTokenFromRow(result.rows[0]) : undefined;
    });
  }
  touchLastUsed(
    transaction: Parameters<ProjectTokenRepository['touchLastUsed']>[0],
    id: string,
    now: Date,
  ): Promise<ProjectToken | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`UPDATE project_tokens SET last_used_at = GREATEST(last_used_at, ${now}), updated_at = now() WHERE id = ${id} AND revoked_at IS NULL RETURNING *`,
      );
      return result.rows[0] ? projectTokenFromRow(result.rows[0]) : undefined;
    });
  }
}
