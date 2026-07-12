# Job-queue port

`@glint/node-queue` defines deterministic job identity and at-least-once delivery. Claims carry an
opaque lease token; acknowledgments, retries, lease extensions, bounded attempts, dead letters,
redrive, correlation context, and queue-age readiness are explicit capabilities.

Adapters should run `jobQueueContractTests` from `@glint/node-queue/contract-test-kit`. Consumers
must remain idempotent because an expired unacknowledged lease deliberately redelivers the job.

`MVP_JOB_QUEUE_POLICY` captures the approved provider-independent behavior: 90-second visibility,
five attempts, four-day source retention, fourteen-day dead-letter retention, and queue-age warning
and critical thresholds. The queue makes no ordering guarantee.
