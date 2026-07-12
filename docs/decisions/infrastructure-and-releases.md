# Infrastructure and releases

- Status: Approved
- Date: 2026-07-12

## Context

This repository is the open-source application distribution. Production infrastructure and secret
configuration belong in a separate private repository. Releases must be reviewable, reproducible,
and reversible without relying on console changes.

## Decision

Use Terraform with OpenTofu compatibility in a separate infrastructure repository. Keep Lambda
functions outside a customer-managed VPC initially. GitHub Actions reconciles reviewed desired
state; Kubernetes and a separate GitOps controller are unnecessary.

Each versioned GitHub Release publishes three immutable artifacts:

- an attested API ZIP for the managed Node.js runtime;
- an attested migration ZIP for the managed Node.js runtime; and
- an attested image-comparison container at `ghcr.io/shipfoxhq/glint-worker`, identified by its
  registry digest.

The release includes SHA-256 checksums, software bills of materials, build provenance, the source
commit, and the required database compatibility. The application workflow opens a pull request
updating the desired staging release in the infrastructure repository.

The infrastructure pull request runs formatting, validation, policy checks, artifact verification,
and a Terraform plan when infrastructure changes. After review and merge, the staging deployment
workflow:

1. verifies every release attestation and checksum;
2. copies the ZIP files to immutable, versioned objects in the deployment S3 bucket;
3. mirrors the public worker digest into the private Frankfurt ECR repository and records the
   destination digest;
4. updates and invokes the migration artifact through the direct database endpoint;
5. publishes new API and worker Lambda versions;
6. moves stable staging aliases;
7. runs compatibility and smoke checks;
8. promotes the staged Vercel deployment; and
9. records the deployed artifacts and versions in its summary.

Production promotion uses a second reviewed pull request that copies the exact staging source
commit, ZIP checksums, worker digest, and Vercel deployment. It does not rebuild artifacts.

Terraform owns stable resources, permissions, configuration, API Gateway, queues, buckets, alarms,
and aliases. The release reconciler owns function code, immutable versions, and alias targets.
Terraform ignores those release-controlled fields so the two systems do not fight.

API Gateway points to the API alias, and the queue event source points to the worker alias. Vercel
builds each main-branch commit as a staged production deployment without assigning the production
domain. Backward-compatible API changes ship before the exact staged client deployment is promoted.

GitHub Actions authenticates to AWS with short-lived identity federation. The public application
repository holds no long-lived AWS credentials.

## Why

- The open-source repository can publish portable runtime contracts without exposing private
  infrastructure or environment configuration.
- ZIP packages minimize API and migration build work; the worker container preserves native binary
  reproducibility.
- GitHub Releases and GitHub Container Registry provide public, verifiable distribution without
  exposing private deployment storage.
- Reviewed release-manifest changes make Git the authorization and audit boundary for deployments.
- Lambda aliases provide stable integrations and fast code rollback.
- Avoiding a VPC removes NAT Gateway cost and networking complexity while Neon and GitHub are
  already reached over secure public endpoints.

## Alternatives considered

- **Infrastructure code in this repository:** mixes a public distribution with private account and
  environment concerns.
- **Mutable image tags or overwritten ZIP keys:** make deployments non-reproducible and rollbacks
  ambiguous.
- **Building again during production promotion:** can produce different bytes from the staging
  release and invalidates the evidence gathered there.
- **Running migrations through Terraform provisioners:** hides imperative ordering and failure
  handling inside infrastructure state operations.
- **Putting Lambda in a VPC immediately:** adds NAT and subnet operations without a private resource
  to reach or a fixed outbound address requirement.
- **Atomic client and API deployments:** unnecessarily couples two release systems. Compatible API
  evolution is safer.

## Consequences

No production change is made directly in an AWS or Vercel console. Rollback reverts the desired
release manifest, moves aliases to earlier immutable versions, and restores the previous Vercel
deployment. Database migrations are never automatically reversed; they follow an
expand-and-contract sequence.

If fixed outbound addresses or private connectivity become necessary, VPC networking can be added
as a reviewed infrastructure change.

## Evidence

- AWS documents immutable Lambda versions and aliases: <https://docs.aws.amazon.com/lambda/latest/dg/using-aliases.html>
- AWS documents that container tags resolve to digests and do not update functions automatically: <https://docs.aws.amazon.com/lambda/latest/dg/nodejs-image.html>
- GitHub documents artifact provenance attestations: <https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations>
- Vercel documents staged production deployment promotion without rebuilding: <https://vercel.com/docs/deployments/promoting-a-deployment>
