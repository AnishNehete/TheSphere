# 🌍 Sphere 

https://thesphere.icu/
> **A search-first global intelligence platform for understanding what is happening in the world, why it matters, and what it could impact next.**

Sphere is a full-stack investigation platform that combines a photorealistic 3D globe, live global signals, market intelligence, calibrated retrieval, causal reasoning, and portfolio-impact analysis.

It is designed around one simple interaction:

```text
Ask a question → resolve the entity → retrieve scoped evidence → explain the cause → show market/portfolio impact → save/share the investigation
```

Example questions:

- **Why is TSLA down?**
- **Compare oil yesterday vs today**
- **Compare Japan vs Korea**
- **What does a Red Sea disruption mean for energy markets?**
- **What changed in Japan in the last 24 hours?**

---

## 📸 Demo Preview

> Add screenshots or GIFs here before publishing.

| View | Placeholder |
|---|---|
| 🌍 Hero Globe | <img width="1919" height="859" alt="image" src="https://github.com/user-attachments/assets/d4e84a63-8abb-488d-8c5d-54cf2547d98f" /> /> |
| 🔎 Search Investigation | <img width="1917" height="859" alt="image" src="https://github.com/user-attachments/assets/1647c249-75f1-4782-9cc0-41a459538d7b" />|
| 🔗 Causal Chain | <img width="1908" height="904" alt="image" src="https://github.com/user-attachments/assets/bd7497b6-388a-4446-8a8d-49f5c3423051" />|
| 📈 Market Tape + Charts | <img width="1919" height="847" alt="image" src="https://github.com/user-attachments/assets/af65f40b-7265-4b30-b2f0-a6a31094e4d3" />|
| 🧭 Compare Mode | <img width="1919" height="845" alt="image" src="https://github.com/user-attachments/assets/acf6d8b7-dcf3-4c0c-a218-ad104b97d35c" />|


---

## 🧠 What Sphere Does

Sphere turns open-ended questions into structured investigations.

Instead of showing weather, markets, news, flights, health, and conflict as isolated widgets, Sphere connects them into one intelligence workflow.

### Core loop

```text
query
  → intent classification
  → entity resolution
  → scoped retrieval
  → calibrated ranking
  → causal chain generation
  → market posture
  → portfolio impact
  → evidence + caveats
  → save / share / alert
```

### Example

A user asks:

```text
Why is oil up?
```

Sphere can resolve the query as a commodity question, retrieve oil-related evidence, rank the top drivers, build causal chains, and explain the possible transmission path.

```text
Shipping disruption → supply-chain pressure → oil supply risk → commodity posture changes
```

The goal is not just to answer **what happened**.

The goal is to explain:

- **what changed**
- **why it matters**
- **what it affects**
- **how confident the system is**
- **what evidence supports it**

---

## 🎯 Why This Matters

### For individuals

- Understand market moves beyond price charts
- Connect global news to financial risk
- Track countries, commodities, FX, and equities in one place
- Save and share structured investigations

### For companies

- Monitor geopolitical, weather, health, and logistics risk
- Track exposure to countries, sectors, commodities, and currencies
- Build operational dashboards for supply-chain and market risk
- Convert scattered signals into decision-ready intelligence

### For analysts and operators

Sphere acts like a lightweight intelligence workstation:

- live global context
- evidence-backed summaries
- causal drivers
- risk posture
- portfolio impact
- alerts
- shareable briefs

---

## 🌐 Photorealistic Globe

Sphere uses a custom **Three.js + React Three Fiber** globe as the spatial context layer.

The globe is not just decoration. It is designed to visualize live signals and investigation context.

### Globe features

- 🌊 Ocean shader with darker navy tones and controlled specular response
- ☁️ Cloud shell / volumetric cloud layer for atmospheric depth
- 🌅 Atmosphere rim and twilight shading
- 🌃 Night-side city lights and shadow-side ambient visibility
- 🌌 Dense starfield for cinematic space context
- ☀️ Real-time sun direction and lighting driver
- 🧭 Camera focus controller for country/entity search
- 📍 Domain markers for events, conflicts, health signals, markets, and news
- ✈️ Planned / experimental support for 3D flight arcs and route visualizations

### Shader and rendering goals

Sphere’s rendering direction is inspired by:

- cinematic Earth visualization
- operational command-center interfaces
- dark glass UI systems
- premium geospatial intelligence tools

The globe is tuned for:

- depth
- atmosphere
- spatial context
- readable overlays
- restrained visual drama

It is not intended to be a scientific Earth simulator. It is a premium intelligence surface.

---

## ✨ UI / Product Design Philosophy

Sphere follows an **operator-first interface**.

The UI is built around dense but readable intelligence surfaces:

- 🔎 top command bar
- 🌍 globe stage
- 📡 awareness rail
- 📊 right-side investigation panel
- 📈 market tape
- 🧾 evidence cards
- 🔗 causal chain cards
- 💼 portfolio impact cards

### Design direction

The intended visual language is:

```text
Palantir-style seriousness
+ Bloomberg-style density
+ Apple-level dark glass polish
+ cinematic globe context
```

### UI principles

- Search first, not menu first
- Evidence before claims
- Confidence and caveats always visible
- Compact signals, not long prose dumps
- No hidden synthetic/live data ambiguity
- Visual hierarchy should guide the analyst from answer → why → evidence

---

## 📡 Live Indicators and Signal Types

Sphere supports multiple signal domains.

| Domain | What it represents | Example use |
|---|---|---|
| 📈 Markets | Equities, ETFs, market posture | TSLA, NVDA, SPY |
| 💱 FX | Currency pairs and currency pressure | USDJPY, EURUSD |
| 🛢 Commodities | Oil, gold, energy/material signals | crude oil, gold |
| 📰 News | Geolocated global events | GDELT-style event feeds |
| 🌦 Weather | Storms, alerts, operational disruptions | severe weather near logistics regions |
| 🦠 Health | outbreak or health-risk signals | regional health pressure |
| ⚠️ Conflict | geopolitical and regional risk | conflict markers, risk posture |
| ✈️ Flights | mobility and route disruption signals | flight arcs, airport disruption markers |

Each signal can carry:

- timestamp
- severity
- domain
- location
- source health
- confidence
- freshness
- related entities

---

## 🤖 Intelligence Engine

Sphere is built around a hybrid intelligence architecture.

It does **not** let the LLM invent facts.

Instead, it separates deterministic truth from language generation.

### Deterministic layer

The deterministic layer handles:

- entity resolution
- query intent classification
- time-window parsing
- scoped retrieval
- evidence ranking
- confidence calibration
- causal chain construction
- market posture scoring
- portfolio impact mapping

### LLM / agentic layer

The LLM layer is optional and bounded.

It is used for:

- rewriting grounded explanations
- summarizing evidence
- improving narrative clarity
- producing analyst-style language

It is **not** used as the source of truth for:

- prices
- candles
- risk scores
- causal edges
- portfolio impact
- provider health
- confidence values

---

## 🔎 Retrieval, Ranking, and Calibration

Sphere’s retrieval flow is designed to avoid vague global fallback answers.

The system performs:

1. query classification
2. entity resolution
3. domain scoping
4. time-window parsing
5. evidence retrieval
6. reranking
7. confidence calibration
8. caveat generation

### Calibration inputs

Confidence is based on interpretable inputs such as:

- evidence count
- evidence agreement
- recency
- source diversity
- entity-resolution confidence
- feedback signals from query logs

### Query log and reranking

Sphere includes a query logging and calibration system that can capture:

- query text
- intent
- resolved entities
- evidence IDs
- confidence score
- result count
- latency
- user feedback action

This allows future tuning of ranking weights and confidence formulas.

---

## 🔗 Causal Chain Engine

Sphere includes a deterministic causal-chain engine.

It converts evidence into structured paths like:

```text
event / signal → mechanism → affected domain → downstream asset / region / portfolio exposure
```

Example:

```text
Red Sea disruption
  → shipping route pressure
  → supply-chain risk
  → oil risk premium
  → energy portfolio exposure
```

### Causal chain components

- Causal nodes
- Causal edges
- Mechanisms
- Impact direction
- Impact strength
- Confidence
- Caveats
- Source evidence IDs

Every causal chain must be grounded in evidence. Unsupported causality returns caveats instead of fake explanations.

---

## 💼 Portfolio Impact Linkage

Sphere can map causal chains to a demo or user portfolio.

Example:

```text
Oil supply pressure → energy sector → XOM exposure
```

The system classifies exposure as:

- **Direct** — affected symbol matches a holding
- **Indirect** — affected domain matches sector/asset metadata
- **Weak** — broad country or macro exposure

The system does **not** fake P&L or pretend to provide financial advice.

It shows directional exposure and caveats.

---

## 📈 Market Posture and Charts

Sphere supports market posture analysis using a combination of:

- technical indicators
- semantic/news pressure
- macro/entity relevance
- confidence and caveats

The posture output can include:

- Strong Sell
- Sell
- Neutral
- Buy
- Strong Buy

### Provider honesty

Sphere clearly distinguishes between:

- `LIVE`
- `CACHED`
- `SYNTHETIC DEMO`
- `UNAVAILABLE`
- `RATE LIMITED`

If no live provider key is configured, charts run with deterministic synthetic demo data and are labeled accordingly.

---

## 🧱 Architecture

```text
┌─────────────────────────────────────┐
│ Frontend                            │
│ Next.js + React + TypeScript        │
│ React Three Fiber / Three.js Globe  │
│ Zustand State Stores                │
│ Lightweight Charts                  │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│ Backend                             │
│ FastAPI + Pydantic                  │
│ Intelligence Runtime                │
│ Retrieval Orchestrator              │
│ Calibration + Reranker              │
│ Causal Chain Builder                │
│ Portfolio Impact Engine             │
│ Alert Evaluator                     │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│ Storage                             │
│ PostgreSQL + PostGIS                │
│ Redis                               │
│ Alembic Migrations                  │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│ Optional External Providers         │
│ Alpha Vantage                       │
│ GDELT                               │
│ Open-Meteo                          │
│ USGS                                │
│ Frankfurter                         │
│ Anthropic Claude                    │
└─────────────────────────────────────┘
```

---

## 🧰 Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js, React, TypeScript |
| Globe | Three.js, React Three Fiber, custom shaders |
| State | Zustand |
| Charts | Lightweight charting surface |
| Backend | FastAPI, Python, Pydantic |
| Persistence | PostgreSQL, PostGIS, Alembic |
| Cache / Alerts | Redis |
| AI Narrative | Anthropic Claude, optional |
| Market Data | Alpha Vantage, Polygon |
| Testing | Pytest, Vitest, Playwright |
| Infra | Docker Compose, health checks |
| Deployment| Railway relay, Cloudfare https://thesphere.icu/|

---

## 🧪 Testing

```bash
# Backend
cd backend
uv run pytest

# Frontend
cd frontend
pnpm test

# Frontend typecheck
cd frontend
pnpm tsc --noEmit

# Optional Playwright
cd frontend
pnpm playwright test
```

The project includes tests for:

- retrieval
- entity resolution
- compare mode
- time-window parsing
- causal chain generation
- market posture
- portfolio impact
- alerts
- saved investigations
- frontend panels
- globe interaction paths

---

## 🚀 Local Setup

### Docker setup

```bash
cp .env.example .env
# Add optional API keys if available

docker compose up --build
```

Frontend:

```text
http://localhost:3000
```

Backend:

```text
http://localhost:8000
```

### Useful commands

```bash
# Rebuild frontend only
docker compose up -d --build frontend

# Rebuild backend only
docker compose up -d --build backend

# Check Redis
docker compose exec redis redis-cli ping

# Check Postgres tables
docker compose exec postgres psql -U sphere -d sphere -c "\dt"

# Backend logs
docker compose logs backend --tail=200
```

---

## 🔐 Environment Variables

| Variable | Purpose | Required |
|---|---|---|
| `INTELLIGENCE_DATABASE_URL` | Postgres DSN for investigations/query logs | Recommended |
| `INTELLIGENCE_REDIS_URL` | Redis URL for alerts/rate limits | Recommended |
| `INTELLIGENCE_MARKET_DATA_PROVIDER` | Market provider selection | Optional |
| `INTELLIGENCE_ALPHA_VANTAGE_API_KEY` | Live market candles | Optional |
| `INTELLIGENCE_ANTHROPIC_API_KEY` | Claude narrative layer | Optional |
| `NEXT_PUBLIC_API_BASE_URL` | Frontend backend URL | Required |
| `NEXT_PUBLIC_WS_BASE_URL` | WebSocket base URL if enabled | Optional |

Sphere can run without provider keys, but live functionality improves when keys are configured.

---

## 🧭 Full Phase Breakdown

| Phase | Name | What was built | Status |
|---|---|---|---|
| 1 | Foundation | Project setup, initial architecture, frontend/backend skeleton | ✅ Done |
| 2 | Globe Prototype | Early 3D Earth surface and basic scene setup | ✅ Done |
| 3 | Workspace Shell | Initial command-center layout and panels | ✅ Done |
| 4 | Signal Ingestion | Early global signal/event ingestion concepts | ✅ Done |
| 5 | Event Modeling | Normalized event structures and domain concepts | ✅ Done |
| 6 | UI Panels | Early right-panel and rail surfaces | ✅ Done |
| 7 | Globe Visuals | Atmosphere, borders, markers, lighting experiments | ✅ Done |
| 8 | Search Flow | Search-first interaction model | ✅ Done |
| 9 | Intelligence Workspace | Query panel, focus behavior, workspace state | ✅ Done |
| 10 | Globe Shader System | Ocean, atmosphere, clouds, night side, tone mapping | ✅ Done |
| 11 | Live Feeds | Weather, news, markets, health/conflict/feed adapters | ✅ Done |
| 12 | Agentic Investigation | Early agent query service and grounded answer flow | ✅ Done |
| 12.3 | Geographic Trust Repair | Better city/country scoping and fallback honesty | ✅ Done |
| 13 | Portfolio Intelligence | Portfolio surface, holdings context, valuation/posture basics | ✅ Done |
| 13B | Signal Engines | Technical indicators, charting, replay foundation | ✅ Done |
| 14 | Operator UI | Mode system, shell refinement, panel grammar | ✅ Done |
| 15A | Workflow Repair | Onboarding, rail improvements, better demo flow | ✅ Done |
| 15B | Chart Surface | Indicators, technical rating, chart wrapper | ✅ Done |
| 15C | Timeline Intelligence | Trend deltas, what-changed logic, feed warming | ✅ Done |
| 16 | Motion + Market Surface | Ticker tape, replay cursor, hydration fixes | ✅ Done |
| 16.7 | Universal Market Charts | Decoupled charts from portfolio membership | ✅ Done |
| 17A | Posture Engine | Deterministic market posture and provider contracts | ✅ Done |
| 17A.2 | Semantic Market Layer | Semantic/news pressure blended into posture | ✅ Done |
| 17A.3 | Agentic Narrative | Bounded LLM narrative over deterministic posture | ✅ Done |
| 17B | Saved Investigations | Save/restore/share investigation snapshots | ✅ Done |
| 17C | Alerts MVP | Alert rules, alert events, bell surface, rate limits | ✅ Done |
| 18A | Retrieval Orchestrator | EvidenceBundle, time windows, compare planning | ✅ Done |
| 18B | Calibration | Query logs, reranking, confidence calibration | ✅ Done |
| 18C | Scope Enforcement | Entity-first routing, no global fallback, compare fixes | ✅ Done |
| 18D | Causal Chains | Deterministic causal chain engine and top drivers | ✅ Done |
| 19A | Demo Polish | Search examples, story ordering, causal card emphasis | ✅ Done |
| 19B | Portfolio Impact | Causal chain to portfolio/demo-book linkage | ✅ Done |
| 19C | Globe Revamp | Clouds, starfield, real-time sun, marker fixes | ✅ Done |
| 19D | Visual System | Design tokens, gradients, premium dark glass polish | ✅ Done |
| 19E | Launch Verification | Infra audit, provider honesty, chart reliability checks | 🚧 Finalizing |
| 20A | Domain Globe Layers | Flights, health, conflict, news markers/arcs/hotspots | 🚧 In progress / planned |

---

## 🧠 What Makes This Different

Most dashboards show data.

Sphere tries to explain meaning.

```text
signal → evidence → cause → impact → confidence → action
```

This makes it closer to a lightweight intelligence system than a standard analytics dashboard.

---

## ⚠️ Honest Limitations

Sphere is still a prototype.

Current limitations:

- Not investment advice
- Not a replacement for professional terminals
- Live data depends on provider keys and rate limits
- Some domains use fallback/demo data when providers are unavailable
- No multi-user authentication yet
- No enterprise permission model yet
- Flight/health/conflict visual layers are still evolving
- Globe realism is custom-built and still being tuned
- No CI/CD pipeline yet

---

## 🔮 Future Work

### Product

- Multi-user workspaces
- Team investigation sharing
- Watchlists and saved entities
- Better onboarding and demo mode
- Advanced alert rules
- Investigation export to PDF / Markdown

### Data

- More reliable market providers
- Better flight route providers
- More robust health/conflict feeds
- Historical event replay
- Provider freshness dashboard

### AI / Intelligence

- Lightweight RAG over saved investigations
- Deeper causal-chain expansion
- Better confidence calibration from real usage
- Analyst feedback loop
- Domain-specific sub-agents

### Globe

- Improved domain markers
- 3D flight arcs
- health/conflict hotspots
- better marker occlusion
- improved cloud realism
- more detailed polar views

### Infrastructure

- CI/CD
- hosted deployment
- auth
- observability
- backups
- rate-limit dashboards

---

## 🧾 Resume-Friendly Summary



Sphere | Real-Time Geospatial Intelligence Platform

Next.js, TypeScript, React Three Fiber, FastAPI, PostgreSQL/PostGIS, Redis, Docker

Sphere is a real-time geospatial intelligence platform that fuses world signals, market data, calibrated retrieval, causal-chain reasoning, and portfolio-impact analysis into a search-first investigation workflow.

It demonstrates:

- full-stack systems engineering
- frontend visualization engineering
- backend intelligence pipelines
- retrieval and ranking
- causal reasoning
- provider honesty
- production-oriented persistence and caching

## 📌 License

Personal project. Shared for portfolio and review purposes. Not licensed for production redistribution.

---

## 🙋 Author

Built by **Anish Nehete**.

> If you find this project interesting, consider starring the repository ⭐
