import {
  vcsIdentitySchema,
  vcsInstallationSchema,
  vcsNamespaceSchema,
} from '@glint/api-vcs-core-dto';
import {z} from 'zod';

export const accountRoleSchema = z.enum(['owner', 'reviewer', 'viewer']);
export const accountStateSchema = z.enum(['active', 'suspended']);

export const sessionRepresentationSchema = z.object({
  id: z.string(),
  identityId: z.string(),
  expiresAt: z.iso.datetime(),
});

export const identityRepresentationSchema = vcsIdentitySchema;

export const accountRepresentationSchema = z
  .object({
    id: z.string(),
    namespace: vcsNamespaceSchema,
    installation: vcsInstallationSchema,
    state: accountStateSchema,
  })
  .superRefine((account, context) => {
    if (account.installation.provider !== account.namespace.provider) {
      context.addIssue({
        code: 'custom',
        message: 'Installation provider must match the account namespace provider',
        path: ['installation', 'provider'],
      });
    }
    if (account.installation.namespaceId !== account.namespace.id) {
      context.addIssue({
        code: 'custom',
        message: 'Installation namespace must match the account namespace',
        path: ['installation', 'namespaceId'],
      });
    }
  });

export const membershipRepresentationSchema = z.object({
  accountId: z.string(),
  identityId: z.string(),
  role: accountRoleSchema,
});

export const accountErrorCodeSchema = z.enum([
  'ACCOUNT_ACCESS_REVOKED',
  'ACCOUNT_SUSPENDED',
  'IDENTITY_NOT_FOUND',
  'INSTALLATION_REQUIRED',
  'INSTALLATION_UNAVAILABLE',
  'PERSONAL_NAMESPACE_IDENTITY_MISMATCH',
  'OWNER_REQUIRED',
  'PROVIDER_MALFORMED_RESPONSE',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_TIMEOUT',
]);

export type SessionRepresentation = z.infer<typeof sessionRepresentationSchema>;
export type IdentityRepresentation = z.infer<typeof identityRepresentationSchema>;
export type AccountRepresentation = z.infer<typeof accountRepresentationSchema>;
export type MembershipRepresentation = z.infer<typeof membershipRepresentationSchema>;
export type AccountErrorCode = z.infer<typeof accountErrorCodeSchema>;
