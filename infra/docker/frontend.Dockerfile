# Frontend image: builds the Next.js app once, then serves the production build.
# Beginner note: "FROM node:20-bookworm" means "start from a Linux box that already
# has Node 20 installed." Using Node 20 (LTS) for reliability.
FROM node:20-bookworm

WORKDIR /app/frontend

# Build-time args (public env vars baked into the Next.js build).
# These are visible in the browser bundle — never put secrets here.
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
ARG NEXT_PUBLIC_WS_BASE_URL=ws://localhost:8000
ARG NEXT_PUBLIC_CESIUM_ION_TOKEN

ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_WS_BASE_URL=${NEXT_PUBLIC_WS_BASE_URL}
ENV NEXT_PUBLIC_CESIUM_ION_TOKEN=${NEXT_PUBLIC_CESIUM_ION_TOKEN}
ENV NEXT_TELEMETRY_DISABLED=1

# Install deps first (copied alone so Docker can cache this layer).
COPY frontend/package.json frontend/pnpm-lock.yaml* ./
RUN corepack enable && corepack prepare pnpm@latest --activate \
 && pnpm install --no-frozen-lockfile

# Copy the rest of the source and build.
COPY frontend/ ./
RUN pnpm build

EXPOSE 3000

CMD ["pnpm", "start", "--hostname", "0.0.0.0", "--port", "3000"]
