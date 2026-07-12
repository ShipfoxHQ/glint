# Image comparison worker

- Status: Approved
- Date: 2026-07-12

## Context

ODiff 4.3.8 is a native Linux x86 executable. The benchmark measured a 193.9 MiB peak at the
16,777,216-pixel boundary and a burst of 143 operations. The worker must isolate malformed images,
scale to zero, and remain separate from the API process.

## Decision

Run verification and comparison jobs as AWS Lambda container functions in Frankfurt using the AWS
Node.js 24 x86 base image.

- Memory: 1,024 MiB.
- Lambda temporary storage: 512 MiB, with a 64 MiB application working-set ceiling.
- One image verification or comparison per invocation.
- ODiff child deadline: 5 seconds.
- Handler deadline: 10 seconds.
- Lambda timeout: 15 seconds.
- Reserved and event-source concurrency: 32.
- ODiff version: exactly 4.3.8, verified during image build and startup.
- Read-only container filesystem except for `/tmp`.
- PNG only, at most 8 MiB encoded and 16,777,216 decoded pixels.
- Maximum width 4,096 pixels and maximum height 16,384 pixels.
- Maximum generated diff artifact 8 MiB.
- Dimension mismatches return `layout-change`; equal hashes skip ODiff.

Build one Linux x86 image and publish it publicly as
`ghcr.io/shipfoxhq/glint-worker:<version>`. The version tag is for discovery; release manifests and
deployment instructions pin the immutable digest. Publish build provenance and a software bill of
materials with the image.

Lambda cannot pull directly from GitHub Container Registry. The infrastructure workflow verifies
the public image, mirrors it into the operator's private Amazon Elastic Container Registry
repository in Frankfurt, and deploys the destination digest.

## Why

- A container pins the native executable, operating system, libraries, permissions, and local test
  environment together.
- Lambda has no idle worker cost and connects directly to SQS and S3.
- One GiB leaves ample headroom over the measured native peak and provides more CPU than the
  512 MiB candidate.
- The separate worker prevents malformed or unusually large images from entering the API process.
- A public canonical image lets open-source users inspect and verify the supported worker without
  receiving credentials for Shipfox infrastructure.

## Alternatives considered

- **A ZIP worker:** technically possible, but native executable and system-library packaging would
  be less explicit and less reproducible than the measured container.
- **Lambda arm64:** the selected ODiff artifact is Linux x86 and has been benchmarked on that
  architecture.
- **A continuously running container service:** adds idle cost and scaling control for bursty work.
- **An isolate worker runtime:** cannot run the selected native process within its measured memory
  and process requirements.
- **Publishing only to a Shipfox ECR repository:** couples the open-source distribution to one AWS
  account and does not remove the same-region mirror required by independent Lambda installations.

## Consequences

Publishing a new image under an existing tag does not deploy it. The release workflow records the
public and destination digests, publishes an immutable Lambda version, and moves an alias. Runtime
and security patches require rebuilding and republishing the image.

The engine missed one transparent-image classification in the existing quality corpus. That is an
engine-quality issue to resolve before production conclusions, not a runtime-provider failure.
Staging must also measure managed-Lambda cold starts and confirm that the 143-job burst drains in
under 60 seconds.

## Evidence

- Local measurements: [`../measurements/odiff-runtime.md`](../measurements/odiff-runtime.md)
- AWS documents Node.js container images: <https://docs.aws.amazon.com/lambda/latest/dg/nodejs-image.html>
- AWS requires a Lambda image in an ECR repository in the same region as the function: <https://docs.aws.amazon.com/lambda/latest/dg/images-create.html>
- GitHub documents its OCI-compatible container registry: <https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry>
- AWS documents Lambda concurrency: <https://docs.aws.amazon.com/lambda/latest/dg/lambda-concurrency.html>
