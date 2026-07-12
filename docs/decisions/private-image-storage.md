# Private image storage

- Status: Approved
- Date: 2026-07-12

## Context

The compatible screenshot producers upload with signed multipart form posts rather than signed
PUT requests. Images are private customer artifacts and must not pass through the API Lambda.

## Decision

Use a private Amazon S3 Standard bucket in Frankfurt for source images and diff artifacts.

- Block public access and enforce bucket-owner object ownership.
- Use Amazon S3-managed server-side encryption.
- Sign five-minute multipart POST policies for one tenant-scoped key, PNG content, and at most
  8 MiB.
- Sign five-minute GET requests after application authorization for reviewer access.
- Do not grant bucket listing to application roles.
- Enable production bucket versioning and retain deleted or non-current versions for seven days.
- Let database-owned retention roots decide when current objects become eligible for deletion.
- Use MinIO locally through the same storage interface.

The recorded producer fixture remains the contract input for the future S3 adapter. That adapter
will own signed-request shape tests. The infrastructure repository will smoke-test IAM, CORS, and
bucket policy in staging; this repository does not test Amazon S3 itself.

## Why

- S3 POST policies express the exact key, media type, byte limit, and expiry required by the
  recorded producer contract.
- S3, Lambda, and SQS share one region, avoiding cross-cloud transfer and another provider boundary.
- Direct signed uploads keep image bytes and memory pressure out of the API.
- Short signed reads preserve private authorization without proxying large responses through
  Lambda.

## Alternatives considered

- **Cloudflare R2:** its S3 compatibility does not support signed HTML-form POST uploads.
- **Tigris:** promising, but S3 is the authoritative implementation for the required signing
  behavior and already shares the worker region.
- **API-proxied uploads and downloads:** consume Lambda payload, memory, and duration for data that
  S3 can transfer directly.
- **Public object addresses:** bypass application authorization and expose private visual assets.

## Consequences

Only the S3 adapter may import AWS SDK types. A future object provider must pass the same signed
upload and read contract tests before replacing S3. Public-project delivery is deliberately outside
the MVP and must not make this bucket public.

## Evidence

- AWS documents POST policy conditions: <https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sigv4-HTTPPOSTConstructPolicy.html>
- R2 documents that presigned multipart form POST is unsupported: <https://developers.cloudflare.com/r2/api/s3/presigned-urls/>
