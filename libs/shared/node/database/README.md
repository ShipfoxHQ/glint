# Database foundation

`@glint/node-database` owns the provider-neutral transaction contract and the selected PostgreSQL
18 implementation built on the published Shipfox PostgreSQL and Drizzle packages.

## Runtime PostgreSQL

```ts
import {createPostgresDatabase} from '@glint/node-database';

const database = await createPostgresDatabase({logger});

await database.transaction(async (transaction) => {
  await database.useTransaction(transaction, (tx) => tx.insert(table).values(value));
});
```

`createPostgresDatabase()` validates configuration, creates the pool, and runs one startup
connection and message-locale check. It never runs migrations. Transactions default to the
five-second MVP statement deadline and support read-only, isolation, and transaction-local scope
options. The
Shipfox PostgreSQL factory owns one process-wide pool; construct it once in each composition root
and close it during graceful shutdown. Supported PostgreSQL environments must expose English
`lc_messages` (`C`, `POSIX`, or an `en_*` locale) so SQLSTATE `57014` cancellations can be
distinguished as statement timeouts without misclassifying external cancellation.

`database.health()` returns cached adapter state. It does not query PostgreSQL, so public health
checks do not wake a suspended Neon database. Startup and runtime connection failures update the
cached state and emit an actionable structured log. Register `database.assertReady` with the
observability health registry when dependency-aware readiness is required.

## Transaction scopes

Every managed transaction is exactly one of these scopes:

```text
global -> session lookup
identity(identityId) -> account summaries and access projections
tenant(accountId) -> account resources, after application authorization
```

The options are mutually exclusive. Use `identity: {identityId}` for bootstrap discovery and keep
the existing `tenant: {accountId}` syntax for account resources; omit both for a global
transaction. The database boundary is structural only: provider-derived authorization and the
decision to begin an account transaction belong to the application layer (GLI-26).

PostgreSQL sets `statement_timeout`, `glint.identity_id`, and `glint.account_id` through one
parameterized, transaction-local setup query. Managed transactions explicitly set unused contexts
to an empty string and policies should normalize them with
`NULLIF(current_setting('glint.identity_id', true), '')` or
`NULLIF(current_setting('glint.account_id', true), '')`; PostgreSQL can return an empty string for
an unset custom setting. Local settings reset after commit or rollback, preventing a pooled client
from carrying either scope into later work.

## One-shot migrations

```ts
import {runOrderedMigrations} from '@glint/node-database';

await runOrderedMigrations(database.drizzle, composition.capabilities.migrations);
```

The migrate composition root calls this function through the direct database endpoint. It runs
each module directory sequentially in the dependency order supplied by `@glint/node-module` and
uses a stable, module-specific migration history table. API and worker startup must never call it.

## Configuration

| Variable | Local default | Managed application guidance |
| --- | --- | --- |
| `POSTGRES_HOST` | `127.0.0.1` | Pooled Neon hostname; direct hostname for migrations |
| `POSTGRES_PORT` | `5432` | `5432` |
| `POSTGRES_USERNAME` | `glint` | Environment-specific role |
| `POSTGRES_PASSWORD` | `local-glint` | Secrets-manager value |
| `POSTGRES_DATABASE` | `glint` | `glint` |
| `POSTGRES_MAX_CONNECTIONS` | `10` | `1` per Lambda execution environment |
| `POSTGRES_CONNECTION_TIMEOUT_MS` | `5000` | `5000` |
| `POSTGRES_IDLE_TIMEOUT_MS` | `10000` | `10000` for scale-to-zero |
| `POSTGRES_TLS_MODE` | `disable` | `verify-full` (required for non-local hosts) |

The root `compose.yml` supplies these local defaults and creates the separate `glint_test`
database. Production and migration processes use the same schema with their deployed environment:
the application points at Neon's pooled endpoint with one connection, while the one-shot migration
artifact points at the direct endpoint. Both use `POSTGRES_TLS_MODE=verify-full`.

## Contract tests

Adapters run `databaseContractTests` from `@glint/node-database/contract-test-kit`. Start the
pinned local service and run the real PostgreSQL suite with:

```sh
docker compose up -d --wait
mise run database:test
docker compose down
```

Each integration run creates and drops a uniquely named empty database, so migration tests exercise
the fresh-database path without deleting the persistent local-development volume.
