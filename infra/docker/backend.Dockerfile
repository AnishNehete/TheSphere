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

# Container-level liveness probe. /health is cheap and does not depend
# on intelligence runtime readiness, so the container reports healthy
# as soon as FastAPI is serving.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os, urllib.request, sys; port=os.environ.get('PORT','8000'); sys.exit(0 if urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=4).status == 200 else 1)" || exit 1

# Run Alembic migrations against INTELLIGENCE_DATABASE_URL before serving
# so investigation/alert tables exist on first boot. Migrations are
# idempotent. Honors $PORT so Railway / Heroku-style platforms inject
# their own port.
CMD ["sh", "-c", "uv run alembic upgrade head && uv run uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
