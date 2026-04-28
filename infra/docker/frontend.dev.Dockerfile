# Dev image for the frontend.
# Why a separate Dockerfile: the production frontend.Dockerfile bakes
# `pnpm build` into the image, which means every source change needs a full
# image rebuild. That round-trip kills UI iteration. This image installs
# pnpm + deps but does NOT build — it is intended to be paired with a host
# bind-mount of `frontend/` and run `pnpm dev` so Next.js hot-reloads on
# every file change.
#
# Bring it up via the dev override:
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d frontend
FROM node:20-bookworm

WORKDIR /app/frontend

ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
ARG NEXT_PUBLIC_WS_BASE_URL=ws://localhost:8000
ARG NEXT_PUBLIC_CESIUM_ION_TOKEN

ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_WS_BASE_URL=${NEXT_PUBLIC_WS_BASE_URL}
ENV NEXT_PUBLIC_CESIUM_ION_TOKEN=${NEXT_PUBLIC_CESIUM_ION_TOKEN}
ENV NEXT_TELEMETRY_DISABLED=1
# Watch reliability inside Docker on Windows / WSL2 — without polling the
# bind-mount fs events are flaky and HMR misses changes.
ENV CHOKIDAR_USEPOLLING=true
ENV WATCHPACK_POLLING=true

# Install deps once at image build so the dev container starts fast even
# when the host node_modules volume is empty.
COPY frontend/package.json frontend/pnpm-lock.yaml* ./
RUN corepack enable \
 && corepack prepare pnpm@latest --activate \
 && pnpm install --no-frozen-lockfile

EXPOSE 3000

# Default: pnpm dev with the bind-mounted source. The compose override
# remaps /app/frontend to the host frontend/ directory, so the source the
# server reads is whatever is on disk right now.
CMD ["pnpm", "dev", "--hostname", "0.0.0.0", "--port", "3000"]
