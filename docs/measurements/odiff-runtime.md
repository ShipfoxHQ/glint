# ODiff worker performance, hosting, and storage

The local container benchmark passed. It proves that ODiff can run safely in a
small isolated container, but it does not yet choose a hosting provider.

Cloud Run, Cloudflare Containers, Koyeb, and AWS Lambda are all credible hosted
options. They need the same image corpus and burst test before we choose one.

Prices in this document were checked on July 11, 2026. They are planning
estimates, not quotes.

## What the local benchmark proved

ODiff runs comfortably when a container processes one comparison at a time.

- All representative, large, long, dimension-changing, noisy, and malformed
  inputs completed without a timeout or container crash.
- The largest image was 4,096 × 4,096 pixels. Comparing it used about 194 MiB
  of memory and took 421 ms in the slowest local run.
- A 1,200 × 4,000 long screenshot used about 57 MiB and took 178 ms in the
  slowest run.
- Malformed files stopped only the ODiff child process. The surrounding HTTP
  service stayed healthy.
- All 143 operations in the modeled peak burst completed successfully.

These are conservative local timings because an Apple Silicon Mac emulated the
Linux AMD64 image. Hosted tests still need to measure cold starts, real CPU
performance, burst capacity, and billing.

## Runtime options worth testing

| Runtime | Can run native ODiff? | Scale-to-zero behavior | Main advantage | Main concern |
| --- | --- | --- | --- | --- |
| Cloudflare Workers | No, not for this corpus | Instant isolate startup | Very low request overhead and direct R2 access | Workers have a 128 MB memory limit, below the measured 194 MiB peak, and cannot run the ODiff child process directly. |
| Cloudflare Containers | Yes | Sleeps after a configurable idle period | Runs the existing AMD64 image near Workers, Queues, and R2 | Stateless autoscaling and routing are still manual: the Worker chooses from a configured set of container IDs. |
| Koyeb Service | Yes | Public-preview scale-to-zero after five idle minutes | Runs the existing container with simple per-second pricing | Deep wake-up takes 1–5 seconds, and the workload may be frequent enough that the service rarely becomes idle. |
| AWS Lambda | Yes, with a Lambda runtime adapter | Per-invocation serverless scaling | Native SQS/S3 integration and free same-region S3 transfer | The image needs an AWS Runtime Interface Client, and CPU is tied to the configured memory size. |
| Cloud Run Service | Yes | Request-driven, zero minimum instances | Runs the existing HTTP container with concurrency set to one | Internet-bound output is billed when storage lives outside Google Cloud, and regional burst quota must be checked. |

### Cloudflare Workers and Containers are different options

A normal Worker runs in a V8 isolate. Its 128 MB limit includes JavaScript and
WebAssembly memory, while the largest ODiff case used about 194 MiB before any
application overhead. Porting ODiff to WebAssembly would therefore not make the
current corpus fit. Normal Workers should handle routing or queue messages, not
decode these images.

[Cloudflare Containers](https://developers.cloudflare.com/containers/) run
Linux AMD64 images and are available on the $5 Workers Paid plan. The `basic`
size provides 1 GiB of memory and one quarter of a CPU, which should fit the
corpus but needs a real speed test. Containers bill in 10 ms increments and can
sleep when idle.

The important caveat is routing. Cloudflare currently asks the Worker to choose
explicit container IDs or a fixed random pool; built-in stateless autoscaling is
still planned. We would need to prove a 143-container pool, cold-start behavior,
and queue routing ourselves.

Sources:

- [Workers memory and CPU limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Container sizes and account limits](https://developers.cloudflare.com/containers/platform-details/limits/)
- [Container scaling and routing](https://developers.cloudflare.com/containers/platform-details/scaling-and-routing/)
- [Container pricing](https://developers.cloudflare.com/containers/pricing/)

### Koyeb is simpler, but may stay awake

Koyeb can deploy the existing container directly. A `micro` instance has half a
CPU and 512 MB for $0.0072 per hour; a `small` instance has one CPU and 1 GB for
$0.0144 per hour. Both bill per second.

Scale-to-zero is currently in public preview. Deep sleep wakes in roughly 1–5
seconds; an optional light-sleep mode targets about 200 ms but is also in
preview. Standard services wait five idle minutes before sleeping. At roughly
55,000–170,000 monthly worker operations, requests may arrive often enough that
the service behaves more like a small always-on instance. That would still be
only about $5.36–$10.71 per month, but it is different from true per-request
economics.

Koyeb currently includes 100 GB of outbound bandwidth per month. Its published
future price beyond that allowance is $0.04 per GB. The conservative worker
model moves less than 5 GB per month, so bandwidth would remain inside the
allowance.

Sources:

- [Koyeb scale-to-zero behavior](https://www.koyeb.com/docs/run-and-scale/scale-to-zero)
- [Koyeb instance sizes and prices](https://www.koyeb.com/docs/reference/instances)
- [Koyeb bandwidth pricing](https://www.koyeb.com/docs/faqs/pricing)

### AWS Lambda deserves a full benchmark

Lambda is a particularly strong option when images live in S3. It supports
Linux container images, up to 10 GB of memory, 512 MB–10 GB of encrypted
temporary storage, 15-minute invocations, and 1,000 concurrent executions by
default. A burst of 143 comparisons fits comfortably inside the default
concurrency quota.

The existing Debian image cannot be deployed unchanged: it needs AWS's Runtime
Interface Client and a Lambda handler. The ODiff binary and corpus can remain
the same. We should benchmark at least 512 MB and 1 GB because Lambda allocates
CPU in proportion to memory.

At 1 GB and a deliberately pessimistic one second per operation, the expected
and conservative workloads use 55,000 and 170,000 GB-seconds. Both fit within
Lambda's published monthly free tier of 400,000 GB-seconds and one million
requests if that allowance is otherwise unused. Above the free tier, the same
work would cost roughly $0.92 or $2.83 for compute.

Keeping Lambda and S3 in the same AWS region avoids data-transfer charges
between the worker and object store. S3 can also trigger Lambda or send work
through SQS without a public HTTP service.

Sources:

- [Lambda container image requirements](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)
- [Lambda limits and concurrency](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
- [Lambda temporary storage](https://docs.aws.amazon.com/lambda/latest/dg/configuration-ephemeral-storage.html)
- [Lambda pricing](https://aws.amazon.com/lambda/pricing/)

### Cloud Run remains viable, not preselected

Cloud Run runs the current HTTP container with one request per instance. Its
request-billed service can scale to zero without a one-minute minimum, and a
size-limited in-memory `/tmp` protects the 512 MiB instance from runaway output.

An intentionally pessimistic one second of compute per operation costs about
$1.39 for the expected workload or $4.29 for the conservative workload before
the shared free tier. The drawback of pairing Cloud Run with Tigris or R2 is
that uploads from Cloud Run to the external object store count as Google Cloud
internet egress. Inputs downloaded into Cloud Run are inbound and do not incur
Google egress charges.

Cloud Run Jobs are not suitable for one comparison per task because each task
has a one-minute minimum billable lifetime.

Sources:

- [Cloud Run container requirements](https://docs.cloud.google.com/run/docs/container-contract)
- [Cloud Run memory limits](https://docs.cloud.google.com/run/docs/configuring/services/memory-limits)
- [Cloud Run pricing and network transfer](https://cloud.google.com/run/pricing)

## Storage and data transfer change the comparison

The earlier compute-only estimate was incomplete. A worker reads base and
candidate images and writes a diff mask, so the location and egress policy of
the object store matter.

At one million screenshots per month, the workload model produces:

| Traffic | Expected case | Conservative case |
| --- | ---: | ---: |
| New source images uploaded directly from CI | 2.04 GB | 12.18 GB |
| Images downloaded by diff workers | 0.41 GB | 3.25 GB |
| Diff masks uploaded by workers | 0.20 GB | 1.62 GB |
| Live source and mask storage | 2.77 GB | 17.02 GB |
| Object writes | 55,000 | 170,000 |
| Object reads and checks | 60,000 | 190,000 |

Byte estimates assume a generated mask is as large as its source image. That is
deliberately conservative; the measured masks were much smaller.

The worker therefore moves only about 0.61–4.87 GB per month. Storage-side
egress is more important than raw volume because it determines whether a
cross-cloud pairing has a hidden tax. Reviewer and dashboard image delivery is
not included because we do not yet know how often people open stored images;
that usage should be measured separately.

### Storage cost at the modeled workload

The estimates below use standard storage, the live-storage figures above, and
the provider's current free tier. They exclude notifications, queues, CDN
delivery, and taxes.

| Object store | Expected case | Conservative case | Data transfer out |
| --- | ---: | ---: | --- |
| Cloudflare R2 | About $0 | About $0.12 | Free |
| Tigris | About $0.23 | About $1.09 | Free |
| AWS S3 | About $0.36 | About $1.32 | Free to AWS compute in the same region; normal internet transfer pricing otherwise |

R2 is cheapest at this volume because its monthly free tier includes 10 GB of
storage, one million writes, and ten million reads. Tigris includes 5 GB,
10,000 writes, and 100,000 reads, then charges $0.02 per GB-month, $0.005 per
1,000 writes, and $0.0005 per 1,000 reads. Tigris does not charge for regional,
cross-region, or internet egress.

Sources:

- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Tigris pricing](https://www.tigrisdata.com/pricing/)
- [AWS S3 pricing](https://aws.amazon.com/s3/pricing/)

### Promising runtime and storage pairings

- **Cloudflare Containers + R2:** lowest modeled storage cost and no
  storage-side egress. The main unknown is container routing and burst scaling.
- **AWS Lambda + S3:** strongest managed integration and no same-region transfer
  charge. The main work is the Lambda adapter and provider coupling.
- **Koyeb + Tigris or R2:** simple portable container plus free storage egress.
  Koyeb's five-minute idle period may make compute closer to a small fixed
  monthly cost.
- **Cloud Run + Tigris or R2:** portable container and cheap request compute.
  Only the mask upload leaves Google Cloud, but that runtime-side egress must be
  included.

Tigris is therefore a sensible storage option, particularly if we choose a
runtime outside the storage provider's cloud. R2 is also worth considering: it
has free egress and a larger free operations tier at this workload.

## Shared worker configuration to test

Every hosted runtime should start with the same safety policy:

| Input or resource | Starting limit | Why |
| --- | ---: | --- |
| Encoded file size | 8 MiB per image | More than 50 times the largest observed production image; reject larger files before decoding. |
| Decoded image size | 16,777,216 pixels | The tested 4,096² image used about 194 MiB. |
| Width or height | 4,096 pixels | Covers both the tested square image and the 4,000-pixel-long page. |
| Different dimensions | Return a layout change | ODiff identifies this without generating a mask. |
| ODiff execution | 5 seconds | More than 12 times the slowest local comparison. |
| Whole request | 10 seconds | Leaves time to turn a killed child into a clear error response. |
| Container memory | At least 512 MiB | Leaves room after the largest measured comparison. |
| Temporary disk | At least 64 MiB, size-limited where possible | Far above the 86 KiB maximum output. |
| Simultaneous comparisons per instance | 1 | Two worst-case decodes could come too close to a 512 MiB memory limit. |
| Total burst capacity | 143 comparisons | Matches the largest modeled burst. |

Check encoded size, decoded pixels, width, and height before starting ODiff.
Images with equal hashes should skip comparison entirely. A timeout, signal,
decode error, or full temporary volume should return a bounded comparison error.

## Local image results

Each image case ran five times. “Median” is the middle result; “slowest” is the
slowest of those five runs.

| Image case | Median | Slowest | Peak memory | Result |
| --- | ---: | ---: | ---: | --- |
| Small visual change | 60 ms | 76 ms | 14.4 MiB | Change detected |
| Large visual change | 46 ms | 75 ms | 14.5 MiB | Change detected |
| Long page with a change near the bottom | 119 ms | 178 ms | 57.1 MiB | Change detected |
| Transparent images | 24 ms | 47 ms | 7.2 MiB | ODiff missed the visible change |
| Different image dimensions | 59 ms | 67 ms | 10.2 MiB | Layout change detected |
| Noisy images | 41 ms | 67 ms | 14.6 MiB | Change detected |
| 4,096 × 4,096 highly compressed image | 386 ms | 421 ms | 193.9 MiB | Completed safely |
| Truncated PNG | 28 ms | 42 ms | 5.8 MiB | Rejected without crashing |
| Non-image bytes | 28 ms | 34 ms | 5.7 MiB | Rejected without crashing |

The full local run took 5.04 seconds, of which 4.26 seconds were spent inside
the container. The largest generated temporary output was only 86 KiB.

## Local burst results

The modeled busiest burst contains 126 checksum and availability checks plus 17
pixel comparisons. The local run allowed at most 11 containers at once, matching
the observed peak number of builds being processed.

| Work | Count | Median | 95th percentile | Slowest | Peak memory |
| --- | ---: | ---: | ---: | ---: | ---: |
| File checks | 126 | 0.74 ms | 3.04 ms | 7.42 ms | Not measured separately |
| Pixel comparisons | 17 | 66 ms | 141 ms | 141 ms | 56.9 MiB |

All 143 operations completed in 19.75 seconds. The HTTP isolation test then ran
the entire image suite through a long-lived parent process in 1.28 seconds. The
malformed images failed as expected, the request completed, and the service was
still healthy afterward.

## One image-quality problem remains

ODiff reported the two transparent fixtures as identical even though their
visible content differs. The result was the same on native macOS and Linux
AMD64, so this is not a hosting-platform problem.

The worker behaved safely, but we should not silently accept this comparison as
correct. Before choosing the final image-comparison behavior, we need to decide
whether to normalize transparency, change the fixture, adjust ODiff settings, or
use a different comparison engine.

## What to measure next

Run the same suite on Cloudflare Containers, Koyeb, Lambda, and Cloud Run. For
each platform, keep:

1. the exact image, runtime adapter, region, and resource settings;
2. cold and warm request times;
3. all 143 concurrent request results and actual admitted concurrency;
4. peak memory, temporary disk, and timeout behavior;
5. billable compute and runtime-side network transfer;
6. object-store request, storage, retrieval, and egress charges;
7. service logs proving malformed inputs remain isolated.

The final choice should compare complete pairings such as Lambda with S3 or
Koyeb with Tigris, not compute prices in isolation.

## Raw data and reproduction

The exact local and Cloud Run commands are in
[`benchmarks/odiff-runtime/README.md`](../../benchmarks/odiff-runtime/README.md).
Raw local results are stored beside the harness:

- `results/oci-control-suite.jsonl` contains the repeated image measurements;
- `results/oci-control-cold-start.txt` contains the full container timing;
- `results/oci-control-burst.jsonl` contains all 143 burst operations;
- `results/oci-control-burst-time.txt` contains the burst's wall time;
- `results/oci-service-suite.jsonl` contains the HTTP isolation result;
- `results/oci-service-log.jsonl` shows service startup, the benchmark request, and
  successful health checks before and after it.
