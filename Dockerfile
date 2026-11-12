# rushdb-agent: syncs databases on your network into RushDB, outbound HTTPS only.
#   docker build -t rushdb-agent .
#   docker run --read-only --cap-drop ALL -e RUSHDB_AGENT_TOKEN=… -e PG_URL=… \
#     -v $PWD/rushdb-agent.yaml:/etc/rushdb-agent.yaml:ro rushdb-agent run
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine
ENV NODE_ENV=production RUSHDB_AGENT_CONFIG=/etc/rushdb-agent.yaml
WORKDIR /app
# Every database driver the agent supports; pinned majors, no install scripts at runtime.
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts \
      yaml@2 zod@3 pg@8 mysql2@3 mongodb@6 @clickhouse/client@1 \
 && npm cache clean --force
COPY --from=build /src/dist ./dist
COPY LICENSE ./
USER node
ENTRYPOINT ["node", "/app/dist/rushdb-agent.cjs"]
CMD ["run"]
