# Job-queue port

`@glint/node-queue` defines deterministic job identity and at-least-once delivery. Claims carry an
opaque lease token; acknowledgments, retries, lease extensions, bounded attempts, dead letters,
redrive, correlation context, and queue-age readiness are explicit capabilities.

`InMemoryJobQueue` is the zero-service local adapter. It deliberately accepts repeated enqueues with
the same stable job ID so local consumers exercise the duplicate-safe behavior required by SQS
Standard. `SqsJobQueue` maps claims to SQS receipt handles and visibility, explicitly moves an
exhausted retry to the configured dead-letter queue, and can redrive dead letters back to the source
queue. SQS enqueue delays are limited to 15 minutes and lease/retry visibility to 12 hours.
Claims are limited to SQS's ten-message receive bound and use 20-second long polling by default;
local timing rounds to the same one-second visibility granularity.

Adapters should run `jobQueueContractTests` from `@glint/node-queue/contract-test-kit`. Consumers
must remain idempotent because an expired unacknowledged lease deliberately redelivers the job.

Both adapters emit `glint_queue_enqueued_total`, `glint_queue_deliveries_total`,
`glint_queue_dead_letters_total`, and `glint_queue_age_ms` through the shared no-op-safe
OpenTelemetry provider. The SQS health check verifies queue access; callers can inject the provider
age metric reader to include `oldestJobAgeMs` in readiness without receiving or hiding a message.
Per-message SQS redrive requires a receipt obtained by `listDeadLetters` in the same queue-adapter
process. If that receipt is unavailable or was evicted from the bounded tracking cache, redrive fails
with `DeadLetterNotFoundError` instead of reporting false success; cross-process operator redrive
should use the provider's queue-level redrive workflow.

`MVP_JOB_QUEUE_POLICY` captures the approved provider-independent behavior: 90-second visibility,
five attempts, four-day source retention, fourteen-day dead-letter retention, and queue-age warning
and critical thresholds. The queue makes no ordering guarantee.
