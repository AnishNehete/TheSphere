"use client";

import { useEffect } from "react";

import {
  getPortfolio,
  getPortfolioBrief,
  getPortfolioRiskScore,
  getPortfolioSemantic,
  getPortfolioTechnical,
} from "@/lib/intelligence/client";
import type {
  EventPressureLevel,
  ExposureBucket,
  PortfolioBrief,
  PortfolioDependencyPathLink,
  PortfolioHolding,
  PortfolioLinkedEvent,
  PortfolioMacroRiskScore,
  PortfolioRiskItem,
  PortfolioSemanticResponse,
  RiskComponent,
  TechnicalSignalLevel,
  TechnicalSnapshot,
  TrendRegime,
} from "@/lib/intelligence/types";
import { IntelligenceApiError } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

import {
  SEVERITY_LABEL,
  categoryLabel,
  formatConfidence,
  formatRelative,
} from "./formatters";
import { OverlayPanel } from "./OverlayPanel";
import { PortfolioHoldingChart } from "./PortfolioHoldingChart";
import { PortfolioOnboarding } from "./PortfolioOnboarding";
import { PanelReveal } from "./motion/PanelReveal";
import {
  MetadataStrip,
  ReplayBadge,
  type MetadataField,
} from "./grammar/SignalGrammar";

// Phase 13A — Portfolio overlay surface.
// Pulls the persisted portfolio + the grounded brief from the backend and
// renders four analyst-grade sections: holdings summary, exposure rollups,
// top risks, and live world events linked back to specific exposures.
// Pivots: clicking a country bucket / linked event opens the existing
// CountryPanel / EventPanel via the overlay store.

export function PortfolioPanel() {
  const portfolioId = useOverlayStore((s) => s.selectedPortfolioId);
  const portfolio = useOverlayStore((s) => s.selectedPortfolio);
  const brief = useOverlayStore((s) => s.portfolioBrief);
  const technical = useOverlayStore((s) => s.portfolioTechnical);
  const semantic = useOverlayStore((s) => s.portfolioSemantic);
  const riskScore = useOverlayStore((s) => s.portfolioRiskScore);
  const isLoading = useOverlayStore((s) => s.isLoading);
  const error = useOverlayStore((s) => s.error);
  const asOf = useOverlayStore((s) => s.portfolioAsOf);
  const setPortfolioRecord = useOverlayStore((s) => s.setPortfolioRecord);
  const setPortfolioBrief = useOverlayStore((s) => s.setPortfolioBrief);
  const setPortfolioTechnical = useOverlayStore(
    (s) => s.setPortfolioTechnical,
  );
  const setPortfolioSemantic = useOverlayStore(
    (s) => s.setPortfolioSemantic,
  );
  const setPortfolioRiskScore = useOverlayStore(
    (s) => s.setPortfolioRiskScore,
  );
  const setLoading = useOverlayStore((s) => s.setLoading);
  const setError = useOverlayStore((s) => s.setError);
  const setPortfolioAsOf = useOverlayStore((s) => s.setPortfolioAsOf);
  const openCountry = useOverlayStore((s) => s.openCountry);
  const openQuery = useOverlayStore((s) => s.openQuery);
  const selectedHoldingSymbol = useOverlayStore((s) => s.selectedHoldingSymbol);
  const setSelectedHoldingSymbol = useOverlayStore((s) => s.setSelectedHoldingSymbol);

  useEffect(() => {
    if (!portfolioId) return;
    const controller = new AbortController();
    const asOfParam = asOf ?? undefined;
    setLoading(true);
    setError(null);
    Promise.all([
      portfolio && portfolio.id === portfolioId && !asOf
        ? Promise.resolve(portfolio)
        : getPortfolio(portfolioId, { signal: controller.signal }),
      getPortfolioBrief(portfolioId, { as_of: asOfParam, signal: controller.signal }),
    ])
      .then(([record, briefData]) => {
        setPortfolioRecord(record);
        setPortfolioBrief(briefData);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message =
          err instanceof IntelligenceApiError
            ? "Portfolio service is temporarily unavailable."
            : err instanceof Error
              ? err.message
              : "Failed to load portfolio.";
        setError(message);
      });

    // Phase 13B.2 — fetch technical snapshots in parallel; degrade silently
    // so a technical outage never blocks the main brief render.
    getPortfolioTechnical(portfolioId, { as_of: asOfParam, signal: controller.signal })
      .then((resp) => setPortfolioTechnical(resp.snapshots))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setPortfolioTechnical(null);
      });

    // Phase 13B.3 — semantic pressure; also fire-and-forget, degrades to
    // "unavailable" copy on failure so the brief rendering is not blocked.
    getPortfolioSemantic(portfolioId, { as_of: asOfParam, signal: controller.signal })
      .then((resp) => setPortfolioSemantic(resp))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setPortfolioSemantic(null);
      });

    // Phase 13B.4 — macro risk score; fire-and-forget, degrades to
    // "unavailable" copy on failure so the rest of the brief still renders.
    getPortfolioRiskScore(portfolioId, { as_of: asOfParam, signal: controller.signal })
      .then((score) => setPortfolioRiskScore(score))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setPortfolioRiskScore(null);
      });

    return () => controller.abort();
  }, [
    portfolioId,
    asOf,
    portfolio,
    setPortfolioBrief,
    setPortfolioRecord,
    setPortfolioTechnical,
    setPortfolioSemantic,
    setPortfolioRiskScore,
    setLoading,
    setError,
  ]);

  // Phase 15A — auto-select the highest-weight holding as soon as the brief
  // arrives, so the chart surface is always reachable without an extra click.
  // Respect a user's prior selection if it still exists in the brief.
  useEffect(() => {
    if (!brief || brief.holdings.length === 0) return;
    if (
      selectedHoldingSymbol &&
      brief.holdings.some((h) => h.symbol === selectedHoldingSymbol)
    ) {
      return;
    }
    const ranked = [...brief.holdings].sort((a, b) => b.weight - a.weight);
    setSelectedHoldingSymbol(ranked[0]?.symbol ?? null);
  }, [brief, selectedHoldingSymbol, setSelectedHoldingSymbol]);

  if (!portfolioId) {
    return (
      <OverlayPanel
        eyebrow="Portfolio · Compare to ground truth"
        title="Bring a portfolio in to compare against the live market"
      >
        <p
          className="ws-section__body ws-portfolio-intro"
          data-testid="portfolio-compare-intro"
        >
          Portfolio mode is a comparison layer: it overlays your holdings,
          watchlists, and paper books against live world signals, currency
          and commodity moves, sector behaviour, and geographic exposure.
          Charts for any market symbol are always available from the tape
          and signal panel — portfolio is not required for analysis.
        </p>
        <PortfolioOnboarding />
      </OverlayPanel>
    );
  }

  // Phase 16.6 — paper / demo book detection. Trusts (in order):
  //   1. an explicit `paper` / `demo` / `sample` / `simulated` tag
  //   2. the literal name containing "demo" or "paper"
  // We never silently flip a real portfolio to demo mode — only labelling
  // is affected. The tag is preserved so a user can promote a paper book
  // to a real one by removing the tag in the backend.
  const paperBookKind = detectPaperBookKind(portfolio);

  return (
    <OverlayPanel
      eyebrow={
        paperBookKind ? (
          <span className="ws-portfolio-eyebrow">
            <span>Portfolio · Compare to ground truth</span>
            <PaperBookPill kind={paperBookKind} />
          </span>
        ) : (
          "Portfolio · Compare to ground truth"
        )
      }
      title={portfolio?.name ?? brief?.name ?? "Portfolio brief"}
      subtitle={
        brief
          ? `${brief.holdings_count} holdings · ${Math.round(brief.confidence * 100)}% confidence · base ${brief.base_currency}`
          : isLoading
            ? "Resolving exposures…"
            : undefined
      }
    >
      {paperBookKind ? (
        <p
          className="ws-paper-book-banner"
          data-testid="portfolio-paper-book-banner"
          data-paper-kind={paperBookKind}
        >
          <strong>{paperBookKindLabel(paperBookKind)}.</strong>{" "}
          Values shown are paper-only and exist for evaluation. Real holdings
          come in via CSV or manual import — they are never mixed with demo
          books.
        </p>
      ) : null}

      {brief ? (
        <MetadataStrip
          testId="portfolio-grammar-meta"
          fields={[
            {
              key: "scope",
              label: "Scope",
              value: `${brief.holdings_count} holdings · ${brief.base_currency}`,
            },
            {
              key: "confidence",
              label: "Confidence",
              value: formatConfidence(brief.confidence),
            },
            {
              key: "freshness",
              label: "Generated",
              value: formatRelative(brief.generated_at),
            },
            {
              key: "status",
              label: "State",
              value: <ReplayBadge asOf={asOf} testId="portfolio-replay-badge" />,
            },
          ]}
        />
      ) : null}

      <div className="ws-portfolio-cursor" data-testid="portfolio-cursor">
        {asOf ? (
          <span className="ws-badge--asof ws-portfolio-cursor__label">
            As of {asOf.slice(0, 10)}
          </span>
        ) : (
          <span className="ws-badge--live ws-portfolio-cursor__live">Live</span>
        )}
        <input
          type="date"
          className="ws-portfolio-cursor__input"
          aria-label="View portfolio as of date"
          value={asOf ? asOf.slice(0, 10) : ""}
          max={new Date().toISOString().slice(0, 10)}
          onChange={(e) => {
            const val = e.target.value;
            setPortfolioAsOf(val ? `${val}T23:59:59Z` : null);
          }}
        />
        {asOf ? (
          <button
            type="button"
            className="ws-portfolio-cursor__restore"
            onClick={() => setPortfolioAsOf(null)}
          >
            Restore live
          </button>
        ) : null}
      </div>

      {isLoading && !brief ? <PortfolioSkeleton /> : null}

      {error && !brief ? (
        <div className="ws-empty">
          <span className="ws-eyebrow">Temporarily unavailable</span>
          <p>{error}</p>
        </div>
      ) : null}

      {brief ? (
        <PanelReveal testId="portfolio-panel-reveal">
          <ValuationSection brief={brief} />
          <RiskScoreSection score={riskScore} />
          <SemanticSection payload={semantic} />
          <TechnicalSection
            snapshots={technical}
            holdings={brief.holdings}
          />
          <HoldingsSummarySection
            brief={brief}
            selectedSymbol={selectedHoldingSymbol}
            onSelect={(symbol) =>
              setSelectedHoldingSymbol(
                selectedHoldingSymbol === symbol ? null : symbol,
              )
            }
          />
          {selectedHoldingSymbol && brief.portfolio_id ? (
            <section
              className="ws-portfolio-section ws-portfolio-compare"
              data-testid="portfolio-compare-section"
            >
              <p className="ws-eyebrow">
                Holding vs. ground truth · {selectedHoldingSymbol}
              </p>
              <PortfolioHoldingChart
                portfolioId={brief.portfolio_id}
                symbol={selectedHoldingSymbol}
                range="1y"
                linkedEvents={brief.linked_events.filter((e) =>
                  e.matched_exposure_node_ids.some((nodeId) => {
                    const holding = brief.holdings.find(
                      (h) => h.symbol === selectedHoldingSymbol,
                    );
                    if (!holding) return false;
                    return holding.country_code
                      ? nodeId.endsWith(`:${holding.country_code}`)
                      : true;
                  }),
                )}
              />
            </section>
          ) : null}
          <ExposureSection
            brief={brief}
            onOpenCountry={(code, name) => openCountry(code, name, "portfolio")}
            onOpenQuery={(query) => openQuery(query, undefined, "portfolio")}
          />
          <TopRiskSection risks={brief.top_risks} />
          <DependencySection paths={brief.dependency_paths} />
          <LinkedEventsSection
            events={brief.linked_events}
            onOpenCountry={(code, name) => openCountry(code, name, "portfolio")}
          />
          {brief.notes.length > 0 ? (
            <section className="ws-section ws-portfolio-notes">
              <h3 className="ws-section__title">Brief notes</h3>
              <ul>
                {brief.notes.map((note, idx) => (
                  <li key={idx}>{note}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </PanelReveal>
      ) : null}
    </OverlayPanel>
  );
}

// ---------- subsections ------------------------------------------------------

interface HoldingsSummarySectionProps {
  brief: PortfolioBrief;
  selectedSymbol: string | null;
  onSelect: (symbol: string) => void;
}

function HoldingsSummarySection({
  brief,
  selectedSymbol,
  onSelect,
}: HoldingsSummarySectionProps) {
  const ranked = [...brief.holdings].sort((a, b) => b.weight - a.weight);
  return (
    <section
      className="ws-section ws-portfolio-section"
      data-testid="portfolio-holdings"
    >
      <h3 className="ws-section__title">
        Holdings <span className="ws-section__count">{brief.holdings_count}</span>
      </h3>
      {ranked.length === 0 ? (
        <p className="ws-muted">No holdings yet. Import a CSV or add positions.</p>
      ) : (
        <ul className="ws-portfolio-holdings">
          {ranked.slice(0, 10).map((holding) => (
            <li
              key={holding.id}
              className={`ws-portfolio-holding${holding.symbol === selectedSymbol ? " ws-portfolio-holding--selected" : ""}`}
            >
              <button
                type="button"
                className="ws-portfolio-holding__trigger"
                onClick={() => onSelect(holding.symbol)}
              >
                <span className="ws-portfolio-holding__symbol">{holding.symbol}</span>
                <span className="ws-portfolio-holding__name">
                  {holding.name ?? holding.sector ?? "Position"}
                </span>
                <span className="ws-portfolio-holding__meta">
                  {holding.country_code ?? "—"}
                  {" · "}
                  {holding.currency}
                  {" · "}
                  {Math.round(holding.weight * 100)}%
                  {holding.last_price !== null
                    ? ` · ${holding.last_price.toFixed(2)}`
                    : holding.price_missing
                      ? " · no price"
                      : ""}
                  {holding.unrealized_pnl_pct !== null
                    ? ` · ${holding.unrealized_pnl_pct >= 0 ? "+" : ""}${(holding.unrealized_pnl_pct * 100).toFixed(1)}%`
                    : ""}
                </span>
                {renderEnrichmentTag(holding)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function renderEnrichmentTag(holding: PortfolioHolding) {
  if (holding.enrichment_confidence >= 0.8) return null;
  const label =
    holding.enrichment_confidence >= 0.4 ? "Partial enrichment" : "Manual only";
  return <span className="ws-portfolio-holding__warn">{label}</span>;
}

interface ExposureSectionProps {
  brief: PortfolioBrief;
  onOpenCountry: (code: string, name: string) => void;
  onOpenQuery: (query: string) => void;
}

function ExposureSection({
  brief,
  onOpenCountry,
  onOpenQuery,
}: ExposureSectionProps) {
  return (
    <section
      className="ws-section ws-portfolio-section"
      data-testid="portfolio-exposure"
    >
      <h3 className="ws-section__title">Exposure rollup</h3>
      <ExposureColumn
        title="Countries"
        buckets={brief.exposure_summary.countries}
        onClick={(bucket) => {
          if (bucket.node.country_code) {
            onOpenCountry(bucket.node.country_code, bucket.node.label);
          }
        }}
      />
      <ExposureColumn
        title="Sectors"
        buckets={brief.exposure_summary.sectors}
      />
      <ExposureColumn
        title="Currencies"
        buckets={brief.exposure_summary.currencies}
      />
      {brief.exposure_summary.commodities.length > 0 ? (
        <ExposureColumn
          title="Commodities"
          buckets={brief.exposure_summary.commodities}
          onClick={(bucket) =>
            onOpenQuery(`What is happening with ${bucket.node.label}?`)
          }
        />
      ) : null}
      {brief.exposure_summary.chokepoints.length > 0 ? (
        <ExposureColumn
          title="Chokepoints"
          buckets={brief.exposure_summary.chokepoints}
          onClick={(bucket) =>
            onOpenQuery(`What is happening at the ${bucket.node.label}?`)
          }
        />
      ) : null}
      {brief.exposure_summary.macro_themes.length > 0 ? (
        <ExposureColumn
          title="Macro themes"
          buckets={brief.exposure_summary.macro_themes}
        />
      ) : null}
    </section>
  );
}

interface ExposureColumnProps {
  title: string;
  buckets: ExposureBucket[];
  onClick?: (bucket: ExposureBucket) => void;
}

function ExposureColumn({ title, buckets, onClick }: ExposureColumnProps) {
  if (buckets.length === 0) return null;
  return (
    <div className="ws-exposure-column">
      <p className="ws-eyebrow">{title}</p>
      <ul className="ws-exposure-list">
        {buckets.map((bucket) => {
          const interactive = Boolean(onClick);
          return (
            <li key={bucket.node.id}>
              <button
                type="button"
                className="ws-exposure-row"
                disabled={!interactive}
                onClick={() => onClick?.(bucket)}
                title={bucket.rationale ?? undefined}
              >
                <span className="ws-exposure-row__label">{bucket.node.label}</span>
                <span className="ws-exposure-row__bar" aria-hidden>
                  <span
                    className="ws-exposure-row__fill"
                    style={{ width: `${Math.min(100, bucket.weight * 100)}%` }}
                  />
                </span>
                <span className="ws-exposure-row__value">
                  {Math.round(bucket.weight * 100)}%
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface TopRiskSectionProps {
  risks: PortfolioRiskItem[];
}

function TopRiskSection({ risks }: TopRiskSectionProps) {
  if (risks.length === 0) return null;
  return (
    <section
      className="ws-section ws-portfolio-section"
      data-testid="portfolio-risks"
    >
      <h3 className="ws-section__title">Top risks</h3>
      <ul className="ws-portfolio-risks">
        {risks.map((risk, idx) => (
          <li
            key={`${risk.title}-${idx}`}
            className={`ws-portfolio-risk ws-portfolio-risk--${risk.severity}`}
          >
            <p className="ws-portfolio-risk__title">{risk.title}</p>
            <p className="ws-portfolio-risk__rationale">{risk.rationale}</p>
            <span className="ws-portfolio-risk__meta">
              {risk.severity.toUpperCase()} · {Math.round(risk.confidence * 100)}%
              confidence
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface DependencySectionProps {
  paths: PortfolioDependencyPathLink[];
}

function DependencySection({ paths }: DependencySectionProps) {
  if (paths.length === 0) return null;
  return (
    <section
      className="ws-section ws-portfolio-section"
      data-testid="portfolio-dependencies"
    >
      <h3 className="ws-section__title">Exposure paths</h3>
      <ul className="ws-portfolio-deps">
        {paths.map((path) => (
          <li key={path.id} className="ws-portfolio-dep">
            <p className="ws-portfolio-dep__title">{path.title}</p>
            <p className="ws-portfolio-dep__rationale">{path.rationale}</p>
            <span className="ws-portfolio-dep__meta">
              {Math.round(path.overall_confidence * 100)}% confidence
              {path.contributing_holdings.length > 0
                ? ` · ${path.contributing_holdings.length} contributing holding(s)`
                : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface LinkedEventsSectionProps {
  events: PortfolioLinkedEvent[];
  onOpenCountry: (code: string, name: string) => void;
}

function LinkedEventsSection({ events, onOpenCountry }: LinkedEventsSectionProps) {
  if (events.length === 0) return null;
  return (
    <section
      className="ws-section ws-portfolio-section"
      data-testid="portfolio-linked-events"
    >
      <h3 className="ws-section__title">
        Linked world events
        <span className="ws-section__count">{events.length}</span>
      </h3>
      <ul className="ws-hit-list">
        {events.map((event) => (
          <li key={event.event_id} className="ws-hit">
            <button
              type="button"
              className="ws-hit__button"
              onClick={() => {
                if (event.country_code && event.country_name) {
                  onOpenCountry(event.country_code, event.country_name);
                }
              }}
              disabled={!event.country_code}
            >
              <span className={`ws-dot ws-dot--${event.severity}`} aria-hidden />
              <span className="ws-hit__main">
                <span className="ws-hit__title">{event.title}</span>
                <span className="ws-hit__meta">
                  {categoryLabel(event.type)}
                  {event.country_code ? ` · ${event.country_code}` : ""}
                  {" · "}
                  {SEVERITY_LABEL[event.severity]}
                  {" · "}
                  {formatRelative(event.source_timestamp)}
                  {event.publisher ? ` · ${event.publisher}` : ""}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PortfolioSkeleton() {
  return (
    <div className="ws-skeleton" aria-busy="true" aria-live="polite">
      <div className="ws-skeleton__block" style={{ width: "44%" }} />
      <div className="ws-skeleton__block" style={{ width: "78%" }} />
      <div className="ws-skeleton__block" style={{ width: "62%" }} />
      <div className="ws-skeleton__block" style={{ width: "70%" }} />
    </div>
  );
}

// ---------- Phase 13B ValuationSection --------------------------------------

interface ValuationSectionProps {
  brief: PortfolioBrief;
}

function ValuationSection({ brief }: ValuationSectionProps) {
  const summary = brief.valuation_summary;
  if (!summary) {
    return (
      <section
        className="ws-section ws-portfolio-section"
        data-testid="portfolio-valuation"
      >
        <h3 className="ws-section__title">Valuation</h3>
        <p className="ws-muted">Live prices unavailable. Valuation omitted.</p>
      </section>
    );
  }
  const total = brief.holdings_count;
  const priced = Math.round(summary.price_coverage * total);
  const missingBit =
    summary.missing_price_symbols.length > 0
      ? ` · missing ${summary.missing_price_symbols.slice(0, 3).join(", ")}${summary.missing_price_symbols.length > 3 ? "…" : ""}`
      : "";
  const coverageLabel = `Prices: ${priced}/${total} live${missingBit}`;
  const weightsNote =
    summary.weight_basis === "market_value"
      ? null
      : summary.weight_basis === "cost_basis_fallback"
        ? "Weights from cost basis (price coverage below 50%)."
        : "Weights from even split (no cost or price data).";
  return (
    <section
      className="ws-section ws-portfolio-section ws-portfolio-valuation"
      data-testid="portfolio-valuation"
    >
      <h3 className="ws-section__title">Valuation / P&amp;L</h3>
      <dl className="ws-portfolio-valuation__grid">
        <div>
          <dt>Market value</dt>
          <dd>{formatMoney(summary.total_market_value, brief.base_currency)}</dd>
        </div>
        <div>
          <dt>Cost basis</dt>
          <dd>{formatMoney(summary.total_cost_basis, brief.base_currency)}</dd>
        </div>
        <div>
          <dt>Unrealized P&amp;L</dt>
          <dd className={pnlClass(summary.total_unrealized_pnl)}>
            {formatMoney(summary.total_unrealized_pnl, brief.base_currency)}
          </dd>
        </div>
        <div>
          <dt>Unrealized %</dt>
          <dd className={pnlClass(summary.total_unrealized_pnl_pct)}>
            {formatPct(summary.total_unrealized_pnl_pct)}
          </dd>
        </div>
      </dl>
      <p className="ws-eyebrow">{coverageLabel}</p>
      {weightsNote ? <p className="ws-muted">{weightsNote}</p> : null}
    </section>
  );
}

function formatMoney(value: number | null, currency: string): string {
  if (value === null || Number.isNaN(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return value.toFixed(2);
  }
}

function formatPct(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

function pnlClass(value: number | null): string {
  if (value === null) return "";
  return value >= 0 ? "ws-pnl--positive" : "ws-pnl--negative";
}

// ---------- Phase 13B.2 TechnicalSection ------------------------------------

interface TechnicalSectionProps {
  snapshots: TechnicalSnapshot[] | null;
  holdings: PortfolioHolding[];
}

const LEVEL_LABEL: Record<TechnicalSignalLevel, string> = {
  stretched_long: "Stretched long",
  balanced: "Balanced",
  stretched_short: "Stretched short",
};

const REGIME_LABEL: Record<TrendRegime, string> = {
  above_200: "Above 200d",
  below_200: "Below 200d",
  recovering: "Recovering",
  breaking_down: "Breaking down",
  above_50: "Above 50d (50d trend, 200d N/A)",
  below_50: "Below 50d (50d trend, 200d N/A)",
  insufficient_data: "Insufficient data",
};

function TechnicalSection({ snapshots, holdings }: TechnicalSectionProps) {
  if (snapshots === null) {
    return (
      <section
        className="ws-section ws-portfolio-section"
        data-testid="portfolio-technical"
      >
        <h3 className="ws-section__title">Technical snapshot</h3>
        <p className="ws-muted">Technical signals unavailable for this portfolio.</p>
      </section>
    );
  }
  if (snapshots.length === 0) {
    return null;
  }
  const weightBySymbol = new Map(holdings.map((h) => [h.symbol, h.weight]));
  const topN = [...snapshots]
    .sort(
      (a, b) =>
        (weightBySymbol.get(b.symbol) ?? 0) -
        (weightBySymbol.get(a.symbol) ?? 0),
    )
    .slice(0, 6);
  return (
    <section
      className="ws-section ws-portfolio-section"
      data-testid="portfolio-technical"
    >
      <h3 className="ws-section__title">
        Technical snapshot{" "}
        <span className="ws-section__count">{snapshots.length}</span>
      </h3>
      <ul className="ws-portfolio-technical">
        {topN.map((snap) => (
          <li key={snap.symbol} className="ws-portfolio-technical__row">
            <span className="ws-portfolio-technical__symbol">{snap.symbol}</span>
            <span
              className={`ws-badge ws-badge--${snap.technical_signal_level}`}
            >
              {LEVEL_LABEL[snap.technical_signal_level]}
            </span>
            <span className="ws-portfolio-technical__regime">
              {REGIME_LABEL[snap.trend_regime]}
            </span>
            <span className="ws-portfolio-technical__meta">
              {snap.rsi14 !== null ? `RSI ${snap.rsi14.toFixed(0)}` : "RSI —"}
              {" · "}
              {snap.realized_vol_30d !== null
                ? `vol ${(snap.realized_vol_30d * 100).toFixed(0)}%`
                : "vol —"}
              {snap.price_vs_sma200 !== null
                ? ` · ${snap.price_vs_sma200 >= 0 ? "+" : ""}${(
                    snap.price_vs_sma200 * 100
                  ).toFixed(1)}% vs 200d`
                : ""}
            </span>
            {snap.technical_notes.length > 0 ? (
              <span
                className="ws-portfolio-technical__notes"
                title={snap.technical_notes.join(" · ")}
              >
                {snap.technical_notes.length} note
                {snap.technical_notes.length > 1 ? "s" : ""}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- Phase 13B.3 SemanticSection -------------------------------------

const PRESSURE_LABEL: Record<EventPressureLevel, string> = {
  calm: "Calm",
  watch: "Watch",
  elevated: "Elevated",
  critical: "Critical",
};

interface SemanticSectionProps {
  payload: PortfolioSemanticResponse | null;
}

function SemanticSection({ payload }: SemanticSectionProps) {
  if (payload === null) {
    return (
      <section
        className="ws-section ws-portfolio-section"
        data-testid="portfolio-semantic"
      >
        <h3 className="ws-section__title">Event pressure</h3>
        <p className="ws-muted">Semantic pressure unavailable.</p>
      </section>
    );
  }
  const { rollup } = payload;
  return (
    <section
      className="ws-section ws-portfolio-section"
      data-testid="portfolio-semantic"
    >
      <h3 className="ws-section__title">
        Event pressure{" "}
        <span className="ws-section__count">
          {rollup.contributing_event_count}
        </span>
      </h3>
      <div className="ws-portfolio-semantic__head">
        <span
          className={`ws-badge ws-badge--pressure-${rollup.event_pressure_level}`}
        >
          {PRESSURE_LABEL[rollup.event_pressure_level]}
        </span>
        <span className="ws-portfolio-semantic__score">
          Score {(rollup.semantic_score * 100).toFixed(0)} ·{" "}
          {Math.round(rollup.confidence * 100)}% confidence
        </span>
      </div>
      {rollup.top_drivers.length > 0 ? (
        <ul className="ws-portfolio-semantic__drivers">
          {rollup.top_drivers.map((driver) => (
            <li key={driver.node_id}>
              <span className="ws-portfolio-semantic__label">
                {driver.label}
              </span>
              <span className="ws-portfolio-semantic__contrib">
                {(driver.contribution * 100).toFixed(0)}
              </span>
              <span className="ws-portfolio-semantic__rationale">
                {driver.rationale}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ws-muted">
          No active events linked to this portfolio&apos;s exposure.
        </p>
      )}
    </section>
  );
}

// ---------- Phase 13B.6 tilt helper ----------------------------------------

function formatTilt(score: PortfolioMacroRiskScore): string | null {
  const { signal_alignment, bullish_tilt_score, bearish_tilt_score, uncertainty_score } = score;
  if (!signal_alignment || signal_alignment === "insufficient") return null;
  const bull = bullish_tilt_score !== null ? `${(bullish_tilt_score * 100).toFixed(0)}` : "—";
  const bear = bearish_tilt_score !== null ? `${(bearish_tilt_score * 100).toFixed(0)}` : "—";
  const unc = uncertainty_score !== null ? `${(uncertainty_score * 100).toFixed(0)}%` : "—";
  const alignLabel =
    signal_alignment === "aligned" ? "Aligned"
    : signal_alignment === "mixed" ? "Mixed"
    : signal_alignment === "conflicting" ? "Conflicting"
    : signal_alignment;
  return `${alignLabel} · upside ${bull} / downside ${bear} · uncertainty ${unc}`;
}

// ---------- Phase 13B.4 RiskScoreSection ------------------------------------

interface RiskScoreSectionProps {
  score: PortfolioMacroRiskScore | null;
}

function RiskScoreSection({ score }: RiskScoreSectionProps) {
  if (score === null) {
    return (
      <section
        className="ws-section ws-portfolio-section"
        data-testid="portfolio-risk-score"
      >
        <h3 className="ws-section__title">Macro risk score</h3>
        <p className="ws-muted">Risk score unavailable.</p>
      </section>
    );
  }

  const deltaLabel =
    score.delta_vs_baseline === 0
      ? "baseline establishing"
      : `${score.delta_vs_baseline > 0 ? "+" : ""}${score.delta_vs_baseline.toFixed(1)} vs 7d`;
  const scoreClass =
    score.risk_score >= 70
      ? "ws-risk--critical"
      : score.risk_score >= 50
        ? "ws-risk--elevated"
        : score.risk_score >= 30
          ? "ws-risk--watch"
          : "ws-risk--calm";

  const componentEntries = Object.entries(score.score_components) as [
    RiskComponent,
    number,
  ][];

  return (
    <section
      className="ws-section ws-portfolio-section"
      data-testid="portfolio-risk-score"
    >
      <h3 className="ws-section__title">Macro risk score</h3>
      <div className="ws-portfolio-risk__head">
        <span className={`ws-portfolio-risk__score ${scoreClass}`}>
          {score.risk_score.toFixed(0)}
        </span>
        <span className="ws-portfolio-risk__delta">{deltaLabel}</span>
        <span className="ws-portfolio-risk__conf">
          {Math.round(score.confidence * 100)}% confidence
        </span>
      </div>
      {score.drivers.length > 0 ? (
        <ul className="ws-portfolio-risk__drivers">
          {score.drivers.slice(0, 4).map((driver) => (
            <li key={driver.component}>
              <span className="ws-portfolio-risk__dlabel">{driver.label}</span>
              <span className="ws-portfolio-risk__dweight">
                {(driver.weight * 100).toFixed(0)}
              </span>
              <span className="ws-portfolio-risk__dr">{driver.rationale}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {formatTilt(score) ? (
        <p className="ws-portfolio-risk__tilt" data-testid="portfolio-risk-tilt">
          {formatTilt(score)}
        </p>
      ) : null}
      <details className="ws-portfolio-risk__components">
        <summary>Component breakdown</summary>
        <dl>
          {componentEntries.map(([name, value]) => (
            <div key={name}>
              <dt>{name.replace("_", " ")}</dt>
              <dd>{(value * 100).toFixed(0)}</dd>
            </div>
          ))}
        </dl>
      </details>
      {score.notes.length > 0 ? (
        <ul className="ws-portfolio-risk__notes">
          {score.notes.map((note, idx) => (
            <li key={idx}>{note}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ---- Phase 16.6 — paper / demo book detection ----

type PaperBookKind = "demo" | "paper" | "sample" | null;

interface PortfolioRecordLike {
  name?: string | null;
  tags?: ReadonlyArray<string> | null;
}

function detectPaperBookKind(
  record: PortfolioRecordLike | null,
): PaperBookKind {
  if (!record) return null;
  const tagSet = new Set(
    (record.tags ?? []).map((t) => t.trim().toLowerCase()),
  );
  if (tagSet.has("demo")) return "demo";
  if (tagSet.has("paper")) return "paper";
  if (tagSet.has("sample") || tagSet.has("simulated")) return "sample";
  const name = (record.name ?? "").toLowerCase();
  if (/\bdemo\b/.test(name)) return "demo";
  if (/\bpaper\b/.test(name)) return "paper";
  if (/\bsample\b/.test(name)) return "sample";
  return null;
}

function paperBookKindLabel(kind: NonNullable<PaperBookKind>): string {
  switch (kind) {
    case "demo":
      return "Demo book";
    case "paper":
      return "Paper book";
    case "sample":
      return "Sample book";
  }
}

interface PaperBookPillProps {
  kind: NonNullable<PaperBookKind>;
}

function PaperBookPill({ kind }: PaperBookPillProps) {
  return (
    <span
      className="ws-paper-book-pill"
      data-testid="portfolio-paper-book-pill"
      data-paper-kind={kind}
    >
      {paperBookKindLabel(kind)}
    </span>
  );
}
