import type {DatabaseTransaction} from '@glint/node-database';
import type {IdempotencyRecord, Project, ProjectToken, RepositoryProjection} from './types.js';

export interface RepositoryProjectionRepository {
  upsertByProviderRepository(
    transaction: DatabaseTransaction,
    input: Omit<RepositoryProjection, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<RepositoryProjection>;
  findById(transaction: DatabaseTransaction, id: string): Promise<RepositoryProjection | undefined>;
  setAccessState(
    transaction: DatabaseTransaction,
    id: string,
    accessState: RepositoryProjection['accessState'],
  ): Promise<RepositoryProjection | undefined>;
  listForAccount(transaction: DatabaseTransaction): Promise<readonly RepositoryProjection[]>;
}
export interface ProjectRepository {
  createForRepository(
    transaction: DatabaseTransaction,
    input: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<Project>;
  findById(transaction: DatabaseTransaction, id: string): Promise<Project | undefined>;
  findBySlug(transaction: DatabaseTransaction, slug: string): Promise<Project | undefined>;
  setState(
    transaction: DatabaseTransaction,
    id: string,
    state: Project['state'],
  ): Promise<Project | undefined>;
}
export interface ProjectTokenRepository {
  create(
    transaction: DatabaseTransaction,
    input: Omit<ProjectToken, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'revokedAt'>,
  ): Promise<ProjectToken>;
  listForProject(
    transaction: DatabaseTransaction,
    projectId: string,
  ): Promise<readonly ProjectToken[]>;
  revoke(
    transaction: DatabaseTransaction,
    id: string,
    now: Date,
  ): Promise<ProjectToken | undefined>;
  touchLastUsed(
    transaction: DatabaseTransaction,
    id: string,
    now: Date,
  ): Promise<ProjectToken | undefined>;
}
export interface IdempotencyRecordRepository {
  claim(
    transaction: DatabaseTransaction,
    input: Omit<IdempotencyRecord, 'id' | 'createdAt' | 'updatedAt' | 'resultReference'>,
  ): Promise<IdempotencyRecord>;
  findByKey(
    transaction: DatabaseTransaction,
    actor: string,
    route: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | undefined>;
}
