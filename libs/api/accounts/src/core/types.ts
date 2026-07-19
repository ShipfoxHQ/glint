import type {AccountRole, AccountState} from './types.internal.js';

export interface ProviderIdentity {
  readonly id: string;
  readonly provider: string;
  readonly providerUserId: string;
  readonly login: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface OAuthAttempt {
  readonly id: string;
  readonly stateDigest: string;
  readonly pkceVerifier: string;
  readonly returnLocation: string;
  readonly environment: string;
  readonly expiresAt: Date;
  readonly consumedAt?: Date;
}
export interface Session {
  readonly id: string;
  readonly identityId: string;
  readonly tokenDigest: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly inactivityExpiresAt: Date;
  readonly revokedAt?: Date;
  readonly updatedAt: Date;
}
export interface Account {
  readonly id: string;
  readonly provider: string;
  readonly providerNamespaceId: string;
  readonly namespaceKind: 'organization' | 'user';
  readonly slug: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly state: AccountState;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
export interface Installation {
  readonly id: string;
  readonly accountId: string;
  readonly provider: string;
  readonly providerInstallationId: string;
  readonly state: 'active' | 'suspended' | 'removed';
  readonly repositorySelection: 'all' | 'selected';
  readonly installedAt: Date;
  readonly suspendedAt?: Date;
  readonly removedAt?: Date;
}
export interface MembershipProjection {
  readonly id: string;
  readonly accountId: string;
  readonly identityId: string;
  readonly providerRole?: string;
  readonly role: AccountRole;
  readonly state: 'active' | 'inactive';
  readonly verifiedAt?: Date;
  readonly leaseExpiresAt?: Date;
}
