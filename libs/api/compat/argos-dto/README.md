# Argos v2 compatibility contract

This package freezes the smallest Argos wire contract used by Shipfox's pinned producers:

- `@argos-ci/cli@5.0.5`
- `@argos-ci/playwright@7.0.6`
- `@argos-ci/storybook@6.0.7`
- shared upload path: `@argos-ci/core@6.1.1`
- API client: `@argos-ci/api-client@0.22.0`

The contract was extracted from the sanitized protocol recordings in
`tools/argos-protocol-recorder/recordings/v1`. E3 can implement compatibility from this package
without importing or reading recorder code.

## Supported surface

| Operation | Required behavior |
| --- | --- |
| `GET /v2/project` | Return `hasRemoteContentAccess: true`; also return `defaultBaseBranch` for endpoint-and-token-only migration. |
| `POST /v2/builds` | Create a normal, empty, parallel-shard, subset, or skipped build. Skip is `skipped: true`, not another route. |
| `PUT /v2/builds/{buildId}` | Attach named screenshot metadata and parallel shard coordinates. |
| `POST /v2/builds/finalize` | Finalize all shards identified by `parallelNonce`. |
| Signed `multipart/form-data` POST | Echo every response `fields` entry, then append screenshot bytes as `file`. |

The pinned producers do not call `/v2/baseline` and do not use a metadata-chunk route. Screenshot
groups of ten are a client memory/concurrency detail; the HTTP requests still contain the full
arrays.

## Required versus present fields

The Zod schemas and OpenAPI mark fields required by the observed producer requests. Fields that
the producers always send as `null` are still accepted with their exact Argos casing. The normal
create body requires `parallel` and `parallelNonce`; the skipped variant instead requires
`skipped: true`. Producer-owned extension fields such as `parentCommits`, `mergeQueue`,
`mergeQueuePrNumbers`, `subset`, and Playwright `metadata` are deliberately accepted and passed
through by the schemas. Compatibility handlers must ignore unknown fields they do not understand,
not reject the request or let those fields affect server-authoritative policy.

Responses are smaller. Project responses require only `hasRemoteContentAccess: true` on the
recorded upload path. `defaultBaseBranch` is merely present when remote content access is enabled,
but Glint should return it because the producer reads it during local merge-base discovery when
remote access is false or absent. Create responses require `build` and `screenshots`; `pwTraces`
is optional. Signed upload items require `key`, `postUrl`, and opaque string `fields`. Update and
skipped responses require `build`; finalize requires `builds`. `build.url` is only for producer
display and may be omitted, although Glint should return it for a clean migration experience.

All API requests require `Authorization: Bearer <token>`, with exactly 40 non-whitespace token
characters. Error JSON is `{ "error": string, "details"?: [{ "message": string }] }`. API 5xx
responses may be retried up to three times with one stable `x-argos-request-id` and increasing
`x-argos-retry-attempt`. Signed multipart uploads are not retried by these producers.

## Compatibility decision

The recorded subset is small and coherent, so Glint should implement it directly. A producer SDK
fork is not recommended. Reconsider a small fork before adding any broader Argos route or behavior
that is not exercised by these fixtures.

The selected production object-store provider must still pass the signed multipart fixture. A
presigned PUT-only provider is not compatible with the pinned producer path.
