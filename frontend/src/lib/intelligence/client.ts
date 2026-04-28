// Typed client for the backend intelligence surface. All callers go through
// these helpers so the endpoint shape stays in one place and the UI never
// hand-rolls fetch calls against the canonical SignalEvent schema.

import {
  AgentResponse,
  AgentResponseWire,
  CandleRange,
  CompareResponse,
  CompareTargetKind,
  CountryDetailResponse,
  CsvImportResponse,
  DependencyResponse,
  EventsResponse,
  HealthResponse,
  HoldingCandlesResponse,
  HoldingInput,
  MarketCandlesResponse,
  MarketNarrativeResponse,
  MarketPostureResponse,
  PostureAssetClass,
  IntelligenceApiError,
  PortfolioBrief,
  PortfolioCreateRequest,
  PortfolioListResponse,
  PortfolioMacroRiskScore,
  PortfolioRecord,
  PortfolioSemanticResponse,
  PortfolioTechnicalResponse,
  PortfolioUpdateRequest,
  PortfolioValuationSummary,
  SearchResponse,
  SignalCategory,
  Watchlist,
  WatchlistInput,
  WatchlistListResponse,
} from "@/lib/intelligence/types";

// Phase 15A — defensive normalizer for AgentResponse.
// Older /query/agent backends return the pre-12.3 shape (no resolved_place,
// no place_dependencies, etc). The UI declares those fields as required, so
// without this guard a stale backend crashes the entire workspace via a
// `Cannot read properties of undefined (reading 'length')` during render.
// The normalizer fills the safe defaults the panel already expects when it
// renders an "exact-match, no extras" answer.
export function normalizeAgentResponse(wire: AgentResponseWire): AgentResponse {
  return {
    query: wire.query ?? "",
    interpreted_query: wire.interpreted_query ?? wire.query ?? "",
    intent: wire.intent ?? "general_retrieval",
    reasoning_mode: wire.reasoning_mode ?? "rule_based",
    resolved_entities: wire.resolved_entities ?? [],
    answer: wire.answer ?? [],
    evidence: wire.evidence ?? [],
    follow_ups: wire.follow_ups ?? [],
    related_countries: wire.related_countries ?? [],
    related_events: wire.related_events ?? [],
    confidence: typeof wire.confidence === "number" ? wire.confidence : 0,
    generated_at: wire.generated_at ?? new Date().toISOString(),
    resolved_place: wire.resolved_place ?? null,
    fallback_notice: wire.fallback_notice ?? null,
    scope_used: wire.scope_used ?? "global",
    scope_confidence:
      typeof wire.scope_confidence === "number" ? wire.scope_confidence : 0,
    place_dependencies: wire.place_dependencies ?? [],
    macro_context: wire.macro_context ?? null,
    // Phase 18A.1 — these arrived in 18A.1; older backends omit them.
    time_context: wire.time_context ?? null,
    compare_summary: wire.compare_summary ?? null,
    workers_invoked: wire.workers_invoked ?? [],
    caveats: wire.caveats ?? [],
    // Phase 18D — optional. Older backends omit; render falls through.
    causal_chains: wire.causal_chains ?? null,
    // Phase 19B — optional. Older backends omit; card hides itself when null.
    portfolio_impact: wire.portfolio_impact ?? null,
  };
}

export interface IntelligenceClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

function resolveBaseUrl(explicit: string | undefined): string {
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }

  // Priority 1: NEXT_PUBLIC_API_BASE_URL
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_API_BASE_URL) {
    return process.env.NEXT_PUBLIC_API_BASE_URL.replace(/\/$/, "");
  }

  // Priority 2: NEXT_PUBLIC_API_URL
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL.replace(/\/$/, "");
  }

  // Priority 3: localhost for development
  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }

  return "http://localhost:8000";
}

function getWebSocketUrl(): string {
  // Priority 1: NEXT_PUBLIC_WS_URL
  if (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_WS_URL) {
    return process.env.NEXT_PUBLIC_WS_URL;
  }

  // Priority 2: Derive from API URL
  const apiUrl = resolveBaseUrl(undefined);
  if (apiUrl.startsWith("https://")) {
    return apiUrl.replace("https://", "wss://");
  }
  if (apiUrl.startsWith("http://")) {
    return apiUrl.replace("http://", "ws://");
  }

  return "ws://localhost:8000";
}

async function request<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  options: IntelligenceClientOptions = {},
): Promise<T> {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  const suffix = query.toString();
  const url = `${baseUrl}${path}${suffix ? `?${suffix}` : ""}`;
  const fetcher = options.fetcher ?? fetch;

  let response: Response;
  try {
    response = await fetcher(url, {
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Network error";
    throw new IntelligenceApiError(message, path, null);
  }

  if (!response.ok) {
    throw new IntelligenceApiError(
      `Intelligence API ${path} failed: ${response.status}`,
      path,
      response.status,
    );
  }

  return (await response.json()) as T;
}

async function requestJson<T>(
  path: string,
  body: unknown,
  options: IntelligenceClientOptions = {},
  method: "POST" | "PATCH" | "PUT" = "POST",
): Promise<T> {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const url = `${baseUrl}${path}`;
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Network error";
    throw new IntelligenceApiError(message, path, null);
  }
  if (!response.ok) {
    throw new IntelligenceApiError(
      `Intelligence API ${path} failed: ${response.status}`,
      path,
      response.status,
    );
  }
  return (await response.json()) as T;
}

async function requestDelete(
  path: string,
  options: IntelligenceClientOptions = {},
): Promise<void> {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const url = `${baseUrl}${path}`;
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "DELETE",
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Network error";
    throw new IntelligenceApiError(message, path, null);
  }
  if (!response.ok && response.status !== 204) {
    throw new IntelligenceApiError(
      `Intelligence API ${path} failed: ${response.status}`,
      path,
      response.status,
    );
  }
}

export async function getHealth(
  options: IntelligenceClientOptions = {},
): Promise<HealthResponse> {
  return request<HealthResponse>("/api/intelligence/health", {}, options);
}

export interface LatestSignalsParams {
  category?: SignalCategory;
  limit?: number;
}

export async function getLatestSignals(
  params: LatestSignalsParams = {},
  options: IntelligenceClientOptions = {},
): Promise<EventsResponse> {
  return request<EventsResponse>(
    "/api/intelligence/events/latest",
    {
      category: params.category,
      limit: params.limit ?? 25,
    },
    options,
  );
}

export async function getEventsByCountry(
  code: string,
  limit = 50,
  options: IntelligenceClientOptions = {},
): Promise<EventsResponse> {
  return request<EventsResponse>(
    "/api/intelligence/events/by-country",
    { code, limit },
    options,
  );
}

export async function getCountrySummary(
  code: string,
  options: IntelligenceClientOptions = {},
): Promise<CountryDetailResponse> {
  return request<CountryDetailResponse>(
    `/api/intelligence/country/${encodeURIComponent(code)}`,
    {},
    options,
  );
}

export interface SearchParams {
  q: string;
  category?: SignalCategory;
  country?: string;
  limit?: number;
}

export async function searchIntelligence(
  params: SearchParams,
  options: IntelligenceClientOptions = {},
): Promise<SearchResponse> {
  return request<SearchResponse>(
    "/api/intelligence/search",
    {
      q: params.q,
      category: params.category,
      country: params.country,
      limit: params.limit ?? 25,
    },
    options,
  );
}

// ---- Phase 12 -----------------------------------------------------------------

export interface QueryAgentOptions extends IntelligenceClientOptions {
  // Phase 19B — optional active portfolio id. When provided the backend
  // attaches portfolio_impact to the response. Omitted on initial calls
  // and for sessions without a selected portfolio.
  portfolioId?: string | null;
}

export async function queryAgent(
  query: string,
  options: QueryAgentOptions = {},
): Promise<AgentResponse> {
  const { portfolioId, ...rest } = options;
  const body: Record<string, unknown> = { query };
  if (portfolioId) {
    body.portfolio_id = portfolioId;
  }
  const wire = await requestJson<AgentResponseWire>(
    "/api/intelligence/query/agent",
    body,
    rest,
  );
  return normalizeAgentResponse(wire);
}

export async function getDependenciesForCountry(
  code: string,
  options: IntelligenceClientOptions = {},
): Promise<DependencyResponse> {
  return request<DependencyResponse>(
    `/api/intelligence/dependencies/country/${encodeURIComponent(code)}`,
    {},
    options,
  );
}

export async function getDependenciesForEvent(
  eventId: string,
  options: IntelligenceClientOptions = {},
): Promise<DependencyResponse> {
  return request<DependencyResponse>(
    `/api/intelligence/dependencies/event/${encodeURIComponent(eventId)}`,
    {},
    options,
  );
}

export interface CompareTargetSpec {
  kind: CompareTargetKind;
  id: string;
}

export async function compareTargets(
  targets: CompareTargetSpec[],
  options: IntelligenceClientOptions = {},
): Promise<CompareResponse> {
  const encoded = targets.map((t) => `${t.kind}:${t.id}`).join(",");
  return request<CompareResponse>(
    "/api/intelligence/compare",
    { targets: encoded },
    options,
  );
}

// ---- Phase 13A portfolio -----------------------------------------------------

export async function listPortfolios(
  options: IntelligenceClientOptions = {},
): Promise<PortfolioListResponse> {
  return request<PortfolioListResponse>(
    "/api/intelligence/portfolios",
    {},
    options,
  );
}

export async function getPortfolio(
  id: string,
  options: IntelligenceClientOptions = {},
): Promise<PortfolioRecord> {
  return request<PortfolioRecord>(
    `/api/intelligence/portfolios/${encodeURIComponent(id)}`,
    {},
    options,
  );
}

export async function createPortfolio(
  payload: PortfolioCreateRequest,
  options: IntelligenceClientOptions = {},
): Promise<PortfolioRecord> {
  return requestJson<PortfolioRecord>(
    "/api/intelligence/portfolios",
    payload,
    options,
  );
}

export async function updatePortfolio(
  id: string,
  payload: PortfolioUpdateRequest,
  options: IntelligenceClientOptions = {},
): Promise<PortfolioRecord> {
  return requestJson<PortfolioRecord>(
    `/api/intelligence/portfolios/${encodeURIComponent(id)}`,
    payload,
    options,
    "PATCH",
  );
}

export async function deletePortfolio(
  id: string,
  options: IntelligenceClientOptions = {},
): Promise<void> {
  return requestDelete(
    `/api/intelligence/portfolios/${encodeURIComponent(id)}`,
    options,
  );
}

export async function addPortfolioHoldings(
  id: string,
  holdings: HoldingInput[],
  options: IntelligenceClientOptions = {},
): Promise<PortfolioRecord> {
  return requestJson<PortfolioRecord>(
    `/api/intelligence/portfolios/${encodeURIComponent(id)}/holdings`,
    holdings,
    options,
  );
}

export async function removePortfolioHolding(
  portfolioId: string,
  holdingId: string,
  options: IntelligenceClientOptions = {},
): Promise<PortfolioRecord> {
  return requestDelete(
    `/api/intelligence/portfolios/${encodeURIComponent(portfolioId)}/holdings/${encodeURIComponent(holdingId)}`,
    options,
  ) as unknown as Promise<PortfolioRecord>;
}

export async function importPortfolioCsv(
  id: string,
  csv: string,
  options: IntelligenceClientOptions = {},
): Promise<CsvImportResponse> {
  return requestJson<CsvImportResponse>(
    `/api/intelligence/portfolios/${encodeURIComponent(id)}/holdings/csv`,
    { csv },
    options,
  );
}

// Plan 06: AsOfParam merged into client options so callers can pass as_of
// without breaking existing call sites that pass only { signal }.
export interface AsOfParam {
  as_of?: string; // ISO 8601 or undefined = live
}

export async function getPortfolioBrief(
  id: string,
  optsOrParams: AsOfParam & IntelligenceClientOptions = {},
): Promise<PortfolioBrief> {
  const { as_of, ...options } = optsOrParams;
  return request<PortfolioBrief>(
    `/api/intelligence/portfolios/${encodeURIComponent(id)}/brief`,
    { as_of },
    options,
  );
}

export async function getPortfolioValuation(
  id: string,
  optsOrParams: AsOfParam & IntelligenceClientOptions = {},
): Promise<PortfolioValuationSummary | null> {
  const { as_of, ...options } = optsOrParams;
  return request<PortfolioValuationSummary | null>(
    `/api/intelligence/portfolios/${encodeURIComponent(id)}/valuation`,
    { as_of },
    options,
  );
}

export async function getPortfolioTechnical(
  id: string,
  optsOrParams: AsOfParam & IntelligenceClientOptions = {},
): Promise<PortfolioTechnicalResponse> {
  const { as_of, ...options } = optsOrParams;
  return request<PortfolioTechnicalResponse>(
    `/api/intelligence/portfolios/${encodeURIComponent(id)}/technical`,
    { as_of },
    options,
  );
}

export async function getPortfolioSemantic(
  id: string,
  optsOrParams: AsOfParam & IntelligenceClientOptions = {},
): Promise<PortfolioSemanticResponse> {
  const { as_of, ...options } = optsOrParams;
  return request<PortfolioSemanticResponse>(
    `/api/intelligence/portfolios/${encodeURIComponent(id)}/semantic`,
    { as_of },
    options,
  );
}

export async function getPortfolioRiskScore(
  id: string,
  optsOrParams: AsOfParam & IntelligenceClientOptions = {},
): Promise<PortfolioMacroRiskScore> {
  const { as_of, ...options } = optsOrParams;
  return request<PortfolioMacroRiskScore>(
    `/api/intelligence/portfolios/${encodeURIComponent(id)}/risk-score`,
    { as_of },
    options,
  );
}

// ---- Phase 13B.5 candle / chart surface --------------------------------------

export interface HoldingCandlesParams {
  range?: CandleRange;
  as_of?: string;   // ISO 8601
}

export async function getHoldingCandles(
  portfolioId: string,
  symbol: string,
  params: HoldingCandlesParams = {},
  options: IntelligenceClientOptions = {},
): Promise<HoldingCandlesResponse> {
  return request<HoldingCandlesResponse>(
    `/api/intelligence/portfolios/${encodeURIComponent(portfolioId)}/holdings/${encodeURIComponent(symbol)}/candles`,
    { range: params.range, as_of: params.as_of },
    options,
  );
}

// Phase 16.7 — universal market candles. Reuses the same provider chain as
// portfolio candles but is not gated on portfolio membership, so any
// supported equity / FX / commodity / future can be charted on click.
export async function getMarketCandles(
  symbol: string,
  params: HoldingCandlesParams = {},
  options: IntelligenceClientOptions = {},
): Promise<MarketCandlesResponse> {
  return request<MarketCandlesResponse>(
    `/api/intelligence/market/${encodeURIComponent(symbol)}/candles`,
    { range: params.range, as_of: params.as_of },
    options,
  );
}

// Phase 17A.1 — deterministic market posture. Mirrors the backend
// /market/{symbol}/posture endpoint. Callers (incl. the 17A.2 agent
// layer) consume the typed envelope as the source of truth for buy/
// sell calls; the LLM may synthesize prose around these numbers but
// must never invent them.
export interface MarketPostureParams {
  asset_class?: PostureAssetClass;
  as_of?: string;
}

export async function getMarketPosture(
  symbol: string,
  params: MarketPostureParams = {},
  options: IntelligenceClientOptions = {},
): Promise<MarketPostureResponse> {
  return request<MarketPostureResponse>(
    `/api/intelligence/market/${encodeURIComponent(symbol)}/posture`,
    {
      asset_class: params.asset_class,
      as_of: params.as_of,
    },
    options,
  );
}

// Phase 17A.3 — bounded agentic narrative. Returns the same posture
// envelope plus a 2-3 sentence narrative; when Anthropic is configured
// the prose is from Claude under guardrails, otherwise deterministic.
// The deterministic posture is the source of record either way.
export async function getMarketNarrative(
  symbol: string,
  params: MarketPostureParams = {},
  options: IntelligenceClientOptions = {},
): Promise<MarketNarrativeResponse> {
  return request<MarketNarrativeResponse>(
    `/api/intelligence/market/${encodeURIComponent(symbol)}/narrative`,
    {
      asset_class: params.asset_class,
      as_of: params.as_of,
    },
    options,
  );
}

export async function listWatchlists(
  options: IntelligenceClientOptions = {},
): Promise<WatchlistListResponse> {
  return request<WatchlistListResponse>(
    "/api/intelligence/watchlists",
    {},
    options,
  );
}

export async function createWatchlist(
  payload: WatchlistInput,
  options: IntelligenceClientOptions = {},
): Promise<Watchlist> {
  return requestJson<Watchlist>(
    "/api/intelligence/watchlists",
    payload,
    options,
  );
}

export async function convertWatchlistToPortfolio(
  watchlistId: string,
  payload: { name?: string; base_currency?: string },
  options: IntelligenceClientOptions = {},
): Promise<PortfolioRecord> {
  return requestJson<PortfolioRecord>(
    `/api/intelligence/watchlists/${encodeURIComponent(watchlistId)}/convert-to-portfolio`,
    payload,
    options,
  );
}

export const intelligenceClient = {
  getHealth,
  getLatestSignals,
  getEventsByCountry,
  getCountrySummary,
  searchIntelligence,
  queryAgent,
  getDependenciesForCountry,
  getDependenciesForEvent,
  compareTargets,
  getMarketCandles,
  getMarketPosture,
  getMarketNarrative,
};
