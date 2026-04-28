// Wave 15C — entity-to-symbol relevance map.
//
// Honest mapping from real-world entities (countries / chokepoints /
// commodities / sectors / currencies) to the tickers, ETFs, and futures
// that historically reprice when those entities are in the news. The map
// is intentionally conservative — every link carries a confidence and a
// short rationale so the panel never claims a tenuous link as fact.
//
// What this file is:
//   - a hand-curated lookup table grounded in published index methodologies
//     and obvious commodity dependencies
//   - meant to be the *bridge* between EventPanel's grounded summary and
//     the multi-asset bottom strip — not a comprehensive risk model
//
// What this file is NOT:
//   - a basket-construction tool
//   - an alpha source
//   - any kind of trade signal
//
// If a query has no entry in the map we return an empty result and the
// caller falls back to soft "may reprice" copy. We'd rather under-claim
// than fabricate.

export type SymbolKind =
  | "etf"
  | "equity"
  | "future"
  | "fx_pair"
  | "index";

export interface SymbolLink {
  symbol: string;
  kind: SymbolKind;
  /** One-line, evidence-backed explanation of why this symbol is exposed. */
  rationale: string;
  /**
   * 0..1 — how confident we are that the link will reprice when the entity
   * is in the news. Anchored loosely:
   *   0.85+ direct constituent / proven historical correlation
   *   0.6   common analyst proxy
   *   0.4   plausible but loose
   */
  confidence: number;
}

export interface EntityQuery {
  countryCode?: string | null;
  /** Free-form sector tag (e.g. "energy", "semiconductors"). */
  sector?: string | null;
  /** Free-form commodity tag (e.g. "crude_oil", "wheat"). */
  commodity?: string | null;
  /** Free-form chokepoint tag (e.g. "red_sea", "strait_of_hormuz"). */
  chokepoint?: string | null;
  /** ISO 4217 currency code (e.g. "EUR", "JPY"). */
  currency?: string | null;
}

export interface EntityRelevance {
  symbols: SymbolLink[];
  /** Aggregate confidence, max of contributing links. */
  confidence: number;
  /** Sources / publishing notes for the rationale strings. */
  sources: string[];
}

const COUNTRY_LINKS: Record<string, SymbolLink[]> = {
  USA: [
    { symbol: "SPY", kind: "etf", rationale: "Broadest US large-cap proxy.", confidence: 0.9 },
    { symbol: "QQQ", kind: "etf", rationale: "US tech-heavy index proxy.", confidence: 0.85 },
    { symbol: "DXY", kind: "index", rationale: "Trade-weighted USD index.", confidence: 0.8 },
  ],
  JPN: [
    { symbol: "EWJ", kind: "etf", rationale: "iShares MSCI Japan — broad equity exposure.", confidence: 0.85 },
    { symbol: "USDJPY", kind: "fx_pair", rationale: "Direct yen translation effect.", confidence: 0.9 },
    { symbol: "7203.T", kind: "equity", rationale: "Toyota — autos exporter, JPY-sensitive.", confidence: 0.7 },
  ],
  DEU: [
    { symbol: "EWG", kind: "etf", rationale: "iShares MSCI Germany — broad equity exposure.", confidence: 0.85 },
    { symbol: "EURUSD", kind: "fx_pair", rationale: "Direct EUR translation effect.", confidence: 0.85 },
    { symbol: "VOW3.DE", kind: "equity", rationale: "VW — autos exporter, EUR-sensitive.", confidence: 0.65 },
  ],
  CHN: [
    { symbol: "FXI", kind: "etf", rationale: "China large-cap proxy.", confidence: 0.8 },
    { symbol: "USDCNH", kind: "fx_pair", rationale: "Offshore renminbi.", confidence: 0.8 },
  ],
  GBR: [
    { symbol: "EWU", kind: "etf", rationale: "iShares MSCI UK.", confidence: 0.8 },
    { symbol: "GBPUSD", kind: "fx_pair", rationale: "Sterling translation effect.", confidence: 0.85 },
  ],
  FRA: [
    { symbol: "EWQ", kind: "etf", rationale: "iShares MSCI France.", confidence: 0.8 },
    { symbol: "EURUSD", kind: "fx_pair", rationale: "EUR translation effect.", confidence: 0.85 },
  ],
  TWN: [
    { symbol: "EWT", kind: "etf", rationale: "iShares MSCI Taiwan — semis-heavy.", confidence: 0.8 },
    { symbol: "TSM", kind: "equity", rationale: "TSMC — global foundry leader.", confidence: 0.85 },
  ],
  KOR: [
    { symbol: "EWY", kind: "etf", rationale: "iShares MSCI South Korea.", confidence: 0.8 },
  ],
  SAU: [
    { symbol: "KSA", kind: "etf", rationale: "iShares MSCI Saudi Arabia.", confidence: 0.7 },
    { symbol: "CL", kind: "future", rationale: "Crude oil futures — Aramco production heart.", confidence: 0.75 },
  ],
  RUS: [
    { symbol: "BZ", kind: "future", rationale: "Brent futures — Russian export benchmark.", confidence: 0.75 },
    { symbol: "NG", kind: "future", rationale: "Natural gas futures — Russian pipeline exposure.", confidence: 0.7 },
  ],
  IND: [
    { symbol: "INDA", kind: "etf", rationale: "iShares MSCI India.", confidence: 0.8 },
  ],
  BRA: [
    { symbol: "EWZ", kind: "etf", rationale: "iShares MSCI Brazil.", confidence: 0.8 },
    { symbol: "ZS", kind: "future", rationale: "Soybean — Brazil major exporter.", confidence: 0.7 },
  ],
  MAR: [
    { symbol: "AFK", kind: "etf", rationale: "VanEck Africa — Morocco constituent exposure.", confidence: 0.5 },
  ],
  AUS: [
    { symbol: "EWA", kind: "etf", rationale: "iShares MSCI Australia.", confidence: 0.8 },
    { symbol: "AUDUSD", kind: "fx_pair", rationale: "AUD translation effect.", confidence: 0.85 },
  ],
};

const COMMODITY_LINKS: Record<string, SymbolLink[]> = {
  crude_oil: [
    { symbol: "CL", kind: "future", rationale: "WTI crude futures.", confidence: 0.95 },
    { symbol: "BZ", kind: "future", rationale: "Brent crude futures.", confidence: 0.95 },
    { symbol: "USO", kind: "etf", rationale: "United States Oil Fund.", confidence: 0.85 },
  ],
  oil: [
    { symbol: "CL", kind: "future", rationale: "WTI crude futures.", confidence: 0.95 },
    { symbol: "BZ", kind: "future", rationale: "Brent crude futures.", confidence: 0.95 },
  ],
  natural_gas: [
    { symbol: "NG", kind: "future", rationale: "Henry Hub natural gas futures.", confidence: 0.95 },
    { symbol: "UNG", kind: "etf", rationale: "United States Natural Gas Fund.", confidence: 0.8 },
  ],
  gold: [
    { symbol: "GC", kind: "future", rationale: "COMEX gold futures.", confidence: 0.95 },
    { symbol: "GLD", kind: "etf", rationale: "SPDR Gold Shares.", confidence: 0.9 },
  ],
  copper: [
    { symbol: "HG", kind: "future", rationale: "COMEX copper futures.", confidence: 0.95 },
  ],
  wheat: [
    { symbol: "ZW", kind: "future", rationale: "CBOT wheat futures.", confidence: 0.95 },
  ],
  corn: [
    { symbol: "ZC", kind: "future", rationale: "CBOT corn futures.", confidence: 0.95 },
  ],
  fertilizer: [
    { symbol: "MOO", kind: "etf", rationale: "VanEck Agribusiness — fertilizer exposure.", confidence: 0.6 },
  ],
};

const SECTOR_LINKS: Record<string, SymbolLink[]> = {
  energy: [
    { symbol: "XLE", kind: "etf", rationale: "Energy Select Sector SPDR.", confidence: 0.9 },
  ],
  semiconductors: [
    { symbol: "SOXX", kind: "etf", rationale: "iShares Semiconductor ETF.", confidence: 0.9 },
    { symbol: "NVDA", kind: "equity", rationale: "Largest semis market cap.", confidence: 0.7 },
    { symbol: "TSM", kind: "equity", rationale: "Global foundry leader.", confidence: 0.7 },
  ],
  semis: [
    { symbol: "SOXX", kind: "etf", rationale: "iShares Semiconductor ETF.", confidence: 0.9 },
  ],
  shipping: [
    { symbol: "SEA", kind: "etf", rationale: "U.S. Global Sea to Sky Cargo ETF.", confidence: 0.7 },
  ],
  airlines: [
    { symbol: "JETS", kind: "etf", rationale: "U.S. Global Jets ETF.", confidence: 0.85 },
  ],
  aerospace: [
    { symbol: "ITA", kind: "etf", rationale: "iShares Aerospace & Defense.", confidence: 0.85 },
  ],
  defense: [
    { symbol: "ITA", kind: "etf", rationale: "iShares Aerospace & Defense.", confidence: 0.85 },
  ],
  agriculture: [
    { symbol: "MOO", kind: "etf", rationale: "VanEck Agribusiness ETF.", confidence: 0.7 },
  ],
  banks: [
    { symbol: "XLF", kind: "etf", rationale: "Financial Select Sector SPDR.", confidence: 0.85 },
  ],
  technology: [
    { symbol: "XLK", kind: "etf", rationale: "Technology Select Sector SPDR.", confidence: 0.85 },
  ],
  autos: [
    { symbol: "CARZ", kind: "etf", rationale: "Global Auto ETF (where available).", confidence: 0.6 },
  ],
};

const CHOKEPOINT_LINKS: Record<string, SymbolLink[]> = {
  red_sea: [
    { symbol: "BZ", kind: "future", rationale: "Brent rerouting via Cape adds tonne-miles.", confidence: 0.75 },
    { symbol: "SEA", kind: "etf", rationale: "Maritime shipping rates exposure.", confidence: 0.7 },
  ],
  suez_canal: [
    { symbol: "BZ", kind: "future", rationale: "Brent rerouting risk.", confidence: 0.75 },
    { symbol: "SEA", kind: "etf", rationale: "Maritime shipping rates exposure.", confidence: 0.7 },
  ],
  strait_of_hormuz: [
    { symbol: "CL", kind: "future", rationale: "20% of seaborne crude transits Hormuz.", confidence: 0.85 },
    { symbol: "BZ", kind: "future", rationale: "Brent benchmark direct exposure.", confidence: 0.85 },
  ],
  panama_canal: [
    { symbol: "SEA", kind: "etf", rationale: "Container freight rate exposure.", confidence: 0.7 },
  ],
  bosphorus: [
    { symbol: "ZW", kind: "future", rationale: "Black Sea grain corridor exposure.", confidence: 0.7 },
  ],
};

const CURRENCY_LINKS: Record<string, SymbolLink[]> = {
  USD: [{ symbol: "DXY", kind: "index", rationale: "Trade-weighted dollar index.", confidence: 0.85 }],
  EUR: [{ symbol: "EURUSD", kind: "fx_pair", rationale: "Major euro cross.", confidence: 0.9 }],
  JPY: [{ symbol: "USDJPY", kind: "fx_pair", rationale: "Major yen cross.", confidence: 0.9 }],
  GBP: [{ symbol: "GBPUSD", kind: "fx_pair", rationale: "Major sterling cross.", confidence: 0.9 }],
  CHF: [{ symbol: "USDCHF", kind: "fx_pair", rationale: "Major franc cross.", confidence: 0.9 }],
  AUD: [{ symbol: "AUDUSD", kind: "fx_pair", rationale: "Major aussie cross.", confidence: 0.9 }],
  CAD: [{ symbol: "USDCAD", kind: "fx_pair", rationale: "Major loonie cross.", confidence: 0.9 }],
  CNH: [{ symbol: "USDCNH", kind: "fx_pair", rationale: "Offshore renminbi cross.", confidence: 0.85 }],
  CNY: [{ symbol: "USDCNH", kind: "fx_pair", rationale: "Offshore renminbi proxy for onshore CNY.", confidence: 0.75 }],
};

const SOURCE_NOTES: Record<string, string> = {
  country: "Index constituents from MSCI / S&P methodology docs",
  commodity: "Front-month futures conventions (CME / ICE)",
  sector: "Sector ETF methodology (SPDR / iShares)",
  chokepoint: "USEIA chokepoint reports + maritime trade flow data",
  currency: "Conventional FX major / cross definitions",
};

/**
 * Look up the relevant tickers for an entity query. Returns an empty
 * result (rather than fabricating) when no entry matches.
 */
export function mapEntityToSymbols(query: EntityQuery): EntityRelevance {
  const out = new Map<string, SymbolLink>();
  const sources = new Set<string>();

  if (query.countryCode) {
    const links = COUNTRY_LINKS[query.countryCode.toUpperCase()];
    if (links) {
      for (const link of links) addUnique(out, link);
      sources.add(SOURCE_NOTES.country);
    }
  }
  if (query.commodity) {
    const links = COMMODITY_LINKS[normalizeKey(query.commodity)];
    if (links) {
      for (const link of links) addUnique(out, link);
      sources.add(SOURCE_NOTES.commodity);
    }
  }
  if (query.sector) {
    const links = SECTOR_LINKS[normalizeKey(query.sector)];
    if (links) {
      for (const link of links) addUnique(out, link);
      sources.add(SOURCE_NOTES.sector);
    }
  }
  if (query.chokepoint) {
    const links = CHOKEPOINT_LINKS[normalizeKey(query.chokepoint)];
    if (links) {
      for (const link of links) addUnique(out, link);
      sources.add(SOURCE_NOTES.chokepoint);
    }
  }
  if (query.currency) {
    const links = CURRENCY_LINKS[query.currency.toUpperCase()];
    if (links) {
      for (const link of links) addUnique(out, link);
      sources.add(SOURCE_NOTES.currency);
    }
  }

  const symbols = Array.from(out.values()).sort(
    (a, b) => b.confidence - a.confidence,
  );
  const confidence =
    symbols.length === 0
      ? 0
      : symbols.reduce((max, link) => Math.max(max, link.confidence), 0);
  return { symbols, confidence, sources: Array.from(sources) };
}

/**
 * Convenience: compact human-readable string of the top three symbols
 * for use in panel copy. Returns null when the lookup is empty.
 */
export function summariseEntityRelevance(query: EntityQuery): string | null {
  const result = mapEntityToSymbols(query);
  if (result.symbols.length === 0) return null;
  const top = result.symbols.slice(0, 3);
  const labels = top.map((s) => s.symbol).join(", ");
  return `${labels} (top ${top.length} of ${result.symbols.length} mapped, max confidence ${Math.round(result.confidence * 100)}%)`;
}

function addUnique(out: Map<string, SymbolLink>, link: SymbolLink): void {
  const existing = out.get(link.symbol);
  if (!existing || link.confidence > existing.confidence) {
    out.set(link.symbol, link);
  }
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}
