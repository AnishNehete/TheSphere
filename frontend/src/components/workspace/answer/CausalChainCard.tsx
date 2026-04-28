"use client";

// Phase 18D — compact causal chain surface.
//
// Renders the deterministic CausalChainSet returned by the agent layer:
//   * top driver badge with confidence and direction tone
//   * 1–3 ranked chains with source → mechanism → impact path
//   * affected symbols / domains as chips
//   * caveats inline
//
// The card is intentionally calm: no SVG graph, no node spaghetti, no
// auto-layout. The card is hidden entirely when there are no chains so
// the existing query panel layout is unchanged for legacy responses.

import { useState } from "react";

import type {
  CausalChain,
  CausalChainSet,
  CausalDriver,
  ImpactDirection,
  ImpactDomain,
  ImpactStrength,
} from "@/lib/intelligence/types";

const DIRECTION_LABEL: Record<ImpactDirection, string> = {
  up: "Pressure ↑",
  down: "Pressure ↓",
  mixed: "Mixed",
  stable: "Stable",
  unknown: "Direction unclear",
};

const DIRECTION_TONE: Record<ImpactDirection, "up" | "down" | "neutral" | "mixed"> = {
  up: "up",
  down: "down",
  mixed: "mixed",
  stable: "neutral",
  unknown: "neutral",
};

const STRENGTH_LABEL: Record<ImpactStrength, string> = {
  weak: "Weak",
  moderate: "Moderate",
  strong: "Strong",
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

interface CausalChainCardProps {
  chainSet: CausalChainSet | null;
}

export function CausalChainCard({ chainSet }: CausalChainCardProps) {
  const [expanded, setExpanded] = useState(false);

  if (!chainSet || chainSet.chains.length === 0) {
    return null;
  }

  const visibleChains = expanded ? chainSet.chains : chainSet.chains.slice(0, 3);
  const topDriver: CausalDriver | undefined = chainSet.top_drivers[0];

  return (
    <section
      className="ws-section ws-causal"
      data-testid="causal-chain-card"
      data-provider-health={chainSet.provider_health}
    >
      <header className="ws-causal__head">
        <div>
          <p className="ws-eyebrow">Causal intelligence</p>
          <h3 className="ws-section__title">
            Top driver
            <span className="ws-section__count">{chainSet.chains.length}</span>
          </h3>
        </div>
        {topDriver ? (
          <span
            className={`ws-causal__direction ws-causal__direction--${DIRECTION_TONE[topDriver.direction]}`}
            title={`${DIRECTION_LABEL[topDriver.direction]} · ${STRENGTH_LABEL[topDriver.strength]} · confidence ${Math.round(topDriver.confidence * 100)}%`}
          >
            {DIRECTION_LABEL[topDriver.direction]}
          </span>
        ) : null}
      </header>

      <ol className="ws-causal__list">
        {visibleChains.map((chain, idx) => (
          <ChainRow
            key={chain.chain_id}
            chain={chain}
            rank={idx + 1}
            isTop={idx === 0}
          />
        ))}
      </ol>

      {chainSet.chains.length > 3 ? (
        <button
          type="button"
          className="ws-causal__more"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded
            ? "Show top 3 only"
            : `Show ${chainSet.chains.length - 3} more chain${
                chainSet.chains.length - 3 === 1 ? "" : "s"
              }`}
        </button>
      ) : null}

      {chainSet.caveats.length > 0 ? (
        <ul className="ws-causal__caveats">
          {chainSet.caveats.map((caveat) => (
            <li key={caveat} className="ws-causal__caveat">
              {caveat}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

interface ChainRowProps {
  chain: CausalChain;
  rank: number;
  isTop: boolean;
}

function ChainRow({ chain, rank, isTop }: ChainRowProps) {
  const tone = DIRECTION_TONE[chain.direction];
  const path = chain.nodes.slice(0, 3).map((node) => node.label);
  const rowClasses = [
    "ws-causal__row",
    `ws-causal__row--${tone}`,
    isTop ? "ws-causal__row--top" : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <li
      className={rowClasses}
      data-chain-id={chain.chain_id}
      data-rule-id={chain.rule_id}
      data-rank={rank}
      data-top={isTop ? "true" : "false"}
    >
      <div className="ws-causal__row-head">
        <span className="ws-causal__rank" aria-hidden>
          {isTop ? "Top driver" : `Driver ${rank}`}
        </span>
        <span
          className="ws-causal__confidence"
          title={`Strength ${STRENGTH_LABEL[chain.strength]} · score ${chain.score.toFixed(2)}`}
        >
          {Math.round(chain.confidence * 100)}%
        </span>
      </div>
      <p className="ws-causal__rule">{chain.title}</p>

      <p className="ws-causal__summary">{chain.summary}</p>

      {path.length >= 2 ? (
        <p className="ws-causal__path" aria-label="Transmission path">
          {path.join("  →  ")}
        </p>
      ) : null}

      {chain.affected_symbols.length > 0 || chain.affected_domains.length > 0 ? (
        <div className="ws-causal__chips">
          {chain.affected_symbols.slice(0, 4).map((sym) => (
            <span key={`sym-${sym}`} className="ws-chip ws-chip--ticker">
              {sym}
            </span>
          ))}
          {chain.affected_domains.slice(0, 3).map((domain) => (
            <span key={`dom-${domain}`} className="ws-chip">
              {DOMAIN_LABEL[domain] ?? domain}
            </span>
          ))}
        </div>
      ) : null}

      {chain.caveats.length > 0 ? (
        <p className="ws-causal__row-caveat">{chain.caveats[0]}</p>
      ) : null}
    </li>
  );
}
