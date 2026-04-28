// Canonical intelligence types mirrored from the backend SignalEvent schema.
// Keep names aligned with backend serialization (snake_case) so we can pass the
// payload straight through without a rename layer. The overlay store derives
// whatever camelCase shape the UI needs.

export type SignalCategory =
  | "weather"
  | "news"
  | "flights"
  | "conflict"
  | "health"
  | "disease"
  | "mood"
  | "markets"
  | "stocks"
  | "commodities"
  | "currency"
  | "other";

export type SignalSeverity = "info" | "watch" | "elevated" | "critical";
export type SignalStatus = "active" | "resolved" | "forecast" | "stale";

export interface Place {
  latitude: number | null;
  longitude: number | null;
  country_code: string | null;
  country_name: string | null;
  region: string | null;
  admin1: string | null;
  locality: string | null;
}

export interface SourceRef {
  adapter: string;
  provider: string;
  provider_event_id: string | null;
  url: string | null;
  retrieved_at: string;
  source_timestamp: string | null;
  publisher: string | null;
  reliability: number;
}

export interface EventEntity {
  entity_id: string;
  entity_type:
    | "country"
    | "city"
    | "region"
    | "route"
    | "facility"
    | "company"
    | "person"
    | "topic"
    | "other";
  name: string;
  country_code: string | null;
  score: number;
}

export interface SignalEvent {
  id: string;
  dedupe_key: string;
  type: SignalCategory;
  sub_type: string | null;
  title: string;
  summary: string;
  description: string | null;
  severity: SignalSeverity;
  severity_score: number;
  confidence: number;
  status: SignalStatus;
  place: Place;
  start_time: string | null;
  end_time: string | null;
  source_timestamp: string | null;
  ingested_at: string;
  sources: SourceRef[];
  merged_from: string[];
  tags: string[];
  entities: EventEntity[];
  score: number | null;
  properties: Record<string, unknown>;
}

export interface EventsResponse {
  total: number;
  items: SignalEvent[];
}

export interface CountrySignalSummary {
  country_code: string;
  country_name: string;
  updated_at: string;
  watch_score: number;
  watch_delta: number;
  watch_label: SignalSeverity;
  counts_by_category: Partial<Record<SignalCategory, number>>;
  top_signals: SignalEvent[];
  headline_signal_id: string | null;
  confidence: number;
  sources: SourceRef[];
  summary: string | null;
}

export interface CountryDetailResponse {
  summary: CountrySignalSummary;
  events: SignalEvent[];
}

export interface SearchHit {
  event: SignalEvent;
  score: number;
  matched_terms: string[];
}

export interface SearchResponse {
  query: string;
  resolved_country_code: string | null;
  total: number;
  hits: SearchHit[];
}

export interface AdapterHealth {
  adapter: string;
  category: SignalCategory;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastItemCount: number;
  stale: boolean;
  domain: string | null;
  enabled: boolean;
  provider: string | null;
  hasApiKey: boolean;
  baseUrl: string | null;
  configured: boolean;
}

export interface PersistenceHealth {
  investigations: string;
  alerts: string;
  queryLog: string;
  marketDataProvider: string;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  totalCycles: number;
  totalEventsIngested: number;
  lastCycle: Record<string, unknown> | null;
  adapters: AdapterHealth[];
  persistence: PersistenceHealth;
}

// ---- Phase 12A agent ---------------------------------------------------------

export type AgentIntent =
  | "why_elevated"
  | "what_changed"
  | "driving_factor"
  | "downstream_impact"
  | "status_check"
  | "general_retrieval";

export type AgentReasoningMode = "rule_based" | "retrieval_plus_llm";

export type ResolvedEntityKind =
  | "country"
  | "topic"
  | "ticker"
  | "fx_pair"
  | "region"
  | "city"
  | "port"
  | "chokepoint"
  | "place";

export interface ResolvedEntity {
  kind: ResolvedEntityKind;
  id: string;
  name: string;
  country_code: string | null;
}

// ---- Phase 12.3 place scope --------------------------------------------------

export type PlaceFallbackLevel =
  | "exact"
  | "alias_substring"
  | "nearby_city"
  | "parent_country"
  | "parent_region"
  | "none";

export type ScopeUsed = "exact_place" | "country" | "region" | "global";

export interface MacroContext {
  country_code: string;
  currency_code: string;
  logistics_hub: boolean;
  sector_tags: string[];
  top_export_commodity: string | null;
  top_export_sensitivity: number | null;
  top_import_commodity: string | null;
  top_import_sensitivity: number | null;
  trade_dependence_score: number | null;
  shipping_exposure: number | null;
}

export interface PlaceScope {
  query: string;
  place_id: string | null;
  name: string | null;
  type: string | null;
  country_code: string | null;
  country_name: string | null;
  parent_id: string | null;
  parent_name: string | null;
  latitude: number | null;
  longitude: number | null;
  bbox: [number, number, number, number] | null;
  aliases: string[];
  tags: string[];
  fallback_level: PlaceFallbackLevel;
  is_fallback: boolean;
  confidence: number;
  macro_context: MacroContext | null;
  source: "place_resolver" | "country_lookup";
}

export interface AgentSegment {
  text: string;
  evidence_ids: string[];
}

export interface AgentFollowUp {
  label: string;
  query: string;
}

export interface EvidenceRef {
  id: string;
  title: string;
  type: string;
  severity: SignalSeverity;
  severity_score: number;
  confidence: number;
  source_timestamp: string | null;
  country_code: string | null;
  country_name: string | null;
  publisher: string | null;
  url: string | null;
}

// ---- Phase 18A.1 retrieval orchestrator surface ----------------------------

export type AgentTimeKind = "live" | "since" | "between" | "as_of" | "delta";

export type AgentTimeCoverage =
  | "live"
  | "windowed"
  | "delta"
  | "as_of"
  | "no_match";

export interface AgentTimeContext {
  kind: AgentTimeKind;
  coverage: AgentTimeCoverage;
  label: string;
  answer_mode_label: string;
  since: string | null;
  until: string | null;
  matched_event_count: number;
  is_historical: boolean;
}

export type AgentCompareKind =
  | "country"
  | "place"
  | "ticker"
  | "fx_pair"
  | "commodity"
  | "unknown";

export type AgentCompareResolution = "exact" | "alias" | "fallback" | "none";

export type AgentCompareMode = "vs" | "compare" | "between" | "compared_to";

export interface AgentCompareTarget {
  raw: string;
  kind: AgentCompareKind;
  canonical_id: string | null;
  label: string;
  country_code: string | null;
  confidence: number;
  resolution: AgentCompareResolution;
  event_ids: string[];
  counts_by_category: Record<string, number>;
  severity_distribution: Record<string, number>;
  freshness_minutes: number | null;
  watch_score: number | null;
  watch_label: string | null;
}

export interface AgentCompareSummary {
  requested: boolean;
  collapsed: boolean;
  mode: AgentCompareMode | null;
  raw_phrase: string | null;
  targets: AgentCompareTarget[];
  headline: string | null;
}

export interface AgentResponse {
  query: string;
  interpreted_query: string;
  intent: AgentIntent;
  reasoning_mode: AgentReasoningMode;
  resolved_entities: ResolvedEntity[];
  answer: AgentSegment[];
  evidence: EvidenceRef[];
  follow_ups: AgentFollowUp[];
  related_countries: string[];
  related_events: string[];
  confidence: number;
  generated_at: string;
  // Phase 12.3 place intelligence surface — older backends may omit these,
  // so the client normalizer fills safe defaults before a render reads them.
  resolved_place: PlaceScope | null;
  fallback_notice: string | null;
  scope_used: ScopeUsed;
  scope_confidence: number;
  place_dependencies: DependencyPath[];
  macro_context: MacroContext | null;
  // Phase 18A.1 retrieval orchestrator surface. Optional on the wire
  // (older backends omit them); the normalizer fills safe defaults so
  // renderers can rely on them.
  time_context: AgentTimeContext | null;
  compare_summary: AgentCompareSummary | null;
  workers_invoked: string[];
  caveats: string[];
  // Phase 18D — optional. Older backends omit; the normalizer fills null.
  causal_chains: CausalChainSet | null;
  // Phase 19B — optional portfolio impact linkage. Hidden when there is
  // no active portfolio or no chain touches a holding.
  portfolio_impact: PortfolioImpact | null;
}

// Wire-shape returned by older /query/agent backends. Phase 12.3 fields may be
// missing; use this only at the client boundary.
export interface AgentResponseWire {
  query?: string;
  interpreted_query?: string;
  intent?: AgentIntent;
  reasoning_mode?: AgentReasoningMode;
  resolved_entities?: ResolvedEntity[];
  answer?: AgentSegment[];
  evidence?: EvidenceRef[];
  follow_ups?: AgentFollowUp[];
  related_countries?: string[];
  related_events?: string[];
  confidence?: number;
  generated_at?: string;
  resolved_place?: PlaceScope | null;
  fallback_notice?: string | null;
  scope_used?: ScopeUsed;
  scope_confidence?: number;
  place_dependencies?: DependencyPath[];
  macro_context?: MacroContext | null;
  // Phase 18A.1 — older backends omit these.
  time_context?: AgentTimeContext | null;
  compare_summary?: AgentCompareSummary | null;
  workers_invoked?: string[];
  caveats?: string[];
  // Phase 18D — older backends omit.
  causal_chains?: CausalChainSet | null;
  // Phase 19B — older backends omit.
  portfolio_impact?: PortfolioImpact | null;
}

// ---- Phase 12B compare -------------------------------------------------------

export type CompareTargetKind = "country" | "event";

export interface CompareTarget {
  kind: CompareTargetKind;
  id: string;
  label: string;
  country_code: string | null;
  summary: CountrySignalSummary | null;
  event: SignalEvent | null;
  recent_events: SignalEvent[];
  counts_by_category: Record<string, number>;
  severity_distribution: Record<string, number>;
  freshness_minutes: number | null;
}

export interface CompareDiff {
  dimension: string;
  left_value: string | number | null;
  right_value: string | number | null;
  delta_note: string | null;
}

export interface CompareResponse {
  generated_at: string;
  targets: CompareTarget[];
  diffs: CompareDiff[];
  headline: string;
}

// ---- Phase 12C dependency ----------------------------------------------------

export type DependencyDomain =
  | "weather"
  | "news"
  | "flights"
  | "conflict"
  | "disease"
  | "mood"
  | "stocks"
  | "commodities"
  | "currency"
  | "logistics"
  | "tourism"
  | "equities"
  | "fx"
  | "supply_chain"
  | "oil"
  | "other";

export interface DependencyNode {
  id: string;
  domain: DependencyDomain;
  label: string;
  country_code: string | null;
  event_id: string | null;
}

export interface DependencyEdge {
  from_id: string;
  to_id: string;
  relation: string;
  rationale: string;
  confidence: number;
  evidence_ids: string[];
}

export interface DependencyPath {
  id: string;
  title: string;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
  focal_event_id: string | null;
  focal_country_code: string | null;
  overall_confidence: number;
  rationale: string;
}

export interface DependencyResponse {
  generated_at: string;
  focal_country_code: string | null;
  focal_event_id: string | null;
  paths: DependencyPath[];
}

// ---- Phase 13A portfolio -----------------------------------------------------

export type PortfolioAssetType =
  | "equity"
  | "etf"
  | "adr"
  | "bond"
  | "fund"
  | "commodity"
  | "fx"
  | "crypto"
  | "cash"
  | "other";

export type ExposureDomain =
  | "country"
  | "sector"
  | "currency"
  | "commodity"
  | "macro_theme"
  | "place"
  | "chokepoint"
  | "asset_class";

export interface HoldingInput {
  symbol: string;
  quantity?: number;
  average_cost?: number | null;
  currency?: string | null;
  asset_type?: PortfolioAssetType | null;
  exchange?: string | null;
  sector?: string | null;
  country_code?: string | null;
  notes?: string | null;
}

export interface PortfolioHolding {
  id: string;
  portfolio_id: string;
  symbol: string;
  name: string | null;
  quantity: number;
  average_cost: number | null;
  market_value: number | null;
  currency: string;
  asset_type: PortfolioAssetType;
  exchange: string | null;
  region: string | null;
  sector: string | null;
  country_code: string | null;
  weight: number;
  notes: string | null;
  enrichment_confidence: number;
  metadata: Record<string, unknown>;
  // ---- Phase 13B additions (all nullable for strict JSON parity with Python | None) ----
  last_price: number | null;
  price_as_of: string | null;
  cost_basis: number | null;
  unrealized_pnl: number | null;
  unrealized_pnl_pct: number | null;
  price_is_stale: boolean;
  price_missing: boolean;
}

export interface PortfolioValuationSummary {
  total_market_value: number | null;
  total_cost_basis: number | null;
  total_unrealized_pnl: number | null;
  total_unrealized_pnl_pct: number | null;
  price_coverage: number;
  stalest_price_as_of: string | null;
  missing_price_symbols: string[];
  weight_basis: "market_value" | "cost_basis_fallback" | "even_split_fallback";
  provider: string;
  generated_at: string;
}

export interface PortfolioRecord {
  id: string;
  name: string;
  description: string | null;
  base_currency: string;
  benchmark_symbol: string | null;
  notes: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  holdings: PortfolioHolding[];
}

export interface ExposureNode {
  id: string;
  domain: ExposureDomain;
  label: string;
  country_code: string | null;
}

export interface ExposureEdge {
  holding_id: string;
  node_id: string;
  weight: number;
  confidence: number;
  rationale: string;
}

export interface ExposureBucket {
  node: ExposureNode;
  weight: number;
  confidence: number;
  contributing_holdings: string[];
  rationale: string | null;
}

export interface ExposureGraph {
  portfolio_id: string;
  nodes: ExposureNode[];
  edges: ExposureEdge[];
}

export interface PortfolioExposureSummary {
  countries: ExposureBucket[];
  sectors: ExposureBucket[];
  currencies: ExposureBucket[];
  commodities: ExposureBucket[];
  macro_themes: ExposureBucket[];
  chokepoints: ExposureBucket[];
}

export interface PortfolioDependencyPathLink {
  id: string;
  title: string;
  rationale: string;
  overall_confidence: number;
  contributing_holdings: string[];
  exposure_node_id: string | null;
  related_event_ids: string[];
}

export interface PortfolioRiskItem {
  title: string;
  rationale: string;
  severity: "info" | "watch" | "elevated" | "critical";
  confidence: number;
  exposure_node_id: string | null;
  related_event_ids: string[];
}

export interface PortfolioLinkedEvent {
  event_id: string;
  title: string;
  type: string;
  severity: SignalSeverity;
  severity_score: number;
  country_code: string | null;
  country_name: string | null;
  source_timestamp: string | null;
  publisher: string | null;
  url: string | null;
  matched_exposure_node_ids: string[];
}

export interface PortfolioEntity {
  id: string;
  name: string;
  primary_country_codes: string[];
  primary_sectors: string[];
  primary_currencies: string[];
}

export interface PortfolioBrief {
  portfolio_id: string;
  name: string;
  base_currency: string;
  generated_at: string;
  holdings_count: number;
  holdings: PortfolioHolding[];
  exposure_summary: PortfolioExposureSummary;
  exposure_graph: ExposureGraph;
  dependency_paths: PortfolioDependencyPathLink[];
  top_risks: PortfolioRiskItem[];
  linked_events: PortfolioLinkedEvent[];
  entity: PortfolioEntity;
  confidence: number;
  notes: string[];
  // ---- Phase 13B addition ----
  valuation_summary: PortfolioValuationSummary | null;
}

// ---- Phase 13B.2 technical snapshot -----------------------------------------

export type TechnicalSignalLevel =
  | "stretched_long"
  | "balanced"
  | "stretched_short";

export type TrendRegime =
  | "above_200"
  | "below_200"
  | "recovering"
  | "breaking_down"
  | "above_50"
  | "below_50"
  | "insufficient_data";

export type SignalAlignment =
  | "aligned"
  | "mixed"
  | "conflicting"
  | "insufficient";

export interface TechnicalSnapshot {
  symbol: string;
  as_of: string;
  currency: string;
  last_close: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  price_vs_sma20: number | null;
  price_vs_sma50: number | null;
  price_vs_sma200: number | null;
  rsi14: number | null;
  realized_vol_30d: number | null;
  trend_regime: TrendRegime;
  technical_signal_level: TechnicalSignalLevel;
  technical_score: number | null;
  technical_notes: string[];
  bullish_tilt_score: number | null;
  bearish_tilt_score: number | null;
  uncertainty_score: number | null;
  signal_alignment: SignalAlignment | null;
}

export interface PortfolioTechnicalResponse {
  portfolio_id: string;
  generated_at: string;
  snapshots: TechnicalSnapshot[];
}

// ---- Phase 13B.3 semantic / event-pressure engine ---------------------------

export type EventPressureLevel = "calm" | "watch" | "elevated" | "critical";

export interface SemanticDriver {
  node_id: string;
  label: string;
  contribution: number;
  rationale: string;
  evidence_ids: string[];
}

export interface SemanticSnapshot {
  holding_id: string;
  symbol: string;
  semantic_score: number;
  event_pressure_level: EventPressureLevel;
  semantic_drivers: SemanticDriver[];
  linked_event_ids: string[];
  confidence: number;
  as_of: string;
  notes: string[];
  // Plan 06 tilt fields — None until engine populates them.
  bullish_tilt_score: number | null;
  bearish_tilt_score: number | null;
  uncertainty_score: number | null;
  signal_alignment: SignalAlignment | null;
}

export interface PortfolioSemanticRollup {
  portfolio_id: string;
  semantic_score: number;
  event_pressure_level: EventPressureLevel;
  top_drivers: SemanticDriver[];
  contributing_event_count: number;
  as_of: string;
  confidence: number;
  // Plan 06 tilt fields — None until engine populates them.
  bullish_tilt_score: number | null;
  bearish_tilt_score: number | null;
  uncertainty_score: number | null;
  signal_alignment: SignalAlignment | null;
}

export interface PortfolioSemanticResponse {
  portfolio_id: string;
  generated_at: string;
  rollup: PortfolioSemanticRollup;
  snapshots: SemanticSnapshot[];
}

// ---- Phase 13B.4 macro risk score ------------------------------------------

export type RiskComponent =
  | "concentration"
  | "fx"
  | "commodity"
  | "chokepoint"
  | "event_severity"
  | "semantic_density";

export interface RiskDriver {
  component: RiskComponent;
  label: string;
  weight: number;
  rationale: string;
  evidence_ids: string[];
}

export interface RiskScoreComponents {
  concentration: number;
  fx: number;
  commodity: number;
  chokepoint: number;
  event_severity: number;
  semantic_density: number;
}

export interface PortfolioMacroRiskScore {
  portfolio_id: string;
  risk_score: number;
  delta_vs_baseline: number;
  drivers: RiskDriver[];
  confidence: number;
  score_components: RiskScoreComponents;
  as_of: string;
  freshness_seconds: number;
  notes: string[];
  // Plan 06 tilt reservation — non-breaking defaults
  bullish_tilt_score: number | null;
  bearish_tilt_score: number | null;
  uncertainty_score: number | null;
  signal_alignment: SignalAlignment | null;
}

export interface PortfolioListResponse {
  total: number;
  items: PortfolioRecord[];
}

export interface PortfolioCreateRequest {
  name: string;
  description?: string | null;
  base_currency?: string;
  notes?: string | null;
  tags?: string[];
  benchmark_symbol?: string | null;
  holdings?: HoldingInput[];
}

export interface PortfolioUpdateRequest {
  name?: string;
  description?: string | null;
  base_currency?: string;
  notes?: string | null;
  tags?: string[];
  benchmark_symbol?: string | null;
}

export interface CsvImportResponse {
  portfolio: PortfolioRecord;
  skipped_rows: { row: number; reason: string }[];
}

export interface WatchlistInput {
  name: string;
  symbols?: string[];
  countries?: string[];
  topics?: string[];
  notes?: string | null;
}

export interface Watchlist {
  id: string;
  name: string;
  symbols: string[];
  countries: string[];
  topics: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface WatchlistListResponse {
  total: number;
  items: Watchlist[];
}

// ---- Phase 13B.5 candle / chart surface -------------------------------------

export type CandleRange = "1d" | "5d" | "1mo" | "3mo" | "6mo" | "1y" | "2y" | "5y";

export interface Candle {
  timestamp: string;        // ISO 8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface HoldingCandlesResponse {
  portfolio_id: string;
  symbol: string;
  range: CandleRange;
  as_of: string | null;
  provider: string;
  candles: Candle[];
}

// Phase 16.7 — universal market candles (no portfolio context). Used by
// the workspace chart dock so any supported symbol can be charted directly.
export interface MarketCandlesResponse {
  symbol: string;
  range: CandleRange;
  as_of: string | null;
  provider: string;
  candles: Candle[];
}

// Phase 17A.1 — deterministic posture contract. Mirrors the backend
// `MarketPosture` model. The agent layer (17A.2) will consume this as
// the *source of truth* for "buy/sell" calls; the LLM may synthesize
// language around these fields but never invent the numbers.
export type PostureLabel =
  | "strong_sell"
  | "sell"
  | "neutral"
  | "buy"
  | "strong_buy";

export type PostureAssetClass =
  | "equities"
  | "fx"
  | "commodities"
  | "futures"
  | "unknown";

export type PostureComponent = "technical" | "semantic" | "macro";

export interface PostureComponents {
  technical: number | null;
  semantic: number | null;
  macro: number | null;
  uncertainty: number;
}

export interface PostureDriver {
  component: PostureComponent;
  label: string;
  signed_contribution: number;
  rationale: string;
  evidence_ids: string[];
}

export interface MarketPostureResponse {
  symbol: string;
  asset_class: PostureAssetClass;
  posture: PostureLabel;
  posture_label: string;
  tilt: number;
  effective_tilt: number;
  confidence: number;
  components: PostureComponents;
  drivers: PostureDriver[];
  caveats: string[];
  freshness_seconds: number | null;
  as_of: string;
  notes: string[];
  // Phase 17A.2 grounding metadata.
  provider: string;
  provider_health: ProviderHealth;
  semantic_pressure: SymbolSemanticPressure | null;
}

// Phase 17A.3 — bounded agentic narrative on top of the deterministic
// posture envelope. ``source: "anthropic"`` means the prose came from
// Claude under guardrails; ``"deterministic"`` means either no LLM was
// configured or guardrails rejected the LLM output and the backend fell
// back to deterministic prose. The frontend uses this to label the
// surface honestly — never to gate functionality.
export type NarrativeSource = "anthropic" | "deterministic";
export type PostureAlignmentCheck = "aligned" | "diverges" | "skipped";

export interface MarketNarrative {
  symbol: string;
  narrative: string;
  cited_driver_ids: string[];
  narrative_caveats: string[];
  posture_alignment_check: PostureAlignmentCheck;
  source: NarrativeSource;
  generated_at: string;
}

export interface MarketNarrativeResponse {
  posture: MarketPostureResponse;
  narrative: MarketNarrative;
}

// Phase 17A.2 — provider + semantic grounding surfaces.

export type ProviderHealth =
  | "live"
  | "degraded"
  | "unsupported"
  | "unconfigured";

export type SemanticDirection = "bullish" | "bearish" | "neutral";

export interface SemanticEventDriver {
  event_id: string;
  title: string;
  publisher: string | null;
  severity_score: number;
  age_hours: number;
  direction: SemanticDirection;
  contribution: number;
  reliability: number;
}

export interface SymbolSemanticPressure {
  symbol: string;
  asset_class: PostureAssetClass;
  semantic_score: number;
  semantic_direction: SemanticDirection;
  semantic_confidence: number;
  matched_event_count: number;
  recency_skew_hours: number | null;
  top_semantic_drivers: SemanticEventDriver[];
  semantic_caveats: string[];
}

// ---- Phase 18D causal chain intelligence ------------------------------------

export type CausalNodeKind =
  | "event"
  | "country"
  | "region"
  | "commodity"
  | "currency"
  | "equity"
  | "sector"
  | "logistics_route"
  | "weather_system"
  | "conflict"
  | "health"
  | "macro_factor"
  | "portfolio";

export type CausalMechanism =
  | "disrupts"
  | "delays"
  | "tightens_supply"
  | "weakens_demand"
  | "increases_risk_premium"
  | "pressures_currency"
  | "raises_input_cost"
  | "affects_exports"
  | "affects_imports"
  | "increases_volatility"
  | "lowers_confidence"
  | "improves_sentiment"
  | "unknown";

export type ImpactDirection = "up" | "down" | "mixed" | "stable" | "unknown";
export type ImpactStrength = "weak" | "moderate" | "strong";

export type ImpactDomain =
  | "oil"
  | "shipping"
  | "weather"
  | "fx"
  | "commodities"
  | "equities"
  | "country_risk"
  | "sector"
  | "portfolio"
  | "logistics"
  | "supply_chain"
  | "macro"
  | "unknown";

export interface CausalNode {
  id: string;
  kind: CausalNodeKind;
  label: string;
  ref_id: string | null;
  country_code: string | null;
  domain: ImpactDomain;
}

export interface CausalEdge {
  from_id: string;
  to_id: string;
  mechanism: CausalMechanism;
  rationale: string;
  confidence: number;
  evidence_ids: string[];
}

export interface CausalChain {
  chain_id: string;
  title: string;
  summary: string;
  nodes: CausalNode[];
  edges: CausalEdge[];
  source_evidence_ids: string[];
  affected_entities: string[];
  affected_symbols: string[];
  affected_domains: ImpactDomain[];
  direction: ImpactDirection;
  strength: ImpactStrength;
  confidence: number;
  score: number;
  rule_id: string;
  rule_prior: number;
  caveats: string[];
}

export interface CausalDriver {
  chain_id: string;
  title: string;
  mechanism: CausalMechanism;
  domain: ImpactDomain;
  direction: ImpactDirection;
  strength: ImpactStrength;
  confidence: number;
  rationale: string;
  evidence_ids: string[];
  caveats: string[];
}

export interface CausalChainSet {
  generated_at: string;
  query: string;
  entity_id: string | null;
  chains: CausalChain[];
  top_drivers: CausalDriver[];
  secondary_drivers: CausalDriver[];
  suppressed_drivers: CausalDriver[];
  caveats: string[];
  provider_health: "live" | "degraded" | "empty";
}

// Phase 19B — portfolio impact linkage (optional, backward compatible).
export type PortfolioExposureType = "direct" | "indirect" | "weak";

export interface ImpactedHolding {
  holding_id: string;
  symbol: string;
  name: string | null;
  asset_type: string | null;
  sector: string | null;
  country_code: string | null;
  weight: number;
  exposure_type: PortfolioExposureType;
  matched_chain_id: string;
  matched_driver_id: string | null;
  matched_symbol: string | null;
  matched_domain: ImpactDomain | null;
  impact_direction: ImpactDirection;
  confidence: number;
  rationale: string;
  caveats: string[];
}

export interface PortfolioImpact {
  generated_at: string;
  portfolio_id: string;
  portfolio_name: string;
  is_demo: boolean;
  holdings_count: number;
  impacted_holdings: ImpactedHolding[];
  matched_chain_ids: string[];
  summary: string;
  caveats: string[];
}

export class IntelligenceApiError extends Error {
  readonly status: number | null;
  readonly endpoint: string;
  constructor(message: string, endpoint: string, status: number | null) {
    super(message);
    this.name = "IntelligenceApiError";
    this.endpoint = endpoint;
    this.status = status;
  }
}
