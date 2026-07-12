# `@glint/node-module`

Provider-neutral declarations for composing backend feature modules.

Feature packages export a `GlintModule`. Composition roots validate and order those modules, then
select only the capabilities they start:

```ts
const composition = composeModules(modules);

const api = selectCapabilities(composition, ['routes', 'auth', 'publishers', 'subscribers']);
const worker = selectCapabilities(composition, ['publishers', 'subscribers', 'jobs', 'metrics']);
const migrationDirectories = collectMigrationDirectories(composition);
```

Capability values are opaque to this package. Their provider packages own concrete route, auth,
outbox, queue, and metrics contracts.

`collectMigrationDirectories` only returns directories in dependency order. It never executes a
migration. Only the one-shot `apps/migrate` deployment process may pass those directories to the
database migration runner; API and serverless request startup must not do so.
