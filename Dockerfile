FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    AI_MEMORY_DIR=/memory \
    LOG_CONTENT=false

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    addgroup -S -g 10001 mcp && \
    adduser -S -D -H -u 10001 -G mcp mcp && \
    mkdir -p /memory && \
    chown -R mcp:mcp /app /memory

COPY --from=build --chown=mcp:mcp /app/dist ./dist

USER 10001:10001
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '8787') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
