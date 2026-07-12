# Transactional outbox

`@glint/node-outbox` keeps Glint's event and delivery contract provider-neutral. Its PostgreSQL
adapter delegates durable persistence, `SKIP LOCKED` claims, leases, bounded retries, and
dead-letter transitions to the published `@shipfox/node-outbox` package.

## PostgreSQL adapter

```ts
import {runOrderedMigrations} from '@glint/node-database';
import {POSTGRES_OUTBOX_MIGRATION, PostgresTransactionalOutbox} from '@glint/node-outbox';

// One-shot migrate process only.
await runOrderedMigrations(database.drizzle, [POSTGRES_OUTBOX_MIGRATION]);

// API or worker composition root after migrations have completed.
const outbox = new PostgresTransactionalOutbox({database});

await database.transaction(async (transaction) => {
  await writeDomainState(transaction);
  await outbox.append(transaction, {
    id: 'build:123:finalized:v1',
    topic: 'build.finalized.v1',
    payload: {buildId: '123'},
    occurredAt: new Date(),
  });
});
```

The event ID becomes the durable idempotency key. The adapter preserves the typed payload,
correlation ID, trace parent, occurrence time, and delayed availability. The row ID remains an
internal delivery identity.

Add `POSTGRES_OUTBOX_MIGRATION` to the migration composition. Request startup only constructs the
adapter; it never applies this migration.

## Delivery guarantees

- Concurrent workers claim disjoint rows through leased `FOR UPDATE SKIP LOCKED` operations.
- Duplicate event IDs keep the first durable event and return `duplicate`.
- Expired leases are redelivered with a new token and incremented attempt count.
- An acknowledgement or retry carrying an older token returns `stale` and cannot mutate the newer
  delivery.
- Retries have bounded delays and move exhausted events to dead letter.
- Health maps the database adapter's cached readiness without querying or waking PostgreSQL.

The in-memory adapter implements the same delivery and dead-letter contract for core and feature
tests and additionally exposes pending age from its local state. Concrete adapters should run
`transactionalOutboxContractTests` from `@glint/node-outbox/contract-test-kit`.

## Verification

```sh
docker compose up -d --wait
mise run database:test
docker compose down
```

Each integration run creates and drops a uniquely named empty database. Reusing the Compose volume
therefore preserves ordinary local state without weakening fresh-migration coverage.
