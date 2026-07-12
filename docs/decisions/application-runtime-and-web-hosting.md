# Application runtime and web hosting

- Status: Approved
- Date: 2026-07-12

## Context

Glint needs a JSON and webhook API plus a client-heavy image review dashboard. The team already
operates Vercel applications and Fastify services. The dashboard does not need server rendering,
and the API must scale to zero when there is no traffic.

## Decision

Use Fastify 5 for the API. Production runs a ZIP package on the managed AWS Lambda Node.js 24
x86 runtime behind an Amazon API Gateway HTTP API. `@fastify/aws-lambda` adapts the composed
Fastify application to Lambda, while local development starts the same application with
`app.listen()`.

Use React and Vite for the dashboard. Vercel serves the static client on its own subdomain, and
the client calls the API on a separate API subdomain. Vercel and Lambda deploy independently
against backward-compatible HTTP contracts.

Fastify, Lambda, API Gateway, React, and Vite types stay in application composition or
presentation code. Domain, data-transfer, and database packages remain independent of those
frameworks.

## Why

- Fastify is already part of the team's operating stack and has a maintained Lambda adapter.
- The managed Node.js runtime keeps the API ZIP release small and lets AWS maintain the runtime.
- React and Vite provide the required client-side interaction without an unused server-rendering
  contract.
- Vercel fits the team's existing web release workflow and keeps client and API releases separate.

## Alternatives considered

- **Hono:** a capable Lambda framework, but it would add a second HTTP stack without a product
  benefit.
- **A full-stack React framework:** server rendering and server components add another runtime
  even though the dashboard is an authenticated client application.
- **A container image for the API:** useful for native operating-system dependencies, but the API
  has none. It would add an image build and registry push to every API release.
- **Serving the dashboard from AWS:** viable, but duplicates the team's established Vercel
  operations model.

## Consequences

The API and migration artifacts are ZIP packages. The image comparison worker remains a container
because it includes a native executable. Lambda cannot change a function between ZIP and container
packaging in place, so changing either choice requires replacing the function.

The client must use explicit runtime API configuration. Any future server-rendering requirement is
a new architecture decision rather than a hidden extension of the MVP.

## Evidence

- Fastify documents its Lambda adapter: <https://fastify.dev/docs/v5.0.x/Guides/Serverless/>
- AWS documents ZIP deployment packages and their limits: <https://docs.aws.amazon.com/lambda/latest/dg/configuration-function-zip.html>
- Vite production builds emit static assets: <https://vite.dev/guide/build>
