FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY tsconfig.json ./

# Expose dashboard port
EXPOSE 3456

# Health check via the metrics endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:3456/api/metrics || exit 1

ENTRYPOINT ["bun", "run", "src/index.ts"]
