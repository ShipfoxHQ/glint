# Transactional outbox port

`@glint/node-outbox` appends typed events inside an injected database transaction. Dispatchers claim
events with leases, acknowledge successful delivery, and retry failures. Event IDs are idempotency
keys, and an expired lease makes an unacknowledged event visible again.

Adapters should run `transactionalOutboxContractTests` from
`@glint/node-outbox/contract-test-kit`. The suite proves commit/rollback atomicity, duplicate safety,
lease redelivery, acknowledgment, and pending-age health reporting.
