# Package templates

Copy exactly one shape when real owned behavior is ready to land, then replace `example` in its name and repository path. Templates are excluded from `pnpm-workspace.yaml`; they are policy examples, not empty product packages.

| Shape | Destination | Add only when |
| --- | --- | --- |
| `dto` | `libs/api/<feature>-dto` | A public HTTP or event contract exists |
| `backend-feature` | `libs/api/<feature>` | A feature owns behavior; add `core`, `db`, `presentation`, `jobs`, etc. only as needed |
| `client` | `libs/client/<feature>` | A browser workflow owns state or UI behavior |
| `shared-node` | `libs/shared/node/<capability>` | At least two features need a Node-only primitive |
| `provider` | `libs/api/<port>/<provider>` | A concrete adapter implements a provider-neutral port |
| `compatibility` | `libs/api/compat/<protocol>` | A recorded external wire contract needs an adapter |
| `app` | `apps/<runtime>` | A deployable composition root exists |
| `e2e` | `e2e/<layer>/<suite>` | A cross-package behavior requires an end-to-end suite or helper |

Library shapes intentionally export only `src/index.ts` in development and `dist/index.*` by default. Add an explicit subpath export only for a designed public consumer; never export `core`, `db`, `presentation`, source paths, or test helpers. Every generated package keeps `depcruise` package-local so Turbo sees the real workspace DAG.

Each shape includes `tsconfig.json` and `tsconfig.build.json`. Browser packages use the React preset, Node packages use the Node preset, and universal DTO packages use the base configuration with no ambient types. Change an app's preset and `glint.environment` together when creating the web composition root.
