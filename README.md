# Glint

Glint is Shipfox's visual regression platform. The repository architecture and delivery plan
live in [`docs/system-design.md`](docs/system-design.md).

The approved MVP providers, runtime, local substitutes, cost envelope, and safety limits are in
[`docs/decisions`](docs/decisions/README.md) and
[`docs/deployment/reference-topology.md`](docs/deployment/reference-topology.md).

## Local bootstrap

Install [mise](https://mise.jdx.dev/), then prepare and verify a fresh checkout:

```sh
mise install
mise run bootstrap
mise run verify
```

The individual `build`, `check`, `type`, `type:emit`, `test`, and `depcruise` tasks are also
available through `mise run <task>`. Package scripts remain independently runnable through
pnpm as packages land.

## Local services

The root `compose.yml` is the local application stack. Start it with:

```sh
docker compose up -d --wait
```

It currently provides PostgreSQL 18 with persistent `glint` and isolated `glint_test` databases;
later composition-root issues add their services to the same file. Set `GLINT_POSTGRES_PORT` when
another workspace already owns port 5432 and expose the same value to processes as `POSTGRES_PORT`.
With PostgreSQL running, `mise run database:test` exercises the real transaction, migration, and
outbox contracts.

## Package architecture

Start a real package from one of the eight shapes in [`templates/packages`](templates/packages/README.md). The templates encode package type and runtime metadata, root-only development/default exports, internal `#*` aliases, and a package-local `depcruise` task. They are excluded from the workspace so future features are not scaffolded before they own behavior.

`mise run depcruise` checks both the workspace manifest graph and every package-local source graph. The shared policy rejects the ten forbidden dependency directions documented in the system design, deep imports that bypass package exports, and cycles. `mise run verify` also runs the architecture fixture tests.
