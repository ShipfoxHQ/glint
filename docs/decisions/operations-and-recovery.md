# Operations and recovery

- Status: Approved
- Date: 2026-07-12

## Context

The reference deployment should remain operable without requiring another hosted observability
provider or a multi-region control plane. It still needs actionable failures, bounded costs,
recoverable data, and explicit artifact retention.

## Decision

Use CloudWatch for the initial operational baseline and keep instrumentation provider-neutral.

- Emit structured JSON application logs.
- Record API Gateway request identifiers, routes, status, latency, and response size.
- Track Lambda errors, duration, throttling, concurrency, and cold starts.
- Track queue age and dead-letter depth.
- Track Neon compute wake-ups, connection pressure, and storage through Neon metrics.
- Propagate one correlation identifier through API Gateway, Fastify, queue messages, worker logs,
  and build records.
- Never log image contents, authorization headers, cookies, signed addresses, webhook signatures,
  OAuth credentials, or database connection strings.

Use this retention policy:

- Retain current baseline images while the project exists.
- Retain the latest build for each open pull request while it remains open.
- Retain superseded and closed pull-request image and diff artifacts for 30 days.
- Retain lightweight audit metadata for 90 days.
- Wait seven days before permanently deleting an unreferenced object.
- Revoke access immediately on account deletion, then delete objects asynchronously.

Use a single-region recovery model:

- Keep at least seven days of Neon point-in-time restore history.
- Keep deleted and non-current S3 object versions for seven days.
- Reproduce AWS resources from the infrastructure repository.
- Retain immutable application artifacts needed for current deployment and rollback.
- Reconstruct unfinished queue work from PostgreSQL and its transactional outbox.
- Complete a database-and-object restore exercise before production cutover.
- Do not add a cross-region database replica, S3 replication, or automated regional failover yet.

Set monthly cost alarms at 20, 35, and 50 US dollars. Review actual staging usage before production
and adjust alarm thresholds through the infrastructure repository.

## Why

- CloudWatch covers the selected AWS services without making another provider mandatory for an
  open-source installation.
- Thirty days covers normal review and regression investigation without retaining every image for
  a quarter.
- Versioning and point-in-time restore protect against accidental deletion and bad deployments.
- The first production workload does not justify the consistency and operating complexity of
  active multi-region recovery.

## Alternatives considered

- **Sentry or a hosted telemetry backend as a requirement:** better application exploration, but
  creates another required provider. The instrumentation boundary leaves this available later.
- **Fourteen-day artifact retention:** cheaper, but too short for common investigation cycles.
- **Ninety-day artifact retention:** more convenient, but retains many large images that are rarely
  viewed.
- **Automated regional failover:** protects against a prolonged Frankfurt outage but requires
  replicated database, objects, secrets, routing, and tested consistency behavior.

## Consequences

The MVP can recover from accidental deletion and application failure but not provide automatic
service during a prolonged full-region outage. Queue messages are intentionally not backed up;
durable idempotent job records are the recovery source.
