ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
ARG DSH_CLIENT_COMMIT_HASH

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates g++ git make musl-tools python3 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.7.0

WORKDIR /app
ENV LEFTHOOK=0 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY . .
RUN pnpm install --frozen-lockfile
RUN test -n "$DSH_CLIENT_COMMIT_HASH" \
    && pnpm run build \
    && pnpm --filter @deepseek-ai/node-addon-system-workspace run build:native
RUN pnpm run test:expected apps/cli/tests/profiles/web/tests/environment-policy-deployment.expected.e2e.ts

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/lib/node_modules/pnpm /usr/local/lib/node_modules/pnpm
RUN ln -s /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm
COPY --from=build /app /app

ENV NODE_ENV=production \
    HOME=/state \
    DSH_HOME=/state/dsh \
    XDG_CACHE_HOME=/state/cache
WORKDIR /workspace
USER node
EXPOSE 3080
ENTRYPOINT ["/bin/sh", "/app/deploy/dgx/entrypoint.sh"]
CMD ["web", "--patch", "/state/dsh/deployment/dgx.patch.yml", "--patch", "/app/deploy/dgx/web.patch.yml", "--no-open"]
