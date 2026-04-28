"use client";

// Phase 19B — compact portfolio impact card.
//
// Renders the typed PortfolioImpact returned by the agent layer:
//   * "impacts your demo book" eyebrow with optional demo badge
//   * one row per impacted holding with direct/indirect/weak label
//   * confidence + impact direction badge
//   * caveats inline
//
// The card is intentionally calm: no P&L estimate, no allocation graph.
// It hides itself when ``impact`` is null so legacy responses are
// unchanged.

import type {
  ImpactDirection,
  ImpactDomain,
  ImpactedHolding,
  PortfolioExposureType,
  PortfolioImpact,
} from "@/lib/intelligence/types";

const EXPOSURE_LABEL: Record<PortfolioExposureType, string> = {
  direct: "Direct",
  indirect: "Indirect",
  weak: "Country exposure",
};

const EXPOSURE_TONE: Record<PortfolioExposureType, "strong" | "warn" | "soft"> = {
  direct: "strong",
  indirect: "warn",
  weak: "soft",
};

const DIRECTION_LABEL: Record<ImpactDirection, string> = {
  up: "Pressure ↑",
  down: "Pressure ↓",
  mixed: "Mixed",
  stable: "Stable",
  unknown: "Unclear",
};

const DOMAIN_LABEL: Record<ImpactDomain, string> = {
  oil: "Oil",
  shipping: "Shipping",
  weather: "Weather",
  fx: "FX",
  commodities: "Commodities",
  equities: "Equities",
  country_risk: "Country risk",
  sector: "Sector",
  portfolio: "Portfolio",
  logistics: "Logistics",
  supply_chain: "Supply chain",
  macro: "Macro",
  unknown: "Channel",
};

interface PortfolioImpactCardProps {
  impact: PortfolioImpact | null | undefined;
}

export function PortfolioImpactCard({ impact }: PortfolioImpactCardProps) {
  if (!impact || impact.impacted_holdings.length === 0) {
    return null;
  }

  const visible = impact.impacted_holdings.slice(0, 5);
  const remaining = impact.impacted_holdings.length - visible.length;

  return (
    <section
      className="ws-section ws-portfolio-impact"
      data-testid="portfolio-impact-card"
      data-is-demo={impact.is_demo ? "true" : "false"}
    >
      <header className="ws-portfolio-impact__head">
        <div>
          <p className="ws-eyebrow">
            {impact.is_demo
              ? "Impacts your demo book"
              : "Impacts your portfolio"}
          </p>
          <h3 className="ws-section__title">
            {impact.portfolio_name}
            <span className="ws-section__count">
              {impact.impacted_holdings.length}/{impact.holdings_count}
            </span>
          </h3>
        </div>
        {impact.is_demo ? (
          <span
            className="ws-portfolio-impact__demo-badge"
            data-testid="portfolio-impact-demo-badge"
            title="Mapped against a demo / paper book"
          >
            Demo book
          </span>
        ) : null}
      </header>

      <p className="ws-portfolio-impact__summary">{impact.summary}</p>

      <ul className="ws-portfolio-impact__list">
        {visible.map((holding) => (
          <ImpactRow key={holding.holding_id} holding={holding} />
        ))}
      </ul>

      {remaining > 0 ? (
        <p className="ws-muted ws-portfolio-impact__remaining">
          + {remaining} more holding{remaining === 1 ? "" : "s"} touched.
        </p>
      ) : null}

      {impact.caveats.length > 0 ? (
        <ul className="ws-portfolio-impact__caveats">
          {impact.caveats.map((caveat) => (
            <li key={caveat} className="ws-portfolio-impact__caveat">
              {caveat}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

interface ImpactRowProps {
  holding: ImpactedHolding;
}

function ImpactRow({ holding }: ImpactRowProps) {
  const tone = EXPOSURE_TONE[holding.exposure_type];
  const matchedDomain = holding.matched_domain
    ? DOMAIN_LABEL[holding.matched_domain] ?? holding.matched_domain
    : null;
  return (
    <li
      className={`ws-portfolio-impact__row ws-portfolio-impact__row--${tone}`}
      data-exposure={holding.exposure_type}
      data-testid="portfolio-impact-row"
    >
      <div className="ws-portfolio-impact__row-head">
        <span className="ws-portfolio-impact__symbol">{holding.symbol}</span>
        <span
          className={`ws-portfolio-impact__exposure ws-portfolio-impact__exposure--${tone}`}
        >
          {EXPOSURE_LABEL[holding.exposure_type]}
        </span>
        <span
          className="ws-portfolio-impact__direction"
          title={`Confidence ${Math.round(holding.confidence * 100)}%`}
        >
          {DIRECTION_LABEL[holding.impact_direction]}
        </span>
      </div>
      <p className="ws-portfolio-impact__rationale">{holding.rationale}</p>
      <div className="ws-portfolio-impact__meta">
        {holding.matched_symbol ? (
          <span className="ws-chip ws-chip--ticker">
            via {holding.matched_symbol}
          </span>
        ) : null}
        {matchedDomain ? (
          <span className="ws-chip">via {matchedDomain}</span>
        ) : null}
        <span className="ws-portfolio-impact__confidence">
          {Math.round(holding.confidence * 100)}%
        </span>
      </div>
      {holding.caveats.length > 0 ? (
        <p className="ws-portfolio-impact__row-caveat">{holding.caveats[0]}</p>
      ) : null}
    </li>
  );
}
