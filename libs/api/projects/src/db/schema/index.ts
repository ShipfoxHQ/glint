import {sql} from 'drizzle-orm';
import {
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const repositoriesAccessState = pgEnum('repositories_access_state', [
  'active',
  'removed',
  'suspended',
]);
export const projectsState = pgEnum('projects_state', ['active', 'suspended']);
export const projectsVisibility = pgEnum('projects_visibility', ['private', 'public']);
export const projectTokensScope = pgEnum('project_tokens_scope', ['build-write']);
const timestamps = {
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
};

export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    accountId: uuid('account_id').notNull(),
    provider: text('provider').notNull(),
    installationId: uuid('installation_id').notNull(),
    providerRepositoryId: text('provider_repository_id').notNull(),
    ownerLogin: text('owner_login').notNull(),
    name: text('name').notNull(),
    defaultBranch: text('default_branch').notNull(),
    visibility: text('visibility').notNull(),
    accessState: repositoriesAccessState('access_state').notNull().default('active'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('repositories_account_provider_repository_unique').on(
      t.accountId,
      t.provider,
      t.providerRepositoryId,
    ),
    uniqueIndex('repositories_account_id_unique').on(t.accountId, t.id),
  ],
);
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    accountId: uuid('account_id').notNull(),
    repositoryId: uuid('repository_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    visibility: projectsVisibility('visibility').notNull().default('private'),
    state: projectsState('state').notNull().default('active'),
    createdBy: uuid('created_by').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('projects_account_slug_unique').on(t.accountId, t.slug),
    uniqueIndex('projects_account_repository_unique').on(t.accountId, t.repositoryId),
    uniqueIndex('projects_account_id_unique').on(t.accountId, t.id),
    foreignKey({
      columns: [t.accountId, t.repositoryId],
      foreignColumns: [repositories.accountId, repositories.id],
      name: 'projects_repository_fkey',
    }),
  ],
);
export const projectTokens = pgTable(
  'project_tokens',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    accountId: uuid('account_id').notNull(),
    projectId: uuid('project_id').notNull(),
    label: text('label').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    tokenDigest: text('token_digest').notNull(),
    scope: projectTokensScope('scope').notNull().default('build-write'),
    createdBy: uuid('created_by').notNull(),
    lastUsedAt: timestamp('last_used_at', {withTimezone: true}),
    revokedAt: timestamp('revoked_at', {withTimezone: true}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('project_tokens_digest_unique').on(t.tokenDigest),
    uniqueIndex('project_tokens_prefix_unique').on(t.tokenPrefix),
    uniqueIndex('project_tokens_active_label_unique')
      .on(t.accountId, t.projectId, t.label)
      .where(sql`${t.revokedAt} IS NULL`),
    index('project_tokens_account_project_idx').on(t.accountId, t.projectId),
    foreignKey({
      columns: [t.accountId, t.projectId],
      foreignColumns: [projects.accountId, projects.id],
      name: 'project_tokens_project_fkey',
    }),
  ],
);
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    accountId: uuid('account_id').notNull(),
    actor: uuid('actor').notNull(),
    route: text('route').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestDigest: text('request_digest').notNull(),
    resultReference: text('result_reference'),
    expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('idempotency_records_account_actor_route_key_unique').on(
      t.accountId,
      t.actor,
      t.route,
      t.idempotencyKey,
    ),
    index('idempotency_records_expires_at_idx').on(t.expiresAt),
  ],
);
