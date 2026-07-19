CREATE TYPE repositories_access_state AS ENUM ('active', 'removed', 'suspended');
--> statement-breakpoint
CREATE TYPE projects_state AS ENUM ('active', 'suspended');
--> statement-breakpoint
CREATE TYPE projects_visibility AS ENUM ('private', 'public');
--> statement-breakpoint
CREATE TYPE project_tokens_scope AS ENUM ('build-write');
--> statement-breakpoint
CREATE TABLE repositories (
  id uuid PRIMARY KEY DEFAULT uuidv7(), account_id uuid NOT NULL, provider text NOT NULL,
  installation_id uuid NOT NULL, provider_repository_id text NOT NULL, owner_login text NOT NULL,
  name text NOT NULL, default_branch text NOT NULL, visibility text NOT NULL,
  access_state repositories_access_state NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repositories_account_provider_repository_unique UNIQUE (account_id, provider, provider_repository_id),
  CONSTRAINT repositories_account_id_unique UNIQUE (account_id, id)
);
--> statement-breakpoint
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT uuidv7(), account_id uuid NOT NULL, repository_id uuid NOT NULL,
  slug text NOT NULL, name text NOT NULL, visibility projects_visibility NOT NULL DEFAULT 'private',
  state projects_state NOT NULL DEFAULT 'active', created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_account_slug_unique UNIQUE (account_id, slug),
  CONSTRAINT projects_account_repository_unique UNIQUE (account_id, repository_id),
  CONSTRAINT projects_account_id_unique UNIQUE (account_id, id),
  CONSTRAINT projects_repository_fkey FOREIGN KEY (account_id, repository_id) REFERENCES repositories (account_id, id)
);
--> statement-breakpoint
CREATE TABLE project_tokens (
  id uuid PRIMARY KEY DEFAULT uuidv7(), account_id uuid NOT NULL, project_id uuid NOT NULL,
  label text NOT NULL, token_prefix text NOT NULL, token_digest text NOT NULL,
  scope project_tokens_scope NOT NULL DEFAULT 'build-write', created_by uuid NOT NULL,
  last_used_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_tokens_digest_unique UNIQUE (token_digest),
  CONSTRAINT project_tokens_prefix_unique UNIQUE (token_prefix),
  CONSTRAINT project_tokens_project_fkey FOREIGN KEY (account_id, project_id) REFERENCES projects (account_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX project_tokens_active_label_unique ON project_tokens (account_id, project_id, label) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX project_tokens_account_project_idx ON project_tokens (account_id, project_id);
--> statement-breakpoint
CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT uuidv7(), account_id uuid NOT NULL, actor uuid NOT NULL,
  route text NOT NULL, idempotency_key text NOT NULL, request_digest text NOT NULL,
  result_reference text, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_records_account_actor_route_key_unique UNIQUE (account_id, actor, route, idempotency_key)
);
--> statement-breakpoint
CREATE INDEX idempotency_records_expires_at_idx ON idempotency_records (expires_at);
--> statement-breakpoint
ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE project_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY repositories_tenant ON repositories USING (account_id::text = NULLIF(current_setting('glint.account_id', true), '')) WITH CHECK (account_id::text = NULLIF(current_setting('glint.account_id', true), ''));
--> statement-breakpoint
CREATE POLICY projects_tenant ON projects USING (account_id::text = NULLIF(current_setting('glint.account_id', true), '')) WITH CHECK (account_id::text = NULLIF(current_setting('glint.account_id', true), ''));
--> statement-breakpoint
CREATE POLICY project_tokens_tenant ON project_tokens USING (account_id::text = NULLIF(current_setting('glint.account_id', true), '')) WITH CHECK (account_id::text = NULLIF(current_setting('glint.account_id', true), ''));
--> statement-breakpoint
CREATE POLICY idempotency_records_tenant ON idempotency_records USING (account_id::text = NULLIF(current_setting('glint.account_id', true), '')) WITH CHECK (account_id::text = NULLIF(current_setting('glint.account_id', true), ''));
