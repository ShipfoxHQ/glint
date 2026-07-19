import {describe, expect, it} from '@shipfox/vitest/vi';
import * as projectsApi from '../index.js';
import {PROJECTS_MIGRATION} from '../migration.js';
import {projectFromRow, repositoryProjectionFromRow} from './mapping.js';

describe('projects persistence mapping and ports', () => {
  it('maps repository and project rows', () => {
    expect(
      repositoryProjectionFromRow({
        id: 'repository',
        account_id: 'account',
        provider: 'github',
        installation_id: 'installation',
        provider_repository_id: '42',
        owner_login: 'glint',
        name: 'glint',
        default_branch: 'main',
        visibility: 'private',
        access_state: 'active',
        created_at: '2030-01-01T00:00:00Z',
        updated_at: '2030-01-01T00:00:00Z',
      }),
    ).toMatchObject({providerRepositoryId: '42', accessState: 'active'});
    expect(
      projectFromRow({
        id: 'project',
        account_id: 'account',
        repository_id: 'repository',
        slug: 'glint',
        name: 'Glint',
        visibility: 'private',
        state: 'active',
        created_by: 'identity',
        created_at: '2030-01-01T00:00:00Z',
        updated_at: '2030-01-01T00:00:00Z',
      }),
    ).toMatchObject({slug: 'glint'});
  });
  it('declares migration and exposes only ports and factories', () => {
    expect(PROJECTS_MIGRATION).toMatchObject({name: 'projects'});
    expect(projectsApi.createPostgresProjectsRepositories).toBeTypeOf('function');
    expect('PostgresProjectRepository' in projectsApi).toBe(false);
    expect('PostgresRepositoryProjectionRepository' in projectsApi).toBe(false);
  });
});
