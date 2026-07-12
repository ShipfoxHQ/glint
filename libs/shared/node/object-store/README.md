# Object-store port

`@glint/node-object-store` owns immutable blob reads, writes, metadata, deletion, constrained signed
multipart uploads, signed reads, and readiness. The `BlobStore` contract intentionally has no
listing operation and does not expose bucket, credential, AWS, R2, or MinIO types.

The package includes two runtime adapters:

- `FilesystemBlobStore` stores immutable local envelopes under a private directory. It signs and
  executes multipart upload and read requests through `handleSignedRequest`, so local composition
  roots can mount the returned `/upload` and `/read` addresses without cloud credentials.
- `createS3BlobStore` uses private Amazon S3 or an explicitly configured S3-compatible endpoint.
  Direct puts use `If-None-Match: *`, signed uploads use SigV4 POST policies, and signed reads use
  SigV4 GET addresses. AWS SDK types and clients are not part of the public contract.

`MVP_BLOB_SIGNING_POLICY` records the approved portable limits: PNG content, at most 8 MiB, and a
five-minute signed-operation lifetime. Unsafe relative keys, other content types, invalid byte
limits, missing checksums, expired requests, and lifetimes beyond five minutes are rejected
consistently. A checksum-bound S3 form can only write the expected bytes. E2 remains responsible
for coordinating concurrent first writes because S3 POST policies have no conditional-write field,
and a preflight object lookup would conflict with the application role's no-listing policy.
Authorization remains an application concern performed before requesting a signed read.

Adapters should run `blobStoreContractTests` from `@glint/node-object-store/contract-test-kit`. The
filesystem and S3 adapters both run that suite. The S3 tests additionally load the sanitized Argos
fixture and verify the opaque POST fields, exact key/type/size policy, and trailing `file` field.
