# Managed PostgreSQL

- Status: Approved
- Date: 2026-07-12

## Context

Glint requires PostgreSQL transactions, row-level security, ordered migrations, durable sessions,
and a transactional outbox. Traffic is concentrated in working hours, so the database should stop
consuming compute when idle without changing the PostgreSQL programming model.

## Decision

Use Neon in its AWS Frankfurt region with PostgreSQL 18.

- Application Lambdas use the pooled endpoint with at most one client connection per execution
  environment.
- The migration application uses the direct endpoint.
- Production and staging start at 0.25 compute units and may autoscale to 2 compute units.
- Production and staging may scale to zero after inactivity. Health checks must not wake the
  database.
- Keep at least seven days of point-in-time restore history.
- Set a five-second database statement timeout for API work.
- Local development and ordinary continuous integration use a pinned PostgreSQL container.

Glint will consume the published `@shipfox/node-postgres` and `@shipfox/node-drizzle` packages.
The PostgreSQL package must expose explicit secure transport and serverless pool configuration.
The Drizzle package must be published as a supported Shipfox package before Glint depends on it.

## Why

- Neon provides standard PostgreSQL, a pooled endpoint suitable for Lambda fan-out, autoscaling,
  and scale-to-zero.
- Frankfurt colocates database compute with the AWS API, object storage, queue, and worker.
- A direct migration endpoint preserves session semantics while request traffic uses transaction
  pooling.
- Reusing the Shipfox packages keeps database behavior consistent with the team's regular stack.

## Alternatives considered

- **Amazon RDS or Aurora PostgreSQL:** stronger single-cloud networking, but a higher fixed floor
  and more networking and sizing work for the initial workload.
- **Supabase:** its additional authentication, storage, and realtime services duplicate boundaries
  Glint owns.
- **SQLite or libSQL:** do not satisfy the selected PostgreSQL transaction and migration contracts.
- **Self-managed PostgreSQL:** adds backup, patching, and failover operations unrelated to the MVP.

## Consequences

Request code cannot depend on session-local state, temporary tables, or long-lived database
listeners. The first request after suspension may take a few hundred milliseconds longer while the
database wakes. This is acceptable because traffic is absent outside working hours and nearly every
authenticated request requires application data anyway.

Migrations are forward-compatible, one-shot release artifacts. They never run during API startup.

## Evidence

- Neon documents pooled connections: <https://neon.com/docs/connect/connection-pooling>
- Neon documents scale-to-zero behavior: <https://neon.com/docs/introduction/scale-to-zero>
- Neon lists AWS Frankfurt as a supported region: <https://neon.com/docs/introduction/regions>
