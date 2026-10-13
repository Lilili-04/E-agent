ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

WORKDIR /app

# The API only needs the deterministic query implementation and the SQLite
# reader. The database itself is mounted read-only by docker-compose.
COPY src/database.ts src/query.ts src/query-store.ts src/hybrid-store.ts /app/src/
COPY deploy/server.ts /app/deploy/server.ts

ENV NODE_ENV=production
ENV NODE_OPTIONS=--experimental-strip-types
ENV POLICY_API_HOST=0.0.0.0
ENV POLICY_API_PORT=8080
ENV POLICY_DB_PATH=/app/data/policy-national-v1.sqlite

USER node
EXPOSE 8080

CMD ["node", "/app/deploy/server.ts"]
