# Backend image: uses `uv` (a fast Python installer) to pin deps from
# pyproject.toml + uv.lock, then starts FastAPI with uvicorn.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm

WORKDIR /app/backend

# Copy dep manifests first so Docker can cache installs when only code changes.
COPY backend/pyproject.toml backend/uv.lock* ./
RUN uv sync --no-dev --no-install-project

# Now copy the rest of the backend source.
COPY backend/ ./
RUN uv sync --no-dev

EXPOSE 8000

# Phase 17C beta-hardening — container-level liveness probe so docker
# compose / orchestrators can restart the backend if /health stops
# answering. The intelligence/health endpoint already exists and is
# cheap (no DB hit by default).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request, sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/intelligence/health', timeout=4).status == 200 else 1)" || exit 1

# Phase 19E — run Alembic migrations against INTELLIGENCE_DATABASE_URL
# before serving so investigation/alert tables exist on first boot.
# Migrations are idempotent (alembic tracks revision in alembic_version).
CMD ["sh", "-c", "uv run alembic upgrade head && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000"]
