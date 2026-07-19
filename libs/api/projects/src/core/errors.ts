import type {ProjectErrorCode} from '@glint/api-projects-dto';

export class ProjectsPersistenceError extends Error {
  constructor(
    readonly code:
      | ProjectErrorCode
      | 'REPOSITORY_CONFLICT'
      | 'PROJECT_CONFLICT'
      | 'PROJECT_TOKEN_CONFLICT'
      | 'IDEMPOTENCY_CONFLICT'
      | 'REPOSITORY_NOT_FOUND'
      | 'PROJECT_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'ProjectsPersistenceError';
  }
}
