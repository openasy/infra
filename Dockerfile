# syntax=docker/dockerfile:1

FROM node:26.12.1-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev && mkdir -p /out/data

# OpenSSH's own client does the SSH (ADR 0031), so this image is Debian slim with openssh-client rather than
# distroless. Node runs the TypeScript sources directly; only production dependencies are copied.
FROM node:26.12.1-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
  && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn*
WORKDIR /app
COPY --from=build /app/package.json /app/openapi.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/dist/web ./dist/web
COPY --from=build /app/dist/docs ./dist/docs
COPY --from=build --chown=node:node /out/data /data
# Everything that is written goes to /data, and SSH keys for one connection to /tmp, which compose and the chart
# mount as tmpfs, so the root filesystem can be read-only (ADR 0022).
ENV NODE_ENV=production PORT=8080 INFRA_DB=/data/infra.db
VOLUME /data
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/main.ts"]
