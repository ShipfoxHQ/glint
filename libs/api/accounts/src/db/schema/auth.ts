import {sql} from 'drizzle-orm';
import {text, timestamp, uniqueIndex, uuid} from 'drizzle-orm/pg-core';
import {authTable} from './common.js';

const timestamps = {
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
};
export const providerIdentities = authTable(
  'provider_identities',
  {
    id: uuid('id').default(sql`uuidv7()`).primaryKey(),
    provider: text('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    login: text('login').notNull(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('auth_provider_identities_provider_user_unique').on(t.provider, t.providerUserId),
  ],
);
export const oauthAttempts = authTable('oauth_attempts', {
  id: uuid('id').default(sql`uuidv7()`).primaryKey(),
  stateDigest: text('state_digest').notNull().unique(),
  pkceVerifier: text('pkce_verifier').notNull(),
  returnLocation: text('return_location').notNull(),
  environment: text('environment').notNull(),
  expiresAt: timestamp('expires_at', {withTimezone: true}).notNull(),
  consumedAt: timestamp('consumed_at', {withTimezone: true}),
  ...timestamps,
});
export const sessions = authTable('sessions', {
  id: uuid('id').default(sql`uuidv7()`).primaryKey(),
  identityId: uuid('identity_id')
    .notNull()
    .references(() => providerIdentities.id),
  tokenDigest: text('token_digest').notNull().unique(),
  createdAt: timestamp('created_at', {withTimezone: true}).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', {withTimezone: true}).notNull().defaultNow(),
  absoluteExpiresAt: timestamp('absolute_expires_at', {withTimezone: true}).notNull(),
  inactivityExpiresAt: timestamp('inactivity_expires_at', {withTimezone: true}).notNull(),
  revokedAt: timestamp('revoked_at', {withTimezone: true}),
  updatedAt: timestamp('updated_at', {withTimezone: true}).notNull().defaultNow(),
});
