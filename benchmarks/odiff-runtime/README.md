# Benchmarking ODiff worker performance

This folder contains a repeatable way to test ODiff `4.3.8` inside the same
kind of container we could run in production.

The benchmark answers a few practical questions:

- Does the native ODiff binary start and run on Linux?
- How long do representative comparisons take?
- How much memory and temporary disk space do they need?
- Can malformed images fail without taking down the surrounding service?
- Can the worker absorb the busiest burst seen in the production workload?

The benchmark deliberately does not judge whether every generated diff mask is
visually correct. That requires a larger image-quality review with approved
expected images.

## Build the image

The container candidates use Linux AMD64 images. Build that architecture
explicitly when working on an Apple Silicon Mac:

```sh
docker build \
  --platform linux/amd64 \
  --file benchmarks/odiff-runtime/Dockerfile \
  --tag glint-odiff-benchmark:4.3.8 \
  .
```

The build installs the exact ODiff release and stops immediately if
`odiff --version` does not work.

## Run the full test locally

This command gives the container the same CPU, memory, timeout, and temporary
disk limits proposed for Cloud Run:

```sh
/usr/bin/time -p docker run --rm \
  --platform linux/amd64 \
  --cpus 1 \
  --memory 512m \
  --pids-limit 64 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --env GLINT_BENCH_PROFILE=oci-control-1cpu-512mib \
  --env GLINT_BENCH_ITERATIONS=5 \
  glint-odiff-benchmark:4.3.8 \
  > benchmarks/odiff-runtime/results/oci-control-suite.jsonl
```

The JSONL file contains one JSON object per measurement. It records duration,
peak memory, disk use, exit status, and whether the process behaved safely.
Malformed-image tests pass only when ODiff reports an error and the harness
continues running the remaining cases.

## Reproduce the busiest burst

The largest modeled burst contains 143 operations: 126 file checks and 17
pixel comparisons. The local test runs at most 11 containers simultaneously,
matching the observed peak number of builds being processed:

```sh
/usr/bin/time -p sh benchmarks/odiff-runtime/run-control-burst.sh \
  > benchmarks/odiff-runtime/results/oci-control-burst.jsonl
```

This proves the containerized worker can handle the workload on a constrained
machine. It does not prove how quickly a hosting platform will start 143
instances; each hosted option needs its own burst test.

## Run the same test on Cloud Run

Use a dedicated, billing-enabled Google Cloud project. Push the benchmark image
to Artifact Registry first, then refer to it by digest rather than by `latest`.

```sh
export GLINT_BENCH_PROJECT=your-benchmark-project
export GLINT_BENCH_REGION=europe-west1
export GLINT_BENCH_REPOSITORY=benchmarks
export GLINT_BENCH_IMAGE="$GLINT_BENCH_REGION-docker.pkg.dev/$GLINT_BENCH_PROJECT/$GLINT_BENCH_REPOSITORY/glint-odiff@sha256:..."

gcloud run deploy glint-odiff-benchmark \
  --project "$GLINT_BENCH_PROJECT" \
  --region "$GLINT_BENCH_REGION" \
  --image "$GLINT_BENCH_IMAGE" \
  --command node \
  --args /benchmark/server.mjs \
  --cpu 1 \
  --memory 512Mi \
  --concurrency 1 \
  --min 0 \
  --max 143 \
  --timeout 10s \
  --no-cpu-boost \
  --no-allow-unauthenticated \
  --add-volume mount-path=/tmp,type=in-memory,size-limit=64Mi \
  --env-vars-file benchmarks/odiff-runtime/cloud-run.env.yaml \
  --set-env-vars GLINT_BENCH_ITERATIONS=5

export GLINT_BENCH_URL="$(gcloud run services describe glint-odiff-benchmark \
  --project "$GLINT_BENCH_PROJECT" \
  --region "$GLINT_BENCH_REGION" \
  --format 'value(status.url)')"
export GLINT_BENCH_ID_TOKEN="$(gcloud auth print-identity-token)"

node benchmarks/odiff-runtime/cloud-service-client.mjs \
  > benchmarks/odiff-runtime/results/cloud-run-suite.jsonl

GLINT_BENCH_CLIENT_MODE=burst \
  node benchmarks/odiff-runtime/cloud-service-client.mjs \
  > benchmarks/odiff-runtime/results/cloud-run-burst.jsonl
```

Deploying a fresh revision immediately before the first request provides a
useful cold-start measurement. The burst client then sends all 143 requests at
once.

Keep the following with the results so somebody else can reproduce them later:

- project and region;
- image digest and Cloud Run revision;
- CPU, memory, concurrency, instance, timeout, and disk settings;
- service logs and request timestamps;
- the actual number of instances Cloud Run started;
- billable CPU and memory time.

Cloud Run quotas vary by region, so compare the requested 143 instances with
the number that actually ran concurrently.

## Test the other hosted options

The same corpus should also run on Cloudflare Containers, Koyeb, and AWS
Lambda. Keep their results in separate JSONL files so the timings and billing
remain attributable to one platform and configuration.

### Cloudflare Containers

The benchmark image already meets the Linux AMD64 requirement. A Cloudflare
Worker still needs to bind the container, route `/suite` and `/task/:index` to
it, and choose the pool of container IDs used for the 143-request burst.

Start with the `basic` container size, a maximum of 143 instances, and a short
`sleepAfter` value. Record how many containers actually start, how long the
first request waits, and how much memory and disk remain provisioned while the
containers are awake. Use R2 for the storage pairing so object reads and writes
stay on Cloudflare's network.

### Koyeb

Koyeb can run the existing image with `/benchmark/server.mjs` as its command.
Start with both of these instance sizes:

- `micro`: half a CPU and 512 MB;
- `small`: one CPU and 1 GB.

Enable HTTP health checks, set the minimum scale to zero, and set the maximum to
143. Run the suite after deep sleep and again while warm. For the burst, record
whether Koyeb starts enough instances immediately or queues work behind the
first instance. Pair the service with Tigris or R2 to avoid storage-side egress.

### AWS Lambda

Lambda needs a small platform-specific image variant. Add the AWS Runtime
Interface Client and a handler that runs one file check or ODiff child process
per invocation. Keep the corpus, ODiff version, limits, and result format
unchanged.

Benchmark at 512 MB and 1 GB with 512 MB of temporary storage. Invoke all 143
tasks concurrently and record cold starts, throttling, memory, and billed
duration. Test Lambda with S3 in the same region so the result includes the
transfer advantage of that pairing.
