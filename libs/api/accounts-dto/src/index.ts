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

export const accountSummaryRepresentationSchema = z.object({
  id: z.string(),
  namespace: vcsNamespaceSchema,
  slug: z.string(),
  displayName: z.string(),
  role: accountRoleSchema,
  state: accountStateSchema,
  verifiedAt: z.iso.datetime().optional(),
  leaseExpiresAt: z.iso.datetime().optional(),
});

/** Account reads may precede installation onboarding, so installation is intentionally optional. */
export const accountDetailRepresentationSchema = z
  .object({
    id: z.string(),
    namespace: vcsNamespaceSchema,
    installation: vcsInstallationSchema.optional(),
    state: accountStateSchema,
  })
  .superRefine((account, context) => {
    if (account.installation && account.installation.provider !== account.namespace.provider) {
      context.addIssue({
        code: 'custom',
        message: 'Installation provider must match the account namespace provider',
        path: ['installation', 'provider'],
      });
    }
    if (account.installation && account.installation.namespaceId !== account.namespace.id) {
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

export const authErrorCodeSchema = z.enum([
  'OAUTH_STATE_INVALID',
  'OAUTH_ACCESS_DENIED',
  'OAUTH_EXCHANGE_FAILED',
  'IDENTITY_PROVIDER_UNAVAILABLE',
  'SESSION_EXPIRED',
  'REQUEST_ORIGIN_INVALID',
  'REQUEST_CONTENT_TYPE_INVALID',
  'REQUEST_PREFLIGHT_MISSING',
]);

export const authErrorResponseSchema = z.object({
  error: z.object({code: authErrorCodeSchema}),
});

export const accountErrorResponseSchema = z.object({
  error: z.object({code: accountErrorCodeSchema}),
});

export const sessionEnvelopeSchema = z.object({
  session: sessionRepresentationSchema,
  identity: identityRepresentationSchema,
  accounts: z.array(accountSummaryRepresentationSchema),
});

export type SessionRepresentation = z.infer<typeof sessionRepresentationSchema>;
export type IdentityRepresentation = z.infer<typeof identityRepresentationSchema>;
export type AccountRepresentation = z.infer<typeof accountRepresentationSchema>;
export type AccountSummaryRepresentation = z.infer<typeof accountSummaryRepresentationSchema>;
export type AccountDetailRepresentation = z.infer<typeof accountDetailRepresentationSchema>;
export type MembershipRepresentation = z.infer<typeof membershipRepresentationSchema>;
export type AccountErrorCode = z.infer<typeof accountErrorCodeSchema>;
export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>;
export type AuthErrorResponse = z.infer<typeof authErrorResponseSchema>;
export type AccountErrorResponse = z.infer<typeof accountErrorResponseSchema>;
export type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;
