import {vcsInstallationSchema, vcsRepositorySchema} from '@glint/api-vcs-core-dto';
import {z} from 'zod';

export const repositoryRepresentationSchema = vcsRepositorySchema
  .extend({installation: vcsInstallationSchema})
  .superRefine((repository, context) => {
    if (repository.installation.provider !== repository.provider) {
      context.addIssue({
        code: 'custom',
        message: 'Installation provider must match the repository provider',
        path: ['installation', 'provider'],
      });
    }
    if (repository.installation.id !== repository.installationId) {
      context.addIssue({
        code: 'custom',
        message: 'Installation ID must match the repository installation ID',
        path: ['installation', 'id'],
      });
    }
    if (repository.installation.namespaceId !== repository.namespaceId) {
      context.addIssue({
        code: 'custom',
        message: 'Installation namespace must match the repository namespace',
        path: ['installation', 'namespaceId'],
      });
    }
  });

export const projectRepresentationSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  repositoryId: z.string(),
  name: z.string(),
  visibility: z.literal('private'),
});

export const projectErrorCodeSchema = z.enum([
  'IDEMPOTENCY_CONFLICT',
  'PROJECT_SUSPENDED',
  'TOKEN_SECRET_ALREADY_LOST',
]);

export type RepositoryRepresentation = z.infer<typeof repositoryRepresentationSchema>;
export type ProjectRepresentation = z.infer<typeof projectRepresentationSchema>;
export type ProjectErrorCode = z.infer<typeof projectErrorCodeSchema>;
