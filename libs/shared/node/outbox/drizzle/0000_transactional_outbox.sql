CREATE TABLE glint_outbox (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  idempotency_key text NOT NULL,
  event_type text NOT NULL,
  ordering_key text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  dispatch_attempts integer NOT NULL DEFAULT 0,
  next_dispatch_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_dispatch_error jsonb,
  last_dispatch_failed_at timestamptz,
  dead_lettered_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX glint_outbox_idempotency_key_idx ON glint_outbox (idempotency_key);
--> statement-breakpoint
CREATE UNIQUE INDEX glint_outbox_lease_token_idx ON glint_outbox (lease_token);
--> statement-breakpoint
CREATE INDEX glint_outbox_pending_idx
  ON glint_outbox (next_dispatch_at, created_at, id)
  WHERE dispatched_at IS NULL AND dead_lettered_at IS NULL;
--> statement-breakpoint
CREATE INDEX glint_outbox_dispatched_retention_idx
  ON glint_outbox (dispatched_at, id)
  WHERE dispatched_at IS NOT NULL;
