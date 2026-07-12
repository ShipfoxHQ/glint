#!/bin/sh

set -eu

parallelism="${GLINT_BENCH_PARALLELISM:-11}"
image="${GLINT_BENCH_IMAGE:-glint-odiff-benchmark:4.3.8}"

seq 0 142 | xargs -P "$parallelism" -n 1 sh -c '
  image="$1"
  task_index="$2"
  docker run --rm \
    --platform linux/amd64 \
    --cpus 1 \
    --memory 512m \
    --pids-limit 64 \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --env GLINT_BENCH_MODE=task \
    --env GLINT_BENCH_TASK_INDEX="$task_index" \
    --env GLINT_BENCH_PROFILE=oci-control-burst \
    "$image"
' glint-odiff-task "$image"
