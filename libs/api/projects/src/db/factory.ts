import type {PostgresDatabase} from '@glint/node-database';
import type {
  IdempotencyRecordRepository,
  ProjectRepository,
  ProjectTokenRepository,
  RepositoryProjectionRepository,
} from '../core/ports.js';
import {PostgresIdempotencyRecordRepository} from './idempotency-record.repository.js';
import {PostgresProjectRepository} from './project.repository.js';
import {PostgresProjectTokenRepository} from './project-token.repository.js';
import {PostgresRepositoryProjectionRepository} from './repository-projection.repository.js';

export interface ProjectsRepositories {
  readonly repositories: RepositoryProjectionRepository;
  readonly projects: ProjectRepository;
  readonly projectTokens: ProjectTokenRepository;
  readonly idempotencyRecords: IdempotencyRecordRepository;
}
export function createPostgresProjectsRepositories(
  database: PostgresDatabase,
): ProjectsRepositories {
  return {
    repositories: new PostgresRepositoryProjectionRepository(database),
    projects: new PostgresProjectRepository(database),
    projectTokens: new PostgresProjectTokenRepository(database),
    idempotencyRecords: new PostgresIdempotencyRecordRepository(database),
  };
}
