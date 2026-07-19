import type {
  Account,
  Installation,
  MembershipProjection,
  OAuthAttempt,
  ProviderIdentity,
} from '../core/types.js';

type Row = Record<string, unknown>;
export function requiredRow(rows: readonly Row[]): Row {
  const row = rows[0];
  if (!row) throw new Error('Expected a PostgreSQL statement to return one row.');
  return row;
}
const date = (value: unknown) => new Date(value as string | Date);
const optionalDate = (value: unknown) => (value == null ? undefined : date(value));
const optionalText = (value: unknown) => (value == null ? undefined : String(value));

export function providerIdentityFromRow(row: Row): ProviderIdentity {
  const displayName = optionalText(row.display_name);
  const avatarUrl = optionalText(row.avatar_url);
  return {
    id: String(row.id),
    provider: String(row.provider),
    providerUserId: String(row.provider_user_id),
    login: String(row.login),
    ...(displayName === undefined ? {} : {displayName}),
    ...(avatarUrl === undefined ? {} : {avatarUrl}),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}
export function oauthAttemptFromRow(row: Row): OAuthAttempt {
  const consumedAt = optionalDate(row.consumed_at);
  return {
    id: String(row.id),
    stateDigest: String(row.state_digest),
    pkceVerifier: String(row.pkce_verifier),
    returnLocation: String(row.return_location),
    environment: String(row.environment),
    expiresAt: date(row.expires_at),
    ...(consumedAt === undefined ? {} : {consumedAt}),
  };
}
export function accountFromRow(row: Row): Account {
  const avatarUrl = optionalText(row.avatar_url);
  return {
    id: String(row.id),
    provider: String(row.provider),
    providerNamespaceId: String(row.provider_namespace_id),
    namespaceKind: row.namespace_kind as Account['namespaceKind'],
    slug: String(row.slug),
    displayName: String(row.display_name),
    ...(avatarUrl === undefined ? {} : {avatarUrl}),
    state: row.state as Account['state'],
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}
export function installationFromRow(row: Row): Installation {
  const suspendedAt = optionalDate(row.suspended_at);
  const removedAt = optionalDate(row.removed_at);
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    provider: String(row.provider),
    providerInstallationId: String(row.provider_installation_id),
    state: row.state as Installation['state'],
    repositorySelection: row.repository_selection as Installation['repositorySelection'],
    installedAt: date(row.installed_at),
    ...(suspendedAt === undefined ? {} : {suspendedAt}),
    ...(removedAt === undefined ? {} : {removedAt}),
  };
}
export function membershipFromRow(row: Row): MembershipProjection {
  const providerRole = optionalText(row.provider_role);
  const verifiedAt = optionalDate(row.verified_at);
  const leaseExpiresAt = optionalDate(row.lease_expires_at);
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    identityId: String(row.identity_id),
    ...(providerRole === undefined ? {} : {providerRole}),
    role: row.role as MembershipProjection['role'],
    state: row.state as MembershipProjection['state'],
    ...(verifiedAt === undefined ? {} : {verifiedAt}),
    ...(leaseExpiresAt === undefined ? {} : {leaseExpiresAt}),
  };
}
