# syntax=docker/dockerfile:1

# Build outside Docker, ingest dist: shipfox-docker prunes the worker's production
# dependency closure and overlays Turbo-built dist/ files into out/full. The image
# only installs from the pruned lockfile and deploys that closure; it never compiles
# TypeScript.
ARG NODE_VERSION=24.17.0
ARG PNPM_VERSION=11.7.0

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

FROM base AS build
COPY out/json/ ./
COPY out/full/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter=@glint/app-worker deploy --prod --legacy \
      --store-dir=/pnpm/store --config.strict-peer-dependencies=false /prod

FROM base AS runtime
ENV NODE_ENV=production
# apps/worker/src/odiff.ts executes `odiff` by its bare command name.
ENV PATH=/prod/node_modules/.bin:$PATH

RUN groupadd --system glint && useradd --system --gid glint --no-create-home glint
COPY --from=build /prod ./
USER glint

ARG IMAGE_SOURCE="https://github.com/ShipfoxHQ/glint"
ARG IMAGE_REVISION
ARG IMAGE_CREATED
LABEL org.opencontainers.image.title="@glint/app-worker" \
      org.opencontainers.image.description="Glint worker" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source=$IMAGE_SOURCE \
      org.opencontainers.image.revision=$IMAGE_REVISION \
      org.opencontainers.image.created=$IMAGE_CREATED

CMD ["node", "--enable-source-maps", "./dist/main.js"]
