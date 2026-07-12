# Object-store port

`@glint/node-object-store` owns immutable blob reads, writes, metadata, deletion, constrained signed
multipart uploads, signed reads, and readiness. The API intentionally has no listing operation and
does not expose bucket, credential, AWS, R2, or MinIO types.

`MVP_BLOB_SIGNING_POLICY` records the approved portable limits: PNG content, at most 8 MiB, and a
five-minute signed-operation lifetime. Authorization remains an application concern performed
before requesting a signed read.

Adapters should run `blobStoreContractTests` from `@glint/node-object-store/contract-test-kit`. The
suite includes the multipart POST and `file` field behavior required by the recorded Argos producer
fixture.
