# Argos producer protocol findings

These findings come from recordings made on 2026-07-11 with:

- `@argos-ci/cli@5.0.5`
- `@argos-ci/playwright@7.0.6`
- `@argos-ci/storybook@6.0.7`

All three producers use `@argos-ci/core@6.1.1` for uploads. The core package uses
`@argos-ci/api-client@0.22.0` for API requests.

## Main conclusions

- A skipped build does not use a special route. It sends `POST /v2/builds` with
  `skipped: true` and empty screenshot arrays.
- These producer versions do not call `POST /v2/baseline`.
- No-baseline, unchanged, and changed builds use the same producer-side request flow. The
  server decides the outcome.
- API requests retry network errors and HTTP 5xx responses. Signed multipart uploads do not
  use that retry logic.
- The client processes screenshots in groups of ten, but it still sends one build-create
  request and one build-update request. There is no metadata-chunk API route.
- The production object store must support signed multipart POST uploads. Presigned PUT alone
  is not compatible with this client path.

## Routes used by each flow

| Producer action | Requests |
| --- | --- |
| Normal, no-baseline, unchanged, changed, or empty upload | `GET /v2/project` → `POST /v2/builds` → signed multipart uploads, if needed → `PUT /v2/builds/{buildId}` |
| Skipped build | `POST /v2/builds` with `skipped: true` and empty screenshot arrays |
| Parallel shard | Normal upload flow, with the parallel identity on create and the shard index and total on update |
| Manual parallel finalization | `POST /v2/builds/finalize` with `parallelNonce` |

The Playwright reporter and Storybook Vitest plugin do not add API routes. Each prepares its
own screenshots and metadata, then calls the same core `upload()` function used by the CLI.

The Playwright reporter adds test-run status and timing data to the build update. The
Storybook plugin adds Storybook metadata while it captures screenshots, but its final upload
uses the same HTTP flow.

## Authentication and retries

Every API request sends this header:

```text
Authorization: Bearer <40-character token>
```

The core package rejects the token before making a request unless it is exactly 40
characters long.

Each API request also sends:

- `x-argos-request-id`, which stays the same across retries;
- `x-argos-retry-attempt`, which starts at `0` and increases for each retry.

The API client makes one initial request and allows up to three retries for network errors or
HTTP 5xx responses. A retry keeps the same request body and request ID.

Signed uploads behave differently. They use a direct `fetch` call with a 30-second timeout.
If an upload fails, the producer stops before `PUT /v2/builds/{buildId}` and does not retry the
upload itself.

## Signed multipart uploads

The create-build response returns one upload object for each missing screenshot hash. Each
object contains:

- `key`, which must match a requested screenshot hash;
- `postUrl`, the signed upload destination;
- `fields`, an object of form fields supplied by the object store.

The producer copies every returned field into a `multipart/form-data` request. It then adds a
field named `file` with the screenshot bytes and content type.

Argos optimizes each screenshot before upload and gives the optimized file a generated
temporary filename. That filename is not stable. Glint and its object-store policy must rely
on the signed `key`, not the multipart filename.

Repeated hashes appear only once in the create-build request. The build-update request still
lists every named screenshot, including screenshots that share the same hash.

An empty upload is valid. It sends both create and update requests with empty screenshot
arrays and sends no multipart upload.

## Screenshot batching

The core package processes screenshots and signed uploads in groups of ten to limit memory
use and concurrency. The twelve-screenshot recording crosses this boundary.

This batching does not change the API shape:

- there is one `POST /v2/builds` request containing all twelve unique hashes;
- there are twelve signed multipart uploads;
- there is one `PUT /v2/builds/{buildId}` request containing all twelve screenshot records.

Glint therefore does not need a metadata-chunk endpoint for these pinned versions.

## Response fields used by the producers

The `cli-minimal-response-fields.json` recording uses smaller response bodies than the
published Argos objects and still completes successfully.

| Response | Required for success | Not required by this upload path |
| --- | --- | --- |
| `GET /v2/project` | `hasRemoteContentAccess: true` is enough to skip local merge-base discovery | `id`, `account`, `name`, `defaultBaseBranch` |
| `POST /v2/builds` | `build.id` and `screenshots`; `pwTraces` may be absent | Create-time `build.url` and other build fields |
| Screenshot upload item | `key`, `postUrl`, and `fields`; `key` must match a requested hash | Deprecated `putUrl` does not work with this core path |
| `PUT /v2/builds/{buildId}` | `build` | Only `build.url` is read for display; if it is absent, the CLI prints `undefined` but does not fail |
| Skipped create response | `build` | Only `build.url` is read for display |
| Finalize response | `builds` array | Each `build.url` is read for display |

If `hasRemoteContentAccess` is false or missing, the producer uses `defaultBaseBranch` during
local merge-base discovery unless the caller supplies a reference commit. Glint should return
both fields for endpoint-and-token-only migration rather than depend on caller configuration.

## Dependencies that affect compatibility

- `@argos-ci/core@6.1.1` owns the shared upload flow. It must be pinned and tested along with
  the three top-level producer packages.
- `@argos-ci/api-client@0.22.0` owns API retries and the Argos request headers.
- `sharp@0.34.5` optimizes screenshots and runs a native install step. Clean installs require
  `sharp` in pnpm's build-script allowlist.
- Automatic Playwright screenshot metadata needs one of `@playwright/test`, `playwright`, or
  `playwright-core` to be available. Explicit Argos attachments skip that lookup.
- Storybook capture needs the `@storybook/addon-vitest` browser context. The final upload does
  not add Storybook-specific routes.

These findings change two assumptions in the proposed E0/E3 compatibility surface:

1. Remove `POST /v2/baseline` from the subset required by these pinned producers.
2. Define a skipped build as a `POST /v2/builds` body variant, not a separate route.

## Remaining provider check

Glint does not yet have a selected staging object-store provider. These recordings prove the
producer-side multipart behavior against the local recorder. After the provider is selected,
replay the signed-upload scenarios against it before closing the E0 compatibility gate.

The provider must accept browser-style multipart POST policy fields. The producer treats field
values as opaque strings and sends them back unchanged.

## Recording index

| Recording | What it proves |
| --- | --- |
| `cli-no-baseline.json` | A screenshot upload when the recorder labels the build as having no baseline |
| `cli-unchanged.json` | No signed upload is made when the server reports that the hash already exists |
| `cli-changed.json` | Multiple missing screenshots are uploaded |
| `cli-zero-screenshot.json` | An empty build still sends create and update requests |
| `cli-skipped.json` | The exact skip route and request body |
| `cli-chunked-metadata.json` | Twelve screenshots cross the internal batch size of ten without changing the API shape |
| `cli-parallel-manual-finalize.json` | Two shard updates followed by manual finalization |
| `cli-api-retry.json` | An HTTP 500 response is retried with the same request ID |
| `cli-upload-failure.json` | A failed multipart upload prevents the build update |
| `cli-invalid-token.json` | A token that is not 40 characters long is rejected before any request |
| `cli-minimal-response-fields.json` | Minimal response bodies are enough to complete an upload |
| `playwright-reporter.json` | The Playwright reporter uses the shared upload flow and adds test-run metadata |
| `storybook-vitest-plugin.json` | The Storybook Vitest reporter uses the shared upload flow |
