# Glint

Glint is Shipfox's visual regression platform. The repository architecture and delivery plan
live in [`docs/system-design.md`](docs/system-design.md).

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
