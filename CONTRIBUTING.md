# Contributing to Glint

## Prerequisites

Install [mise](https://mise.jdx.dev/) and Docker Desktop. Mise installs the pinned Node, pnpm,
and Turbo versions used by CI.

```sh
mise install
pnpm install --frozen-lockfile
turbo build
```

## Required checks

Pull requests run the same repository gates available locally:

```sh
mise run verify                         # architecture, lint, types, build, exports, tests
docker compose up --wait -d postgres garage
docker compose run --rm garage-init
mise run database:test                  # PostgreSQL migration and outbox contracts
pnpm run export-check                   # after a build; validates declared package entry points
turbo image --filter @glint/app-worker  # build-only container validation; does not publish
```

`mise run verify` builds before checking exports so conditional `default` and `types` targets
must be present in `dist/`. CI additionally runs the migrate app against a fresh PostgreSQL
container and rejects stale committed generated artifacts. Turbo's remote cache is optional: pull
requests may read trusted main-branch cache entries but never write them.

## Local stack

Use `mise run local:start` to build the four composition roots, start PostgreSQL and Garage, run
migrations, and launch the API, worker, and web. `mise run local:test` checks their health
endpoints; `mise run local:stop` preserves data and `mise run local:reset` removes it.

## Repository layout

- `apps/` contains composition roots only.
- `libs/` contains product and shared packages.
- `architecture/` contains executable package and dependency policy checks.
- `dev/` contains local-stack dependencies and lifecycle scripts.

Turbo owns package `check`, `type`, `type:emit`, `build`, `test`, and `depcruise` tasks. Import
other packages through their roots only. `#*` aliases are private to the package that declares
them; conditional exports map `development` to `src/` and default production consumers to `dist/`.
