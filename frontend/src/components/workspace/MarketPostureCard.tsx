"use client";

import { useEffect, useState } from "react";

import { AlertRuleQuickAdd } from "@/components/workspace/AlertRuleQuickAdd";
import {
  getMarketNarrative,
  getMarketPosture,
} from "@/lib/intelligence/client";
import type {
  MarketNarrative,
  MarketPostureResponse,
  PostureAssetClass,
  PostureLabel,
  ProviderHealth,
  SemanticEventDriver,
} from "@/lib/intelligence/types";

// Phase 17A.2 — operator-grade posture card.
//
// Renders the deterministic posture + semantic pressure block returned
// by /api/intelligence/market/{symbol}/posture. Compact by design — the
// product loop is "chart → posture → caveats", not a wall of text.
//
// Honest-data contract: when provider_health is "unsupported" we render
// an explicit "not covered by Alpha Vantage" affordance instead of an
// empty card.

interface MarketPostureCardProps {
  symbol: string;
  assetClass?: PostureAssetClass | null;
  asOf?: string | null;
  testId?: string;
}

const POSTURE_TONE: Record<PostureLabel, string> = {
  strong_sell: "ws-posture--strong-sell",
  sell: "ws-posture--sell",
  neutral: "ws-posture--neutral",
  buy: "ws-posture--buy",
  strong_buy: "ws-posture--strong-buy",
};

const PROVIDER_TONE: Record<ProviderHealth, string> = {
  live: "ws-posture__provider--live",
  degraded: "ws-posture__provider--degraded",
  unsupported: "ws-posture__provider--unsupported",
  unconfigured: "ws-posture__provider--unconfigured",
};

export function MarketPostureCard({
  symbol,
  assetClass = null,
  asOf = null,
  testId = "market-posture",
}: MarketPostureCardProps) {
  const [posture, setPosture] = useState<MarketPostureResponse | null>(null);
  const [narrative, setNarrative] = useState<MarketNarrative | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setPosture(null);
    setNarrative(null);
    getMarketPosture(
      symbol,
      {
        asset_class: assetClass ?? undefined,
        as_of: asOf ?? undefined,
      },
      { signal: controller.signal },
    )
      .then((resp) => setPosture(resp))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Posture unavailable");
      });
    return () => controller.abort();
  }, [symbol, assetClass, asOf]);

  // Phase 17A.3 — lazy bounded narrative. Fired after the deterministic
  // posture lands so the card can swap the fallback lead line for the
  // agentic prose without ever waiting on the LLM. Failures silently
  // keep the deterministic lead — narrative is decoration, not gate.
  useEffect(() => {
    if (!posture) return;
    if (
      posture.provider_health === "unconfigured" ||
      posture.provider_health === "unsupported"
    ) {
      // The deterministic lead already explains these states honestly;
      // no narrative call needed and probably uninteresting anyway.
      return;
    }
    const controller = new AbortController();
    getMarketNarrative(
      symbol,
      {
        asset_class: assetClass ?? undefined,
        as_of: asOf ?? undefined,
      },
      { signal: controller.signal },
    )
      .then((resp) => setNarrative(resp.narrative))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Swallow — the deterministic lead is already on screen.
      });
    return () => controller.abort();
  }, [posture, symbol, assetClass, asOf]);

  if (error) {
    return (
      <section
        className="ws-posture ws-posture--error"
        data-testid={testId}
        data-symbol={symbol.toUpperCase()}
      >
        <p className="ws-muted" data-testid={`${testId}-error`}>
          Posture unavailable. {error}
        </p>
      </section>
    );
  }

  if (!posture) {
    return (
      <section
        className="ws-posture ws-posture--loading"
        data-testid={testId}
        data-symbol={symbol.toUpperCase()}
      >
        <p className="ws-muted" data-testid={`${testId}-loading`}>
          Computing posture for {symbol.toUpperCase()}…
        </p>
      </section>
    );
  }

  const tone = POSTURE_TONE[posture.posture];
  const semantic = posture.semantic_pressure;
  const semContribution = posture.components.semantic;
  const technical = posture.components.technical;
  const macro = posture.components.macro;

  return (
    <section
      className={`ws-posture ${tone}`}
      data-testid={testId}
      data-symbol={posture.symbol}
      data-posture={posture.posture}
      data-provider-health={posture.provider_health}
    >
      <header className="ws-posture__head">
        <span className="ws-posture__label" data-testid={`${testId}-label`}>
          {posture.posture_label}
        </span>
        <span
          className="ws-posture__confidence"
          data-testid={`${testId}-confidence`}
          title="1.0 = full confidence; the tilt is damped by uncertainty"
        >
          {Math.round(posture.confidence * 100)}% conf
        </span>
        <span
          className={`ws-posture__provider ${PROVIDER_TONE[posture.provider_health]}`}
          data-testid={`${testId}-provider`}
          title={`Market data provider: ${posture.provider}`}
        >
          {labelForProviderHealth(posture.provider_health, posture.provider)}
        </span>
      </header>

      <p
        className="ws-posture__lead"
        data-testid={`${testId}-lead`}
        data-source={narrative?.source ?? "deterministic"}
      >
        {narrative ? narrative.narrative : summarizeCallDeterministic(posture)}
      </p>
      {narrative?.source === "anthropic" ? (
        <p
          className="ws-posture__lead-source"
          data-testid={`${testId}-lead-source`}
          aria-label="Narrative source"
        >
          AI summary · grounded in posture · {narrative.posture_alignment_check}
        </p>
      ) : null}

      <dl className="ws-posture__components" data-testid={`${testId}-components`}>
        <Component
          label="Technical"
          value={technical}
          testId={`${testId}-technical`}
        />
        <Component
          label="Semantic"
          value={semContribution}
          testId={`${testId}-semantic`}
          direction={semantic?.semantic_direction ?? null}
          rightHint={
            semantic && semantic.matched_event_count > 0
              ? `${semantic.matched_event_count} ev`
              : null
          }
        />
        <Component
          label="Macro"
          value={macro}
          testId={`${testId}-macro`}
        />
      </dl>

      {semantic && semantic.top_semantic_drivers.length > 0 ? (
        <section
          className="ws-posture__drivers"
          data-testid={`${testId}-drivers`}
          aria-label={`Top semantic drivers for ${posture.symbol}`}
        >
          <h4 className="ws-posture__drivers-head">News pressure</h4>
          <ul className="ws-posture__drivers-list">
            {semantic.top_semantic_drivers.slice(0, 3).map((driver) => (
              <li
                key={driver.event_id}
                data-direction={driver.direction}
                className={`ws-posture__driver ws-posture__driver--${driver.direction}`}
              >
                <span className="ws-posture__driver-arrow" aria-hidden="true">
                  {arrowFor(driver)}
                </span>
                <span className="ws-posture__driver-title" title={driver.title}>
                  {driver.title}
                </span>
                <span className="ws-posture__driver-meta">
                  {formatAge(driver.age_hours)}
                  {driver.publisher ? ` · ${driver.publisher}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {posture.caveats.length > 0 ? (
        <section
          className="ws-posture__caveats"
          data-testid={`${testId}-caveats`}
          aria-label="Posture caveats"
        >
          <ul>
            {posture.caveats.slice(0, 4).map((c, idx) => (
              <li key={`${idx}-${c.slice(0, 32)}`}>{c}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {posture.provider_health === "live" ||
      posture.provider_health === "degraded" ? (
        <AlertRuleQuickAdd
          symbol={posture.symbol}
          assetClass={posture.asset_class}
          testId={`${testId}-quickadd`}
        />
      ) : null}
    </section>
  );
}

interface ComponentProps {
  label: string;
  value: number | null;
  testId: string;
  direction?: "bullish" | "bearish" | "neutral" | null;
  rightHint?: string | null;
}

function Component({ label, value, testId, direction, rightHint }: ComponentProps) {
  const formatted = value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
  const tone =
    value === null
      ? "flat"
      : value > 0.05
        ? "up"
        : value < -0.05
          ? "down"
          : "flat";
  return (
    <div
      className={`ws-posture__component ws-posture__component--${tone}`}
      data-testid={testId}
      data-direction={direction ?? tone}
    >
      <dt>{label}</dt>
      <dd>
        <span className="ws-posture__component-value">{formatted}</span>
        {rightHint ? (
          <span className="ws-posture__component-hint">{rightHint}</span>
        ) : null}
      </dd>
    </div>
  );
}

function labelForProviderHealth(health: ProviderHealth, provider: string): string {
  switch (health) {
    case "live":
      return `Live · ${displayProvider(provider)}`;
    case "degraded":
      return `Degraded · ${displayProvider(provider)}`;
    case "unsupported":
      return `Not covered · ${displayProvider(provider)}`;
    case "unconfigured":
      return "Provider unconfigured";
  }
}

function displayProvider(provider: string): string {
  if (provider.startsWith("alphavantage")) return "Alpha Vantage";
  if (provider.startsWith("synthetic")) return "Synthetic";
  return provider;
}

// Phase 17A.3 — deterministic call summary. Intentionally builds the lead
// sentence from typed posture fields only (no LLM, no invented prose),
// so the card already reads as a coherent brief before the bounded
// agentic narrative layer (Part 1) is wired in.
function summarizeCallDeterministic(posture: MarketPostureResponse): string {
  const conf = Math.round(posture.confidence * 100);
  const lowConfidence = posture.confidence < 0.4;

  // Phase 17A.3 — provider honesty leads. When the market data provider
  // is unconfigured or the symbol is outside coverage, the lead sentence
  // says so explicitly; the operator should never read a directional
  // call without first knowing the data substrate is intact.
  if (posture.provider_health === "unconfigured") {
    return "Stance unavailable — market data provider is not configured.";
  }
  if (posture.provider_health === "unsupported") {
    return "Outside provider coverage — posture is technical-/macro-blind here; news pressure only if events arrive.";
  }

  if (posture.posture === "neutral") {
    return lowConfidence
      ? "Mixed signals — staying neutral until conviction builds."
      : "Neutral stance — no clear directional pressure right now.";
  }

  const components: Array<{
    key: "technical" | "semantic" | "macro";
    label: string;
    value: number;
  }> = [];
  if (posture.components.technical !== null) {
    components.push({
      key: "technical",
      label: "Technical",
      value: posture.components.technical,
    });
  }
  if (posture.components.semantic !== null) {
    components.push({
      key: "semantic",
      label: "News pressure",
      value: posture.components.semantic,
    });
  }
  if (posture.components.macro !== null) {
    components.push({
      key: "macro",
      label: "Macro",
      value: posture.components.macro,
    });
  }

  components.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const lead = components[0];

  const head = `${posture.posture_label} call`;
  const middle = lead
    ? `${lead.label.toLowerCase()} leads (${lead.value >= 0 ? "+" : ""}${lead.value.toFixed(2)})`
    : "drivers below";
  const tail = lowConfidence
    ? `${conf}% conviction — low, treat as a watch`
    : `${conf}% conviction`;

  return `${head} · ${middle} · ${tail}.`;
}

function arrowFor(driver: SemanticEventDriver): string {
  if (driver.direction === "bullish") return "▲";
  if (driver.direction === "bearish") return "▼";
  return "·";
}

function formatAge(hours: number): string {
  if (hours < 1) return "<1h";
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.round(days)}d`;
  return `${Math.round(days / 7)}w`;
}
