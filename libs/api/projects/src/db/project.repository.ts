import {databaseErrorCode, type PostgresDatabase} from '@glint/node-database';
import {sql} from 'drizzle-orm';
import {ProjectsPersistenceError} from '../core/errors.js';
import type {ProjectRepository} from '../core/ports.js';
import type {Project} from '../core/types.js';
import {projectFromRow, requiredRow} from './mapping.js';

export class PostgresProjectRepository implements ProjectRepository {
  constructor(readonly database: PostgresDatabase) {}
  async createForRepository(
    transaction: Parameters<ProjectRepository['createForRepository']>[0],
    input: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<Project> {
    try {
      return await this.database.useTransaction(transaction, async (tx) => {
        const result = await tx.execute<Record<string, unknown>>(
          // Project creation is convergent by repository: the established row, including its
          // stable slug, is authoritative when a request is retried or races with another create.
          sql`INSERT INTO projects (account_id, repository_id, slug, name, visibility, state, created_by) VALUES (${input.accountId}, ${input.repositoryId}, ${input.slug}, ${input.name}, ${input.visibility}, ${input.state}, ${input.createdBy}) ON CONFLICT (account_id, repository_id) DO UPDATE SET updated_at = now() RETURNING *`,
        );
        return projectFromRow(requiredRow(result.rows));
      });
    } catch (error) {
      if (databaseErrorCode(error) === '23503')
        throw new ProjectsPersistenceError(
          'REPOSITORY_NOT_FOUND',
          'Repository does not exist in this account.',
        );
      if (databaseErrorCode(error) === '23505')
        throw new ProjectsPersistenceError('PROJECT_CONFLICT', 'A project already uses this slug.');
      throw error;
    }
  }
  findById(
    transaction: Parameters<ProjectRepository['findById']>[0],
    id: string,
  ): Promise<Project | undefined> {
    return this.find(transaction, sql`SELECT * FROM projects WHERE id = ${id}`);
  }
  findBySlug(
    transaction: Parameters<ProjectRepository['findBySlug']>[0],
    slug: string,
  ): Promise<Project | undefined> {
    return this.find(transaction, sql`SELECT * FROM projects WHERE slug = ${slug}`);
  }
  setState(
    transaction: Parameters<ProjectRepository['setState']>[0],
    id: string,
    state: Project['state'],
  ): Promise<Project | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`UPDATE projects SET state = ${state}, updated_at = now() WHERE id = ${id} RETURNING *`,
      );
      return result.rows[0] ? projectFromRow(result.rows[0]) : undefined;
    });
  }
  private find(
    transaction: Parameters<ProjectRepository['findById']>[0],
    statement: ReturnType<typeof sql>,
  ): Promise<Project | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(statement);
      return result.rows[0] ? projectFromRow(result.rows[0]) : undefined;
    });
  }
}
