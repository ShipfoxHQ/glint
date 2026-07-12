# Application security

- Status: Approved
- Date: 2026-07-12

## Context

Glint has three authentication surfaces: people using the Vercel dashboard, continuous integration
uploading screenshots, and GitHub delivering signed webhooks. Account and project authorization can
change while a browser is logged in.

## Decision

Authenticate people with GitHub OAuth and opaque, revocable sessions stored in PostgreSQL. Put a
random 256-bit session token in a cookie and store only its cryptographic hash.

- Scope the cookie to the API hostname.
- Set `Secure`, `HttpOnly`, and `SameSite=Lax`.
- Support individual-session and all-device revocation.
- Rotate the token after login and sensitive account changes.
- Apply both absolute and inactivity expiration.
- Resolve current account and project permissions from PostgreSQL on each request.

API Gateway allows credentialed cross-origin requests only from the exact production and staging
client origins. Cookie-authenticated mutations require an approved `Origin`, JSON content type, and
a custom header that forces browser preflight. OAuth callbacks use one-time state tied to the login
attempt. Vercel previews use a designated staging client hostname rather than wildcard production
access.

Continuous integration uses high-entropy project bearer tokens stored as hashes. GitHub webhook
routes require signature verification and delivery identifiers. Neither surface accepts browser
session authentication.

Fastify owns authentication and tenant authorization. API Gateway owns TLS, exact-origin CORS,
access logs, and coarse route throttling; it does not duplicate business authorization in an
authorizer.

Store Neon credentials, GitHub secrets, and private keys in AWS Secrets Manager. Terraform creates
secret names and permissions but never receives secret values. Lambdas fetch secrets during cold
start and cache them only within the execution environment. S3 and SQS use Lambda execution roles,
not stored AWS access keys.

## Why

- Opaque sessions provide immediate logout, membership revocation, and account-role changes.
- Nearly every authenticated route already queries PostgreSQL, so a JWT would not remove a useful
  database dependency.
- JWT revocation or refresh rotation would reintroduce state alongside expiry, replay, and key
  rotation machinery.
- Exact origins, same-site cookies, and preflight-only mutations prevent cross-site form requests
  without a separate CSRF-token lifecycle.
- Secrets Manager handles versioned and multiline secrets such as GitHub App private keys.

## Alternatives considered

- **Long-lived JWT sessions:** authorization claims remain valid after access is removed.
- **Short-lived JWTs with refresh tokens:** appropriate for several independent APIs, but adds
  refresh rotation and replay handling to an application that already needs PostgreSQL.
- **Browser storage for tokens:** exposes bearer credentials to injected JavaScript.
- **Wildcard credentialed CORS:** unsafe and incompatible with the intended origin boundary.
- **Secret values in Terraform:** places credentials in plans and state.

## Consequences

The first authenticated request after database suspension wakes Neon. Public health checks remain
database-free. A future set of independent, database-free APIs may introduce short-lived access
tokens backed by stateful refresh sessions, but that complexity is not part of the MVP.
