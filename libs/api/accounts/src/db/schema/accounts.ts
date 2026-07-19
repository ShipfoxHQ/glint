import {sql} from 'drizzle-orm';
import {foreignKey, index, pgEnum, text, timestamp, uniqueIndex, uuid} from 'drizzle-orm/pg-core';
import {accountsTable} from './common.js';

export const accountsState = pgEnum('accounts_state', ['active', 'suspended']);
export const accountsNamespaceKind = pgEnum('accounts_namespace_kind', ['organization', 'user']);
export const accountsInstallationState = pgEnum('accounts_installation_state', [
  'active',
  'suspended',
  'removed',
]);
export const accountsMembershipState = pgEnum('accounts_membership_state', ['active', 'inactive']);
export const accountsMembershipRole = pgEnum('accounts_membership_role', [
  'owner',
  'reviewer',
  'viewer',
]);
const timestamps = {
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
};

export const accounts = accountsTable(
  'accounts',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    provider: text('provider').notNull(),
    providerNamespaceId: text('provider_namespace_id').notNull(),
    namespaceKind: accountsNamespaceKind('namespace_kind').notNull(),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    state: accountsState('state').notNull().default('active'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('accounts_provider_namespace_unique').on(t.provider, t.providerNamespaceId),
    uniqueIndex('accounts_provider_slug_unique').on(t.provider, t.slug),
    uniqueIndex('accounts_id_provider_unique').on(t.id, t.provider),
  ],
);
export const installations = accountsTable(
  'installations',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    accountId: uuid('account_id').notNull(),
    provider: text('provider').notNull(),
    providerInstallationId: text('provider_installation_id').notNull(),
    state: accountsInstallationState('state').notNull(),
    repositorySelection: text('repository_selection').$type<'all' | 'selected'>().notNull(),
    installedAt: timestamp('installed_at', {withTimezone: true}).notNull(),
    suspendedAt: timestamp('suspended_at', {withTimezone: true}),
    removedAt: timestamp('removed_at', {withTimezone: true}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('accounts_installations_provider_installation_unique').on(
      t.provider,
      t.providerInstallationId,
    ),
    uniqueIndex('accounts_installations_current_unique')
      .on(t.accountId, t.provider)
      .where(sql`${t.state} <> 'removed'`),
    foreignKey({
      columns: [t.accountId, t.provider],
      foreignColumns: [accounts.id, accounts.provider],
      name: 'accounts_installations_account_provider_fkey',
    }),
  ],
);
export const memberships = accountsTable(
  'memberships',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    identityId: uuid('identity_id').notNull(),
    providerRole: text('provider_role'),
    role: accountsMembershipRole('role').notNull(),
    state: accountsMembershipState('state').notNull(),
    verifiedAt: timestamp('verified_at', {withTimezone: true}),
    leaseExpiresAt: timestamp('lease_expires_at', {withTimezone: true}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('accounts_memberships_account_identity_unique').on(t.accountId, t.identityId),
    index('accounts_memberships_identity_id_idx').on(t.identityId),
  ],
);
