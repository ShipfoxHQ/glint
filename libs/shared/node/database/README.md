# Database port

`@glint/node-database` owns the provider-neutral transaction boundary. Feature repositories and the
transactional outbox receive the same opaque `DatabaseTransaction`, allowing a concrete database
adapter to commit or roll back their work atomically without exposing SQL builders or ORM types.
Transaction options carry the tenant context required by row-level security and the approved
five-second statement deadline. `health()` reports cached adapter state and must not connect to or
wake a suspended database.

Adapters should run the reusable `databaseContractTests` suite from
`@glint/node-database/contract-test-kit`. `InMemoryDatabase` is the local reference fake and a test
harness; it is not a production persistence implementation.
