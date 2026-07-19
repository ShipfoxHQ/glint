import type {
  IdempotencyRecord,
  Project,
  ProjectToken,
  RepositoryProjection,
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

export function repositoryProjectionFromRow(row: Row): RepositoryProjection {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    provider: String(row.provider),
    installationId: String(row.installation_id),
    providerRepositoryId: String(row.provider_repository_id),
    ownerLogin: String(row.owner_login),
    name: String(row.name),
    defaultBranch: String(row.default_branch),
    visibility: String(row.visibility),
    accessState: row.access_state as RepositoryProjection['accessState'],
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}
export function projectFromRow(row: Row): Project {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    repositoryId: String(row.repository_id),
    slug: String(row.slug),
    name: String(row.name),
    visibility: row.visibility as Project['visibility'],
    state: row.state as Project['state'],
    createdBy: String(row.created_by),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}
export function projectTokenFromRow(row: Row): ProjectToken {
  const lastUsedAt = optionalDate(row.last_used_at);
  const revokedAt = optionalDate(row.revoked_at);
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    projectId: String(row.project_id),
    label: String(row.label),
    tokenPrefix: String(row.token_prefix),
    tokenDigest: String(row.token_digest),
    scope: row.scope as ProjectToken['scope'],
    createdBy: String(row.created_by),
    ...(lastUsedAt === undefined ? {} : {lastUsedAt}),
    ...(revokedAt === undefined ? {} : {revokedAt}),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}
export function idempotencyRecordFromRow(row: Row): IdempotencyRecord {
  const resultReference = optionalText(row.result_reference);
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    actor: String(row.actor),
    route: String(row.route),
    idempotencyKey: String(row.idempotency_key),
    requestDigest: String(row.request_digest),
    ...(resultReference === undefined ? {} : {resultReference}),
    expiresAt: date(row.expires_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}
