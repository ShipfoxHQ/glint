import {z} from 'zod';

export const VCS_CORE_EVENT_VERSION = 1;

export const vcsIdentitySchema = z.object({
  id: z.string(),
  provider: z.string(),
  login: z.string(),
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
});

export const vcsNamespaceSchema = z.object({
  id: z.string(),
  provider: z.string(),
  kind: z.enum(['organization', 'user']),
  state: z.enum(['active', 'suspended']),
  login: z.string(),
  displayName: z.string().optional(),
});

export const vcsNamespaceAccessSchema = z.object({
  namespaceId: z.string(),
  identityId: z.string(),
  level: z.enum(['owner', 'member', 'none']),
});

export const vcsInstallationSchema = z.object({
  id: z.string(),
  provider: z.string(),
  namespaceId: z.string(),
  state: z.enum(['active', 'suspended', 'removed']),
  repositorySelection: z.enum(['all', 'selected']),
});

export const vcsRepositorySchema = z.object({
  id: z.string(),
  provider: z.string(),
  namespaceId: z.string(),
  installationId: z.string(),
  state: z.enum(['active', 'removed']),
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  visibility: z.enum(['private', 'public']),
});

export const vcsCoreEventPayloadSchemas = {
  installation: z.object({
    provider: z.string(),
    deliveryId: z.string(),
    action: z.enum(['created', 'suspended', 'unsuspended', 'deleted']),
    installation: vcsInstallationSchema,
  }),
  'installation-repositories': z.object({
    provider: z.string(),
    deliveryId: z.string(),
    installationId: z.string(),
    namespaceId: z.string(),
    action: z.enum(['added', 'removed']),
    repositories: z.array(vcsRepositorySchema),
  }),
  membership: z.object({
    provider: z.string(),
    deliveryId: z.string(),
    namespaceId: z.string(),
    identityId: z.string(),
    access: z.enum(['owner', 'member', 'none']),
  }),
  'organization-lifecycle': z.object({
    provider: z.string(),
    deliveryId: z.string(),
    action: z.enum(['suspended', 'unsuspended', 'deleted']),
    namespace: vcsNamespaceSchema,
  }),
  'app-authorization-revocation': z.object({
    provider: z.string(),
    deliveryId: z.string(),
    identityId: z.string(),
  }),
} as const;

export const vcsLifecycleEventSchema = z
  .discriminatedUnion('type', [
    vcsCoreEventPayloadSchemas.installation.extend({type: z.literal('installation')}),
    vcsCoreEventPayloadSchemas['installation-repositories'].extend({
      type: z.literal('installation-repositories'),
    }),
    vcsCoreEventPayloadSchemas.membership.extend({type: z.literal('membership')}),
    vcsCoreEventPayloadSchemas['organization-lifecycle'].extend({
      type: z.literal('organization-lifecycle'),
    }),
    vcsCoreEventPayloadSchemas['app-authorization-revocation'].extend({
      type: z.literal('app-authorization-revocation'),
    }),
  ])
  .superRefine((event, context) => {
    if (event.type === 'installation' && event.installation.provider !== event.provider) {
      context.addIssue({
        code: 'custom',
        message: 'Installation provider must match the event provider',
        path: ['installation', 'provider'],
      });
    }
    if (event.type === 'installation-repositories') {
      for (const [index, repository] of event.repositories.entries()) {
        if (repository.provider !== event.provider) {
          context.addIssue({
            code: 'custom',
            message: 'Repository provider must match the event provider',
            path: ['repositories', index, 'provider'],
          });
        }
        if (repository.namespaceId !== event.namespaceId) {
          context.addIssue({
            code: 'custom',
            message: 'Repository namespace must match the event namespace',
            path: ['repositories', index, 'namespaceId'],
          });
        }
        if (repository.installationId !== event.installationId) {
          context.addIssue({
            code: 'custom',
            message: 'Repository installation must match the event installation',
            path: ['repositories', index, 'installationId'],
          });
        }
      }
    }
    if (event.type === 'organization-lifecycle' && event.namespace.provider !== event.provider) {
      context.addIssue({
        code: 'custom',
        message: 'Namespace provider must match the event provider',
        path: ['namespace', 'provider'],
      });
    }
  });

export type VcsIdentityDto = z.infer<typeof vcsIdentitySchema>;
export type VcsNamespaceDto = z.infer<typeof vcsNamespaceSchema>;
export type VcsNamespaceAccessDto = z.infer<typeof vcsNamespaceAccessSchema>;
export type VcsInstallationDto = z.infer<typeof vcsInstallationSchema>;
export type VcsRepositoryDto = z.infer<typeof vcsRepositorySchema>;
export type VcsLifecycleEventDto = z.infer<typeof vcsLifecycleEventSchema>;
export type VcsCoreEventName = keyof typeof vcsCoreEventPayloadSchemas;
