# reprocheck as a container image (GHCR).
# The image runs the same bin as the npm package: dist/cli.js.
# Default command is "mcp", so `docker run -i <image>` is a stdio MCP server;
# any other arguments reach the CLI normally. Note the CLI works on local
# git repositories, so mount the repo you want to check at /repo.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache git
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["mcp"]
LABEL org.opencontainers.image.source="https://github.com/CloudCorpRecords/reprocheck" \
      org.opencontainers.image.description="reprocheck: red-first repro verifier. Runs your repro in clean worktrees of the base and the fix; a fix counts only when the repro fails on the base and passes on the fix. One bin serves the CLI and a stdio MCP server." \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/reprocheck"
