"use client";

import { useMemo } from "react";

import { mapEntityToSymbols, type EntityRelevance } from "@/lib/intelligence/entitySymbolMap";
import {
  computeAllWindowDeltas,
  describePostureDrift,
} from "@/lib/intelligence/trends";
import { summariseChangesSince } from "@/lib/intelligence/timeline";
import { useOverlayStore } from "@/store/useOverlayStore";

import { categoryToDomain, DomainIcon, DOMAIN_LABEL } from "./DomainIcon";
import {
  SEVERITY_LABEL,
  categoryLabel,
  countryTagFromEvent,
  formatConfidence,
  formatRelative,
  formatUtc,
} from "./formatters";
import { DependencySection } from "./DependencySection";
import { MarketChart } from "./MarketChart";
import { MarketPostureCard } from "./MarketPostureCard";
import { MarketSnapshot } from "./MarketSnapshot";
import { OverlayPanel } from "./OverlayPanel";
import { PortfolioHoldingChart } from "./PortfolioHoldingChart";
import { SourceList } from "./SourceList";
import { PanelReveal } from "./motion/PanelReveal";
import {
  ChangesSinceLine,
  GrammarSection,
  MetadataStrip,
  PostureChip,
  ReplayBadge,
  TrendStrip,
  type MetadataField,
} from "./grammar/SignalGrammar";

// Wave 15B established the panel grammar.
// Wave 15C lifts the primitives into `grammar/SignalGrammar` so the rest
// of the workspace can share the same vocabulary, then layers in:
//
//   - workspace-wide replay coherence via `portfolioAsOf` reads
//   - trend windows (24h / 7d / 30d) computed against the same event stream
//   - posture drift one-liner derived from the 7d window
//   - "what changed since" summary for the active window
//   - entity-to-symbol relevance lookup so the market-relevance section can
//     name actual tickers/futures rather than soft "may reprice" copy
//
// The legacy `data-testid="signal-grammar-*"` and `data-grammar-field`
// attributes are preserved so 15B contract tests stay green.

export function EventPanel() {
  const event = useOverlayStore((s) => s.selectedEvent);
  const openCountry = useOverlayStore((s) => s.openCountry);
  const addCompareTarget = useOverlayStore((s) => s.addCompareTarget);
  const openCompare = useOverlayStore((s) => s.openCompare);
  const compareTargets = useOverlayStore((s) => s.compareTargets);
  const latestSignals = useOverlayStore((s) => s.latestSignals);
  const asOf = useOverlayStore((s) => s.portfolioAsOf);
  const activePortfolio = useOverlayStore((s) => s.selectedPortfolio);
  const activePortfolioId = useOverlayStore((s) => s.selectedPortfolioId);
  const selectedMarketSymbol = useOverlayStore((s) => s.selectedMarketSymbol);

  const domain = useMemo(() => {
    if (!event) return null;
    return categoryToDomain(event.type);
  }, [event]);

  // Trend windows are computed against the rail's latest signals filtered
  // to the same domain so the analyst sees movement *for this kind of
  // signal* rather than across the whole feed. Cheap; pure.
  const domainSignals = useMemo(() => {
    if (!event) return [];
    return latestSignals.filter((s) => s.type === event.type);
  }, [event, latestSignals]);

  const trendDeltas = useMemo(
    () => computeAllWindowDeltas(domainSignals, asOf),
    [domainSignals, asOf],
  );

  const posture = useMemo(
    () => describePostureDrift(trendDeltas["7d"]),
    [trendDeltas],
  );

  const changesSince = useMemo(
    () => summariseChangesSince(domainSignals, "24h", asOf),
    [domainSignals, asOf],
  );

  const countryHint = event
    ? event.place.country_code ?? countryTagFromEvent(event.tags)
    : null;

  const relevance = useMemo<EntityRelevance>(() => {
    if (!event) return { symbols: [], confidence: 0, sources: [] };
    return mapEntityToSymbols({
      countryCode: event.place.country_code ?? countryHint ?? null,
      commodity: extractCommodity(event),
      sector: extractSector(event),
      chokepoint: extractChokepoint(event),
      currency: extractCurrency(event),
    });
  }, [event, countryHint]);

  if (!event) {
    return (
      <OverlayPanel eyebrow="Signal intelligence" title="No event selected">
        <p className="ws-muted">Select a signal from the strip or globe to inspect.</p>
      </OverlayPanel>
    );
  }

  const placeLine = [
    event.place.country_name ?? countryHint,
    event.place.locality,
    event.place.region,
  ]
    .filter(Boolean)
    .join(" · ") || "Unplaced";

  const marketRelevance = buildMarketRelevance(event, relevance);
  const technicalRead = buildTechnicalRead(event);

  const metaFields: MetadataField[] = [
    {
      key: "domain",
      label: "Domain",
      value: domain ? (
        <span className="ws-grammar__domain-badge">
          <DomainIcon domain={domain} size={12} />
          <span>{DOMAIN_LABEL[domain]}</span>
        </span>
      ) : (
        <span className="ws-grammar__domain-badge ws-grammar__domain-badge--other">
          {categoryLabel(event.type)}
        </span>
      ),
    },
    {
      key: "severity",
      label: "Severity",
      value: (
        <span className={`ws-chip ws-chip--${event.severity}`}>
          {SEVERITY_LABEL[event.severity]} · {Math.round(event.severity_score * 100)}
        </span>
      ),
    },
    {
      key: "confidence",
      label: "Confidence",
      value: formatConfidence(event.confidence),
    },
    {
      key: "freshness",
      label: "Freshness",
      value: (
        <span title={formatUtc(event.source_timestamp)}>
          {formatRelative(event.source_timestamp)}
        </span>
      ),
    },
    { key: "status", label: "Status", value: event.status },
  ];

  // Phase 17A.2 — for market-class events the chart + posture are the
  // dominant visual signal. Lift them to the top of the panel so the
  // operator reads "what's it doing now / buy-sell call / why" before
  // skimming domain/severity/confidence metadata.
  const marketSymbol = resolveMarketSymbol(event, selectedMarketSymbol);
  const isMarketEvent = marketSymbol !== null;
  const heldSymbol = isMarketEvent
    ? findHeldSymbol(activePortfolio, marketSymbol!)
    : null;
  const props = event.properties ?? {};
  const last = asNumber(props.price) ?? asNumber(props.last);
  const prev = asNumber(props.previous_close);
  const dayLow = asNumber(props.day_low) ?? asNumber(props.low);
  const dayHigh = asNumber(props.day_high) ?? asNumber(props.high);
  const pct = asNumber(props.change_pct);
  const postureAssetClass = isMarketEvent
    ? marketAssetClassFor(event.type)
    : null;

  return (
    <OverlayPanel
      eyebrow={`${categoryLabel(event.type)} signal`}
      title={event.title}
      subtitle={`${SEVERITY_LABEL[event.severity]} · ${formatRelative(event.source_timestamp ?? event.ingested_at)}`}
    >
      <PanelReveal testId="event-panel-reveal">
      {/* Phase 17A.2 — market hero: chart + posture pinned at the top
          for market-class events so the buy/sell call lands first. */}
      {isMarketEvent && marketSymbol ? (
        <section
          className="ws-section ws-section--market-hero"
          data-testid="event-panel-market-hero"
          data-symbol={marketSymbol}
        >
          <MarketSnapshot
            symbol={marketSymbol}
            last={last}
            previousClose={prev}
            dayLow={dayLow}
            dayHigh={dayHigh}
            changePct={pct}
          />
          <div data-testid="event-panel-chart">
            <MarketChart
              symbol={marketSymbol}
              asOf={asOf}
              height={220}
              testId="event-panel-market-chart"
              hideUnavailable
            />
          </div>
          <MarketPostureCard
            symbol={marketSymbol}
            assetClass={postureAssetClass}
            asOf={asOf}
            testId="event-panel-posture"
          />
          {heldSymbol && activePortfolioId ? (
            <div
              className="ws-chart-callout ws-chart-callout--compare"
              data-testid="event-panel-portfolio-compare"
            >
              <p className="ws-section__body">
                <strong>{marketSymbol}</strong> is part of your open
                portfolio — the chart below overlays portfolio-linked
                events as ground-truth context.
              </p>
              <PortfolioHoldingChart
                portfolioId={activePortfolioId}
                symbol={heldSymbol}
                asOf={asOf}
                height={220}
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Section 1-5: header metadata strip — domain · severity · confidence · freshness · status */}
      <MetadataStrip fields={metaFields} />

      {/* Wave 15C — replay coherence + trend windows */}
      <section
        className="ws-section ws-grammar-trend-row"
        data-testid="signal-grammar-trend"
        data-grammar-section="trend"
      >
        <div className="ws-grammar-trend-row__head">
          <ReplayBadge asOf={asOf} testId="event-panel-replay-badge" />
          <PostureChip posture={posture.posture} copy={posture.copy} />
        </div>
        <TrendStrip deltas={trendDeltas} />
        <ChangesSinceLine summary={changesSince} isReplay={Boolean(asOf)} />
      </section>

      {/* Section 6: geography */}
      <GrammarSection field="place" title="Geography">
        <p className="ws-section__body">{placeLine}</p>
        {event.place.latitude !== null && event.place.longitude !== null ? (
          <p className="ws-muted ws-muted--mono">
            {event.place.latitude.toFixed(2)}, {event.place.longitude.toFixed(2)}
          </p>
        ) : null}
      </GrammarSection>

      {/* Section 7: summary */}
      <GrammarSection field="summary" title="Summary">
        <p className="ws-section__body">{event.summary || event.title}</p>
      </GrammarSection>

      {/* Section 8: why it matters */}
      <GrammarSection field="why" title="Why it matters">
        <p className="ws-section__body">{buildRationale(event, posture.copy)}</p>
      </GrammarSection>

      {/* Section 9: linked entities */}
      {event.entities.length > 0 ? (
        <GrammarSection field="entities" title="Linked entities">
          <ul className="ws-entity-list">
            {event.entities.map((entity) => (
              <li key={entity.entity_id} className="ws-entity">
                <span className="ws-entity__label">{entity.name}</span>
                <span className="ws-entity__meta">
                  {entity.entity_type}
                  {entity.country_code ? ` · ${entity.country_code}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </GrammarSection>
      ) : null}

      {/* Section 10: market relevance — only when there is a real market read */}
      {marketRelevance ? (
        <GrammarSection field="market" title="Market relevance">
          <p className="ws-section__body">{marketRelevance}</p>
          {relevance.symbols.length > 0 ? (
            <ul
              className="ws-grammar__symbol-list"
              data-testid="signal-grammar-market-symbols"
            >
              {relevance.symbols.slice(0, 6).map((link) => (
                <li
                  key={link.symbol}
                  className={`ws-grammar__symbol ws-grammar__symbol--${link.kind}`}
                  title={`${link.rationale} · confidence ${Math.round(link.confidence * 100)}%`}
                  data-symbol={link.symbol}
                  data-symbol-kind={link.kind}
                >
                  <span className="ws-grammar__symbol-tick">{link.symbol}</span>
                  <span className="ws-grammar__symbol-meta">
                    {link.kind} · {Math.round(link.confidence * 100)}%
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {relevance.sources.length > 0 ? (
            <p className="ws-muted ws-grammar__symbol-source">
              Mapping basis: {relevance.sources.join(" · ")}
            </p>
          ) : null}
        </GrammarSection>
      ) : null}

      {/* Section 11: technical posture — only when quantitative */}
      {technicalRead ? (
        <GrammarSection field="technical" title="Technical posture">
          <dl className="ws-meta ws-meta--grid ws-grammar__technical">
            {technicalRead.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </GrammarSection>
      ) : null}

      <DependencySection eventId={event.id} />

      {/* Section 13: sources */}
      <GrammarSection field="sources" title="Sources">
        <SourceList sources={event.sources} />
      </GrammarSection>

      {/* Section 14: pivots */}
      <section
        className="ws-section ws-section--pivots"
        data-grammar-section="pivots"
      >
        <h3 className="ws-section__title">Suggested pivots</h3>
        <div className="ws-pivots">
          {countryHint ? (
            <button
              type="button"
              className="ws-pivot"
              onClick={() =>
                openCountry(countryHint, event.place.country_name ?? undefined, "deep-link")
              }
            >
              <span className="ws-pivot__label">Open country context</span>
              <span className="ws-pivot__hint">
                {event.place.country_name ?? countryHint}
              </span>
            </button>
          ) : null}
          <button
            type="button"
            className="ws-pivot"
            disabled={compareTargets.some((t) => t.id === `event:${event.id}`)}
            onClick={() => {
              addCompareTarget({
                kind: "event",
                id: `event:${event.id}`,
                label: event.title,
                country_code: event.place.country_code,
              });
            }}
          >
            <span className="ws-pivot__label">Add to compare</span>
            <span className="ws-pivot__hint">
              {compareTargets.some((t) => t.id === `event:${event.id}`)
                ? "Already in compare set"
                : `${compareTargets.length}/3 selected`}
            </span>
          </button>
          {compareTargets.length >= 2 ? (
            <button
              type="button"
              className="ws-pivot"
              onClick={() => openCompare()}
            >
              <span className="ws-pivot__label">Open compare view</span>
              <span className="ws-pivot__hint">
                {compareTargets.length} target{compareTargets.length === 1 ? "" : "s"}
              </span>
            </button>
          ) : null}
        </div>
      </section>
      </PanelReveal>
    </OverlayPanel>
  );
}

interface SignalLike {
  type: string;
  severity: string;
  properties: Record<string, unknown>;
  place: { country_name: string | null };
}

function buildRationale(event: SignalLike, postureCopy: string): string {
  const countryBit = event.place.country_name
    ? ` in ${event.place.country_name}`
    : "";
  const props = event.properties ?? {};

  if (event.type === "stocks") {
    const pct = asNumber(props.change_pct);
    const price = asNumber(props.price);
    const name = asString(props.name) ?? asString(props.symbol) ?? "Equity";
    if (pct !== null) {
      const dir = pct >= 0 ? "up" : "down";
      return `${name} is ${dir} ${pct.toFixed(2)}% today${price !== null ? ` at ${price.toFixed(2)}` : ""}. Likely downstream effects route through portfolio risk, vol surfaces, and single-name hedges. ${postureCopy}`;
    }
  }
  if (event.type === "currency") {
    const pair = asString(props.pair) ?? "FX pair";
    const pct = asNumber(props.change_pct);
    if (pct !== null) {
      return `${pair} moved ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% versus the prior fix. FX moves of this size ripple into import costs, cross-border cash, and corporate hedge P&L. ${postureCopy}`;
    }
  }
  if (event.type === "weather") {
    const wind = asNumber(props.wind_ms);
    const precip = asNumber(props.precipitation_mm);
    const mag = asNumber(props.magnitude);
    if (mag !== null) {
      return `Seismic event with magnitude ${mag.toFixed(1)}${countryBit}. Check dependent ports, pipelines, and air traffic in the exposure radius. ${postureCopy}`;
    }
    return `Active weather${countryBit}${wind !== null ? ` — wind ${wind.toFixed(0)} m/s` : ""}${precip !== null ? `, precip ${precip.toFixed(1)} mm` : ""}. Monitor dependent flight, logistics, and outdoor operations. ${postureCopy}`;
  }
  if (event.type === "news") {
    const tone = asNumber(props.tone);
    const toneBit = tone !== null ? ` (tone ${tone >= 0 ? "+" : ""}${tone.toFixed(1)})` : "";
    return `Operational-risk reporting${countryBit}${toneBit}. Use this signal to widen the investigation scope before committing to downstream impact claims. ${postureCopy}`;
  }
  if (event.type === "conflict") {
    return `Conflict activity${countryBit}. Re-check route exposure, airspace posture, and personnel policy in the dependency path. ${postureCopy}`;
  }

  return `A ${event.severity} ${event.type} signal${countryBit}. Treat it as a watch item and review the source trail before acting. ${postureCopy}`;
}

interface SignalEventLike {
  type: string;
  properties: Record<string, unknown>;
}

function buildMarketRelevance(
  event: SignalEventLike,
  relevance: EntityRelevance,
): string | null {
  const props = event.properties ?? {};
  if (event.type === "stocks" || event.type === "markets") {
    const symbol = asString(props.symbol);
    const pct = asNumber(props.change_pct);
    const price = asNumber(props.price);
    if (symbol && pct !== null) {
      return `${symbol} is the directly-priced asset (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%${price !== null ? ` at ${price.toFixed(2)}` : ""}). Confidence-weighted exposure flows back to any portfolio holding the position or its derivatives.`;
    }
  }
  if (event.type === "currency") {
    const pair = asString(props.pair) ?? asString(props.symbol);
    if (pair) {
      return `${pair} is the directly-priced FX cross. Holdings denominated in either leg carry direct translation impact.`;
    }
  }
  if (event.type === "commodities") {
    const symbol = asString(props.symbol) ?? asString(props.commodity);
    if (symbol) {
      return `${symbol} pricing affects portfolios with input-cost exposure to this commodity, regardless of geography.`;
    }
  }
  // Wave 15C — country/sector/chokepoint signals: name the actually-mapped
  // tickers when we have a real entity-to-symbol entry. Fall back to soft
  // copy only when the lookup is empty so we never fabricate a link.
  if (relevance.symbols.length > 0) {
    const top = relevance.symbols.slice(0, 3).map((link) => link.symbol).join(", ");
    return `Mapped exposure points to ${top} (top ${Math.min(3, relevance.symbols.length)} of ${relevance.symbols.length}, max confidence ${Math.round(relevance.confidence * 100)}%). Cross-check the dependency path before acting.`;
  }
  if (event.type === "weather" || event.type === "conflict") {
    return "Likely market read: route- and country-correlated equities and FX may reprice. Cross-check the dependency path before acting.";
  }
  return null;
}

interface TechnicalRow {
  label: string;
  value: string;
}

function buildTechnicalRead(event: SignalEventLike): TechnicalRow[] | null {
  const props = event.properties ?? {};
  const rows: TechnicalRow[] = [];

  const price = asNumber(props.price) ?? asNumber(props.last);
  const prev = asNumber(props.previous_close);
  const pct = asNumber(props.change_pct);
  const high = asNumber(props.day_high) ?? asNumber(props.high);
  const low = asNumber(props.day_low) ?? asNumber(props.low);
  const vol = asNumber(props.volume);
  const rsi = asNumber(props.rsi14);
  const sma200 = asNumber(props.sma200);

  if (price !== null) rows.push({ label: "Last", value: price.toFixed(2) });
  if (prev !== null) rows.push({ label: "Prev close", value: prev.toFixed(2) });
  if (pct !== null) {
    rows.push({
      label: "Change",
      value: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`,
    });
  }
  if (high !== null && low !== null) {
    rows.push({ label: "Day range", value: `${low.toFixed(2)} – ${high.toFixed(2)}` });
  }
  if (vol !== null) rows.push({ label: "Volume", value: formatVolume(vol) });
  if (rsi !== null) rows.push({ label: "RSI 14", value: rsi.toFixed(0) });
  if (sma200 !== null && price !== null) {
    const diff = (price - sma200) / sma200;
    rows.push({
      label: "vs SMA200",
      value: `${diff >= 0 ? "+" : ""}${(diff * 100).toFixed(1)}%`,
    });
  }
  return rows.length > 0 ? rows : null;
}

function formatVolume(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

interface PropertyBag {
  type: string;
  properties: Record<string, unknown>;
}

function extractCommodity(event: PropertyBag): string | null {
  const props = event.properties ?? {};
  const direct = asString(props.commodity);
  if (direct) return direct;
  if (event.type === "commodities") {
    return asString(props.symbol) ?? asString(props.name);
  }
  return null;
}

function extractSector(event: PropertyBag): string | null {
  const props = event.properties ?? {};
  return asString(props.sector) ?? asString(props.industry);
}

function extractChokepoint(event: PropertyBag): string | null {
  const props = event.properties ?? {};
  return asString(props.chokepoint) ?? asString(props.maritime_chokepoint);
}

function extractCurrency(event: PropertyBag): string | null {
  const props = event.properties ?? {};
  return asString(props.currency) ?? asString(props.currency_code);
}

interface MarketEventLike {
  type: string;
  properties: Record<string, unknown>;
}

function resolveMarketSymbol(
  event: MarketEventLike,
  fallback: string | null,
): string | null {
  // Only market-class events drive the chart dock — we never try to chart
  // a weather or news signal.
  const marketTypes = new Set([
    "stocks",
    "markets",
    "currency",
    "commodities",
    "futures",
  ]);
  if (!marketTypes.has(event.type)) return null;
  const props = event.properties ?? {};
  const direct =
    asString(props.symbol) ?? asString(props.pair) ?? asString(props.commodity);
  if (direct) return direct.toUpperCase();
  return fallback;
}

interface PortfolioLike {
  holdings: ReadonlyArray<{ symbol: string }>;
}

function findHeldSymbol(
  portfolio: PortfolioLike | null,
  symbol: string,
): string | null {
  if (!portfolio) return null;
  const target = symbol.toUpperCase();
  const match = portfolio.holdings.find(
    (h) => h.symbol.toUpperCase() === target,
  );
  return match ? match.symbol : null;
}

function marketAssetClassFor(
  type: string,
): "equities" | "fx" | "commodities" | "futures" | "unknown" {
  switch (type) {
    case "stocks":
    case "markets":
      return "equities";
    case "currency":
      return "fx";
    case "commodities":
      return "commodities";
    case "futures":
      return "futures";
    default:
      return "unknown";
  }
}
