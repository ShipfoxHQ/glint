CREATE TYPE accounts_state AS ENUM ('active', 'suspended');
--> statement-breakpoint
CREATE TYPE accounts_namespace_kind AS ENUM ('organization', 'user');
--> statement-breakpoint
CREATE TYPE accounts_installation_state AS ENUM ('active', 'suspended', 'removed');
--> statement-breakpoint
CREATE TYPE accounts_membership_state AS ENUM ('active', 'inactive');
--> statement-breakpoint
CREATE TYPE accounts_membership_role AS ENUM ('owner', 'reviewer', 'viewer');
--> statement-breakpoint
CREATE TABLE auth_provider_identities (
  id uuid PRIMARY KEY DEFAULT uuidv7(), provider text NOT NULL, provider_user_id text NOT NULL,
  login text NOT NULL, display_name text, avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_provider_identities_provider_user_unique UNIQUE (provider, provider_user_id)
);
--> statement-breakpoint
CREATE TABLE auth_oauth_attempts (
  id uuid PRIMARY KEY DEFAULT uuidv7(), state_digest text NOT NULL UNIQUE, pkce_verifier text NOT NULL,
  return_location text NOT NULL, environment text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT uuidv7(), identity_id uuid NOT NULL REFERENCES auth_provider_identities(id),
  token_digest text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL, inactivity_expires_at timestamptz NOT NULL, revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT uuidv7(), provider text NOT NULL, provider_namespace_id text NOT NULL,
  namespace_kind accounts_namespace_kind NOT NULL, slug text NOT NULL, display_name text NOT NULL, avatar_url text,
  state accounts_state NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_provider_namespace_unique UNIQUE (provider, provider_namespace_id),
  CONSTRAINT accounts_provider_slug_unique UNIQUE (provider, slug),
  CONSTRAINT accounts_id_provider_unique UNIQUE (id, provider)
);
--> statement-breakpoint
CREATE TABLE accounts_installations (
  id uuid PRIMARY KEY DEFAULT uuidv7(), account_id uuid NOT NULL, provider text NOT NULL, provider_installation_id text NOT NULL,
  state accounts_installation_state NOT NULL, repository_selection text NOT NULL, installed_at timestamptz NOT NULL, suspended_at timestamptz, removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_installations_provider_installation_unique UNIQUE (provider, provider_installation_id),
  CONSTRAINT accounts_installations_account_provider_fkey FOREIGN KEY (account_id, provider) REFERENCES accounts (id, provider)
);
--> statement-breakpoint
CREATE UNIQUE INDEX accounts_installations_current_unique ON accounts_installations (account_id, provider) WHERE state <> 'removed';
--> statement-breakpoint
CREATE TABLE accounts_memberships (
  id uuid PRIMARY KEY DEFAULT uuidv7(), account_id uuid NOT NULL REFERENCES accounts(id), identity_id uuid NOT NULL,
  provider_role text, role accounts_membership_role NOT NULL, state accounts_membership_state NOT NULL,
  verified_at timestamptz, lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_memberships_account_identity_unique UNIQUE (account_id, identity_id)
);
--> statement-breakpoint
CREATE INDEX accounts_memberships_identity_id_idx ON accounts_memberships (identity_id);
--> statement-breakpoint
-- Scope map: global -> auth tables; identity -> memberships/account summaries; tenant -> account resources.
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE accounts_installations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE accounts_memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY accounts_tenant ON accounts
  USING (id::text = NULLIF(current_setting('glint.account_id', true), ''))
  WITH CHECK (id::text = NULLIF(current_setting('glint.account_id', true), ''));
--> statement-breakpoint
CREATE POLICY accounts_identity_read ON accounts FOR SELECT USING (
  EXISTS (SELECT 1 FROM accounts_memberships m WHERE m.account_id = accounts.id
    AND m.identity_id::text = NULLIF(current_setting('glint.identity_id', true), '') AND m.state = 'active')
);
--> statement-breakpoint
CREATE POLICY accounts_memberships_identity_read ON accounts_memberships FOR SELECT
  USING (identity_id::text = NULLIF(current_setting('glint.identity_id', true), ''));
--> statement-breakpoint
CREATE POLICY accounts_memberships_tenant ON accounts_memberships
  USING (account_id::text = NULLIF(current_setting('glint.account_id', true), ''))
  WITH CHECK (account_id::text = NULLIF(current_setting('glint.account_id', true), ''));
--> statement-breakpoint
CREATE POLICY accounts_installations_tenant ON accounts_installations
  USING (account_id::text = NULLIF(current_setting('glint.account_id', true), ''))
  WITH CHECK (account_id::text = NULLIF(current_setting('glint.account_id', true), ''));
