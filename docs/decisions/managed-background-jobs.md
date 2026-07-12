# Managed background jobs

- Status: Approved
- Date: 2026-07-12

## Context

Image verification and comparison need durable at-least-once delivery, bounded retries, dead-letter
handling, queue-age metrics, and no ordering assumption. PostgreSQL remains the durable source of
truth; messages carry stable job and correlation identifiers.

## Decision

Use one Amazon Simple Queue Service Standard queue and one dead-letter queue in Frankfurt.

- Deliver one message to each Lambda invocation with no batching window.
- Use a 90-second visibility timeout for the 15-second worker function.
- Retain source messages for four days and dead-letter messages for fourteen days.
- Move a message to the dead-letter queue after five receives.
- Cap both the event source and worker Lambda at 32 concurrent invocations.
- Cap each account and each installation at 16 concurrent jobs using database-backed leases.
- Enable partial-batch failure reporting even though the batch size is one.
- Warn when the oldest message reaches 60 seconds and alert critically at 300 seconds.
- Treat any dead-letter message as an operational incident.

Local development uses an in-process durable fake with the same claim, acknowledgement, retry,
lease expiry, and dead-letter semantics.

## Why

- SQS Standard explicitly permits duplicate and out-of-order delivery, matching the idempotent job
  contract.
- Lambda manages polling and scales to zero without an always-on worker.
- A concurrency cap of 32 drains the measured 143-job burst in a few waves without allowing image
  decoding to consume the AWS account's entire Lambda allowance.
- Account and installation leases prevent one customer from monopolizing the worker.

## Alternatives considered

- **SQS FIFO:** ordering is unnecessary, and duplicate processing must already be safe.
- **RabbitMQ or Redis:** add an always-on broker for a modest workload.
- **PostgreSQL as the only queue:** polling execution from the primary database would couple worker
  bursts to API transactions. The transactional outbox remains in PostgreSQL, but delivery uses
  SQS.

## Consequences

Every consumer is idempotent and claims durable work before processing. Acknowledging, retrying,
and requeuing never depend on AWS message identifiers in domain code. Durable job state makes queue
reconstruction possible after message loss or expiry.

## Evidence

- AWS documents Standard queue delivery semantics: <https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html>
- AWS documents Lambda queue visibility and retry guidance: <https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html>
