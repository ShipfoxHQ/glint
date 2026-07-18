import {describe, expect, it} from '@shipfox/vitest/vi';
import {projectRepresentationSchema, repositoryRepresentationSchema} from './index.js';

describe('project DTO contracts', () => {
  it('keeps projects private in the E1 representation', () => {
    expect(
      projectRepresentationSchema.parse({
        id: 'project-1',
        accountId: 'account-1',
        repositoryId: 'repository-1',
        name: 'Glint',
        visibility: 'private',
      }),
    ).toMatchObject({visibility: 'private'});
  });

  it('rejects a repository and installation with different stable IDs', () => {
    expect(() =>
      repositoryRepresentationSchema.parse({
        id: 'repository-1',
        provider: 'provider',
        namespaceId: 'namespace-1',
        installationId: 'installation-1',
        state: 'active',
        owner: 'glint',
        name: 'glint',
        defaultBranch: 'main',
        visibility: 'private',
        installation: {
          id: 'other-installation',
          provider: 'provider',
          namespaceId: 'namespace-1',
          state: 'active',
          repositorySelection: 'all',
        },
      }),
    ).toThrow();
  });
});
