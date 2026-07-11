# Pinned Argos producer protocol recorder

This tool records how Shipfox's pinned Argos producers call the Argos API. It runs each
producer against a local server. It saves each HTTP exchange as JSON.

The recorder is only for E0 research. Glint apps and domain packages must not import it. Do
not use it as the production API.

## Quick start

From a clean checkout:

```sh
mise install
mise run bootstrap
mise exec -- pnpm --filter @glint/argos-protocol-recorder record
mise exec -- pnpm --filter @glint/argos-protocol-recorder test
git diff --exit-code -- tools/argos-protocol-recorder/recordings
```

The last command should print nothing. A diff means the output changed between runs. Review
that change before you commit it.

The recorder builds the full set in a temporary sibling folder. It replaces the checked-in
recordings only after every scenario succeeds, so a failed run keeps the last complete set.

## What it records

The tool runs these exact producer versions:

- `@argos-ci/cli@5.0.5`
- `@argos-ci/playwright@7.0.6`
- `@argos-ci/storybook@6.0.7`

All three use `@argos-ci/core@6.1.1` for uploads. The core package uses
`@argos-ci/api-client@0.22.0` for API calls.

The recordings cover:

- normal uploads;
- no baseline;
- unchanged and changed builds;
- empty and skipped builds;
- more than ten screenshots;
- parallel shards and manual finalization;
- API retries and upload failures;
- invalid tokens and small response bodies.

The tool also runs the real Playwright reporter and Storybook Vitest upload reporter.

Read [findings.md](findings.md) for the protocol conclusions and required response fields.

## Safety

The recorder listens only on a random local port. It never calls Argos, GitHub, an object
store, or any other service. It creates small one-pixel PNG files in a temporary folder. It
removes them after each scenario.

Recordings are sanitized while the request is captured:

- bearer tokens are replaced with a placeholder;
- local origins and signed upload URLs are removed;
- multipart boundaries and signed field values are removed;
- image files are stored only as a media type, byte count, and SHA-256 digest.

A recording must not contain a token or signed URL. It must not contain a full local path or
image bytes. The test suite checks these rules.
