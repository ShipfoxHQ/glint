# Provider compatibility checks

This tool verifies selected providers against recorded Glint contracts without putting provider SDK types into core packages.

## Amazon S3 signed multipart POST

Set an existing private test bucket and run:

```sh
GLINT_S3_BUCKET=glint-provider-test \
GLINT_S3_REGION=eu-central-1 \
mise exec -- pnpm --filter @glint/provider-compatibility verify:s3
```

The active AWS credential chain needs `s3:PutObject`, `s3:GetObject`, and `s3:DeleteObject` only for
`provider-compatibility/*`. The check signs a five-minute POST policy constrained to one key,
`image/png`, and 8 MiB; uploads a generated 1 KiB body with `file` appended after every opaque
field; verifies size and type; downloads the same bytes through a five-minute signed GET; and
deletes the object. It never lists the bucket or prints credentials, signatures, or signed URLs.

To verify MinIO or another S3-compatible endpoint, also set `GLINT_S3_ENDPOINT` and `GLINT_S3_FORCE_PATH_STYLE=true`. Passing locally does not replace the required staging run against Amazon S3.
