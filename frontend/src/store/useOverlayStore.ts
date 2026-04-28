import { create } from "zustand";

import type {
  AgentResponse,
  CompareResponse,
  CountryDetailResponse,
  PortfolioBrief,
  PortfolioMacroRiskScore,
  PortfolioRecord,
  PortfolioSemanticResponse,
  SearchResponse,
  SignalEvent,
  TechnicalSnapshot,
} from "@/lib/intelligence/types";

export type OverlayMode =
  | "idle"
  | "country"
  | "event"
  | "query"
  | "compare"
  | "portfolio";
export type FocusIntent =
  | "globe-click"
  | "search"
  | "signal-strip"
  | "stocks-strip"
  | "deep-link"
  | "compare"
  | "portfolio";

export interface CompareTargetSelection {
  kind: "country" | "event";
  id: string;
  label: string;
  country_code: string | null;
}

export const MAX_COMPARE_TARGETS = 3;

export interface OverlayState {
  isOpen: boolean;
  mode: OverlayMode;

  selectedCountryCode: string | null;
  selectedCountryName: string | null;
  countryDetail: CountryDetailResponse | null;

  selectedEventId: string | null;
  selectedEvent: SignalEvent | null;

  queryText: string;
  queryResults: SearchResponse | null;
  agentResponse: AgentResponse | null;

  compareTargets: CompareTargetSelection[];
  compareResponse: CompareResponse | null;

  selectedPortfolioId: string | null;
  selectedPortfolio: PortfolioRecord | null;
  portfolioBrief: PortfolioBrief | null;
  portfolioTechnical: TechnicalSnapshot[] | null;
  portfolioSemantic: PortfolioSemanticResponse | null;
  portfolioRiskScore: PortfolioMacroRiskScore | null;
  selectedHoldingSymbol: string | null;
  portfolioAsOf: string | null; // ISO 8601 or null = live

  latestSignals: SignalEvent[];
  latestStocks: SignalEvent[];
  // Wave 15B — multi-asset bottom strip baskets. Kept alongside latestStocks
  // so the strip can render equities/FX/commodities groups without spinning
  // up a parallel store. Polling lives in useIntelligenceFeeds.
  latestFx: SignalEvent[];
  latestCommodities: SignalEvent[];

  // Phase 16.6 — selected market entity. Set when an analyst clicks a
  // ticker in the lower tape OR a market signal in the right panel. Drives
  // (a) tape highlight, (b) chart dock visibility, (c) right-panel sync.
  // Independent of `selectedEventId` so the chart dock can persist when
  // the user navigates around the panel.
  selectedMarketSymbol: string | null;
  selectedMarketAssetClass:
    | "equities"
    | "fx"
    | "commodities"
    | "futures"
    | null;

  isLoading: boolean;
  error: string | null;

  focusIntent: FocusIntent | null;
  lastUpdated: string | null;

  openCountry: (code: string, name?: string, intent?: FocusIntent) => void;
  setCountryDetail: (detail: CountryDetailResponse) => void;
  openEvent: (event: SignalEvent, intent?: FocusIntent) => void;
  openQuery: (query: string, results?: SearchResponse, intent?: FocusIntent) => void;
  setQueryResults: (results: SearchResponse) => void;
  setAgentResponse: (response: AgentResponse | null) => void;
  clearAgentResponse: () => void;

  addCompareTarget: (target: CompareTargetSelection) => void;
  /**
   * Phase 17A.3 — auto-add for Compare mode. Same dedupe semantics as
   * `addCompareTarget`, but when the set is already at MAX we drop the
   * oldest entry and append the new one. The intended flow is: user
   * enters Compare mode, clicks two countries on the globe in sequence,
   * and a side-by-side build kicks off without a manual "Add" pivot.
   */
  pushCompareTarget: (target: CompareTargetSelection) => void;
  removeCompareTarget: (id: string) => void;
  clearCompareTargets: () => void;
  openCompare: () => void;
  setCompareResponse: (response: CompareResponse | null) => void;

  openPortfolio: (portfolioId: string, portfolio?: PortfolioRecord, intent?: FocusIntent) => void;
  setPortfolioRecord: (portfolio: PortfolioRecord) => void;
  setPortfolioBrief: (brief: PortfolioBrief | null) => void;
  setPortfolioTechnical: (snapshots: TechnicalSnapshot[] | null) => void;
  setPortfolioSemantic: (payload: PortfolioSemanticResponse | null) => void;
  setPortfolioRiskScore: (score: PortfolioMacroRiskScore | null) => void;
  clearPortfolio: () => void;
  setSelectedHoldingSymbol: (symbol: string | null) => void;
  setPortfolioAsOf: (asOf: string | null) => void;

  closeOverlay: () => void;

  setLatestSignals: (events: SignalEvent[]) => void;
  setLatestStocks: (events: SignalEvent[]) => void;
  setLatestFx: (events: SignalEvent[]) => void;
  setLatestCommodities: (events: SignalEvent[]) => void;

  selectMarketSymbol: (
    symbol: string | null,
    assetClass?: "equities" | "fx" | "commodities" | "futures" | null,
  ) => void;

  setLoading: (value: boolean) => void;
  setError: (message: string | null) => void;
  setFocusIntent: (intent: FocusIntent | null) => void;
}

function now(): string {
  return new Date().toISOString();
}

interface MarketSymbolHint {
  symbol: string;
  assetClass: "equities" | "fx" | "commodities" | "futures";
}

const FUTURES_SYMBOLS = new Set([
  "ES",
  "NQ",
  "YM",
  "RTY",
  "VX",
  "ZN",
  "ZF",
  "ZB",
  "FF",
]);

function resolveMarketSymbolFromEvent(
  event: SignalEvent,
): MarketSymbolHint | null {
  const props = event.properties ?? {};
  const symbolRaw =
    typeof props.symbol === "string"
      ? props.symbol
      : typeof props.pair === "string"
        ? props.pair
        : typeof props.commodity === "string"
          ? props.commodity
          : null;
  if (!symbolRaw) return null;
  const symbol = symbolRaw.toUpperCase();
  switch (event.type) {
    case "stocks":
    case "markets":
      return {
        symbol,
        assetClass: FUTURES_SYMBOLS.has(symbol) ? "futures" : "equities",
      };
    case "currency":
      return { symbol, assetClass: "fx" };
    case "commodities":
      return {
        symbol,
        assetClass: FUTURES_SYMBOLS.has(symbol) ? "futures" : "commodities",
      };
    default:
      return null;
  }
}

export const useOverlayStore = create<OverlayState>((set) => ({
  isOpen: false,
  mode: "idle",

  selectedCountryCode: null,
  selectedCountryName: null,
  countryDetail: null,

  selectedEventId: null,
  selectedEvent: null,

  queryText: "",
  queryResults: null,
  agentResponse: null,

  compareTargets: [],
  compareResponse: null,

  selectedPortfolioId: null,
  selectedPortfolio: null,
  portfolioBrief: null,
  portfolioTechnical: null,
  portfolioSemantic: null,
  portfolioRiskScore: null,
  selectedHoldingSymbol: null,
  portfolioAsOf: null,

  latestSignals: [],
  latestStocks: [],
  latestFx: [],
  latestCommodities: [],

  selectedMarketSymbol: null,
  selectedMarketAssetClass: null,

  isLoading: false,
  error: null,

  focusIntent: null,
  lastUpdated: null,

  openCountry: (code, name, intent = "deep-link") =>
    set({
      isOpen: true,
      mode: "country",
      selectedCountryCode: code.toUpperCase(),
      selectedCountryName: name ?? null,
      countryDetail: null,
      selectedEventId: null,
      selectedEvent: null,
      isLoading: true,
      error: null,
      focusIntent: intent,
      lastUpdated: now(),
    }),

  setCountryDetail: (detail) =>
    set({
      countryDetail: detail,
      selectedCountryName: detail.summary.country_name,
      isLoading: false,
      error: null,
      lastUpdated: now(),
    }),

  openEvent: (event, intent = "signal-strip") => {
    // Phase 16.7 — auto-promote market events into the first-class
    // selectedMarketSymbol slot so the chart dock, tape highlight, and
    // right panel all lock onto the same symbol from a single click.
    const marketHint = resolveMarketSymbolFromEvent(event);
    set({
      isOpen: true,
      mode: "event",
      selectedEventId: event.id,
      selectedEvent: event,
      selectedCountryCode: event.place.country_code ?? null,
      selectedCountryName: event.place.country_name ?? null,
      countryDetail: null,
      selectedMarketSymbol: marketHint?.symbol ?? null,
      selectedMarketAssetClass: marketHint?.assetClass ?? null,
      isLoading: false,
      error: null,
      focusIntent: intent,
      lastUpdated: now(),
    });
  },

  openQuery: (query, results, intent = "search") =>
    set({
      isOpen: true,
      mode: "query",
      queryText: query,
      queryResults: results ?? null,
      agentResponse: null,
      isLoading: results === undefined,
      error: null,
      focusIntent: intent,
      lastUpdated: now(),
    }),

  setQueryResults: (results) =>
    set({
      queryResults: results,
      isLoading: false,
      error: null,
      lastUpdated: now(),
    }),

  setAgentResponse: (response) =>
    set({
      agentResponse: response,
      isLoading: false,
      error: null,
      lastUpdated: now(),
    }),

  clearAgentResponse: () => set({ agentResponse: null }),

  addCompareTarget: (target) =>
    set((state) => {
      if (state.compareTargets.some((t) => t.id === target.id)) return state;
      if (state.compareTargets.length >= MAX_COMPARE_TARGETS) return state;
      return {
        compareTargets: [...state.compareTargets, target],
        lastUpdated: now(),
      };
    }),

  pushCompareTarget: (target) =>
    set((state) => {
      if (state.compareTargets.some((t) => t.id === target.id)) return state;
      const next =
        state.compareTargets.length >= MAX_COMPARE_TARGETS
          ? [...state.compareTargets.slice(1), target]
          : [...state.compareTargets, target];
      return {
        compareTargets: next,
        lastUpdated: now(),
      };
    }),

  removeCompareTarget: (id) =>
    set((state) => ({
      compareTargets: state.compareTargets.filter((t) => t.id !== id),
      lastUpdated: now(),
    })),

  clearCompareTargets: () =>
    set({ compareTargets: [], compareResponse: null }),

  openCompare: () =>
    set((state) => ({
      isOpen: true,
      mode: "compare",
      isLoading: state.compareTargets.length >= 2,
      error: null,
      focusIntent: "compare",
      lastUpdated: now(),
    })),

  setCompareResponse: (response) =>
    set({
      compareResponse: response,
      isLoading: false,
      error: null,
      lastUpdated: now(),
    }),

  openPortfolio: (portfolioId, portfolio, intent = "portfolio") =>
    set({
      isOpen: true,
      mode: "portfolio",
      selectedPortfolioId: portfolioId,
      selectedPortfolio: portfolio ?? null,
      portfolioBrief: null,
      portfolioTechnical: null,
      portfolioSemantic: null,
      portfolioRiskScore: null,
      selectedHoldingSymbol: null,
      portfolioAsOf: null,
      isLoading: portfolio === undefined,
      error: null,
      focusIntent: intent,
      lastUpdated: now(),
    }),

  setPortfolioRecord: (portfolio) =>
    set({
      selectedPortfolio: portfolio,
      selectedPortfolioId: portfolio.id,
      lastUpdated: now(),
    }),

  setPortfolioBrief: (brief) =>
    set({
      portfolioBrief: brief,
      isLoading: false,
      error: null,
      lastUpdated: now(),
    }),

  setPortfolioTechnical: (snapshots) =>
    set({
      portfolioTechnical: snapshots,
      lastUpdated: now(),
    }),

  setPortfolioSemantic: (payload) =>
    set({
      portfolioSemantic: payload,
      lastUpdated: now(),
    }),

  setPortfolioRiskScore: (score) =>
    set({
      portfolioRiskScore: score,
      lastUpdated: now(),
    }),

  clearPortfolio: () =>
    set({
      selectedPortfolioId: null,
      selectedPortfolio: null,
      portfolioBrief: null,
      portfolioTechnical: null,
      portfolioSemantic: null,
      portfolioRiskScore: null,
      selectedHoldingSymbol: null,
      portfolioAsOf: null,
    }),

  setPortfolioAsOf: (asOf) => set({ portfolioAsOf: asOf }),

  closeOverlay: () =>
    set({
      isOpen: false,
      mode: "idle",
      selectedEventId: null,
      selectedEvent: null,
      countryDetail: null,
      queryResults: null,
      queryText: "",
      agentResponse: null,
      compareResponse: null,
      selectedPortfolioId: null,
      selectedPortfolio: null,
      portfolioBrief: null,
      portfolioTechnical: null,
      portfolioSemantic: null,
      portfolioRiskScore: null,
      selectedHoldingSymbol: null,
      portfolioAsOf: null,
      selectedMarketSymbol: null,
      selectedMarketAssetClass: null,
      isLoading: false,
      error: null,
      focusIntent: null,
    }),

  setLatestSignals: (events) =>
    set({
      latestSignals: events,
      lastUpdated: now(),
    }),

  setLatestStocks: (events) =>
    set({
      latestStocks: events,
      lastUpdated: now(),
    }),

  setLatestFx: (events) =>
    set({
      latestFx: events,
      lastUpdated: now(),
    }),

  setLatestCommodities: (events) =>
    set({
      latestCommodities: events,
      lastUpdated: now(),
    }),

  setSelectedHoldingSymbol: (symbol) =>
    set({ selectedHoldingSymbol: symbol, lastUpdated: now() }),

  selectMarketSymbol: (symbol, assetClass = null) =>
    set({
      selectedMarketSymbol: symbol ? symbol.toUpperCase() : null,
      selectedMarketAssetClass: symbol ? assetClass : null,
      lastUpdated: now(),
    }),

  setLoading: (value) => set({ isLoading: value }),
  setError: (message) => set({ error: message, isLoading: false }),
  setFocusIntent: (intent) => set({ focusIntent: intent }),
}));

export function pickCountryFromSelection(iso3: string | null): string | null {
  if (!iso3) return null;
  const trimmed = iso3.trim().toUpperCase();
  return trimmed || null;
}
