ARG BENCHMARK_PLATFORM=linux/amd64
FROM --platform=${BENCHMARK_PLATFORM} node:24.17.0-bookworm-slim

ARG ODIFF_VERSION=4.3.8

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates time \
  && npm install --global "odiff-bin@${ODIFF_VERSION}" \
  && odiff --version \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /benchmark

COPY --chown=node:node benchmarks/corpus/v1 /benchmark/corpus
COPY --chown=node:node benchmarks/odiff-runtime/process-control.mjs /benchmark/process-control.mjs
COPY --chown=node:node benchmarks/odiff-runtime/run.mjs /benchmark/run.mjs
COPY --chown=node:node benchmarks/odiff-runtime/server.mjs /benchmark/server.mjs

ENV GLINT_BENCH_CORPUS=/benchmark/corpus \
  GLINT_BENCH_OUTPUT_DIR=/tmp/glint-odiff-benchmark \
  GLINT_BENCH_PROFILE=oci-control \
  GLINT_BENCH_TIMEOUT_MS=5000

USER node

ENTRYPOINT ["node"]
CMD ["/benchmark/run.mjs"]
