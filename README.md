# Sphere

A search-first global intelligence platform. Photorealistic globe, live signals,
calibrated retrieval, causal reasoning, portfolio impact.

- `frontend/` — Next.js app
- `backend/` — FastAPI app
- `infra/docker/` — Dockerfiles for both services
- `docker-compose.yml` — full local stack (frontend + backend + Postgres + Redis)

## Local development

Requires Docker Desktop.

```bash
cp .env.example .env
docker compose up --build
```

Open:

- Frontend: <http://localhost:3000>
- Backend: <http://localhost:8000/health>
- Integrations status: <http://localhost:8000/api/integrations/status>

The stack runs end-to-end with **no provider keys**. Adapters fall back to
keyless public feeds (Open-Meteo, GDELT, Frankfurter, USGS) or deterministic
synthetic data, and the frontend surfaces a "Demo data" chip on affected
panels.

### Useful commands

```bash
docker compose up -d --build backend       # rebuild backend only
docker compose up -d --build frontend      # rebuild frontend only
docker compose logs backend --tail=200     # tail backend logs
docker compose exec redis redis-cli ping   # check Redis
docker compose exec postgres psql -U sphere -d sphere -c "\dt"
docker compose down                         # stop the stack
```

## Health and integrations endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness — returns `{"status": "ok"}` plus Redis/Postgres state. Used by Railway/Docker healthchecks. |
| `GET /api/intelligence/health` | Adapter freshness, ingest cycles, persistence backends. |
| `GET /api/integrations/status` | Per-domain configured/missing flags for every external provider. Never returns secrets. |

The frontend treats empty payloads as "Live data unavailable" and renders
"Demo data" chips rather than crashing.

## Railway deployment

Sphere is designed to deploy on [Railway](https://railway.app) as four
independent services. Both the frontend and backend ship with root-level
Railway config files so the platform builds them deterministically from the
correct Dockerfiles.

### 1. Provision plugins

In your Railway project:

1. Create a **PostgreSQL** plugin/service.
2. Create a **Redis** plugin/service.

Railway will expose connection variables like `DATABASE_URL` and `REDIS_URL`
on those services.

### 2. Backend service

1. Create a service from this repo.
2. In the service's **Settings → Config Path**, point at `railway.backend.json`.
3. Set the following environment variables (reference the plugin variables
   with the `${{Postgres.DATABASE_URL}}` style references where useful):

   | Variable | Value |
   |---|---|
   | `INTELLIGENCE_ENV` | `production` |
   | `INTELLIGENCE_DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `INTELLIGENCE_REDIS_URL` | `${{Redis.REDIS_URL}}` |
   | `SPHERE_POSTGRES_DSN` | `${{Postgres.DATABASE_URL}}` |
   | `SPHERE_REDIS_URL` | `${{Redis.REDIS_URL}}` |
   | `SPHERE_FRONTEND_ORIGINS` | comma-separated list of your frontend public URLs |

   Optional provider keys (Alpha Vantage, Polygon, Anthropic, etc.) can be
   added on top — the backend boots cleanly without them and reports their
   status under `/api/integrations/status`.

4. Railway injects `PORT`. The backend container honors it and listens on
   `0.0.0.0:$PORT`. Healthcheck path is `/health`.

### 3. Frontend service

1. Create a second service from the same repo.
2. Point **Settings → Config Path** at `railway.frontend.json`.
3. Set environment variables:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_API_BASE_URL` | Your backend public URL (e.g. `https://sphere-backend.up.railway.app`) |
   | `NEXT_PUBLIC_WS_BASE_URL` | Same host with `wss://` scheme |
   | `NEXT_PUBLIC_CESIUM_ION_TOKEN` | optional |

   `NEXT_PUBLIC_*` values are baked into the Next.js bundle at build time, so
   set them **before** the first deploy. After changing them, redeploy the
   service.

4. Railway injects `PORT`. The frontend container honors it.

### 4. Verify

After deploy:

```bash
curl https://<backend-host>/health
curl https://<backend-host>/api/integrations/status
```

The integrations status response shows which providers are configured /
missing / disabled. Anything `missing` will fall back to keyless or
synthetic data; the app will not crash.

## Validation checklist

```bash
docker compose config                      # validate compose schema
docker compose up --build -d               # boot the stack
curl http://localhost:8000/health
curl http://localhost:8000/api/integrations/status
open http://localhost:3000
```

## Repo layout

```text
.
├── backend/                      FastAPI + Pydantic + intelligence runtime
├── frontend/                     Next.js + Three.js / R3F globe
├── infra/
│   ├── docker/
│   │   ├── backend.Dockerfile
│   │   ├── frontend.Dockerfile
│   │   └── frontend.dev.Dockerfile
│   └── postgres/init/            initial DB extensions
├── docker-compose.yml            local full stack
├── docker-compose.dev.yml        dev overlay
├── railway.backend.json          Railway backend service config
├── railway.frontend.json         Railway frontend service config
├── .env.example                  template — never commit .env
└── README.md
```
