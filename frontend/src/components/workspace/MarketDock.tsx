"use client";

import { useMemo } from "react";

import type { SignalEvent } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

import { MarketChart } from "./MarketChart";
import { MarketPostureCard } from "./MarketPostureCard";

// Phase 16.7 — persistent market chart dock.
//
// Lives in the workspace shell so a selected market symbol is reachable
// even when the analyst navigates between right-panel modes. The dock
// only mounts when `selectedMarketSymbol` is set, and gracefully closes
// itself when the user clears the selection. It is intentionally small
// and operator-grade: symbol header, asset class chip, last/change, the
// MarketChart wrapper, and a close affordance.

interface MarketDockProps {
  testId?: string;
}

export function MarketDock({ testId = "market-dock" }: MarketDockProps) {
  const selectedSymbol = useOverlayStore((s) => s.selectedMarketSymbol);
  const selectedAssetClass = useOverlayStore(
    (s) => s.selectedMarketAssetClass,
  );
  const asOf = useOverlayStore((s) => s.portfolioAsOf);
  const selectMarketSymbol = useOverlayStore((s) => s.selectMarketSymbol);
  const selectedEvent = useOverlayStore((s) => s.selectedEvent);
  const latestStocks = useOverlayStore((s) => s.latestStocks);
  const latestFx = useOverlayStore((s) => s.latestFx);
  const latestCommodities = useOverlayStore((s) => s.latestCommodities);

  const liveEvent = useMemo<SignalEvent | null>(() => {
    if (!selectedSymbol) return null;
    if (selectedEvent) {
      const evSym = pickSymbol(selectedEvent);
      if (evSym && evSym.toUpperCase() === selectedSymbol) return selectedEvent;
    }
    const all = [...latestStocks, ...latestFx, ...latestCommodities];
    return (
      all.find((e) => {
        const s = pickSymbol(e);
        return s && s.toUpperCase() === selectedSymbol;
      }) ?? null
    );
  }, [
    selectedSymbol,
    selectedEvent,
    latestStocks,
    latestFx,
    latestCommodities,
  ]);

  if (!selectedSymbol) return null;

  const props = liveEvent?.properties ?? {};
  const last = asNumber(props.price) ?? asNumber(props.last);
  const pct = asNumber(props.change_pct);
  const direction =
    pct === null ? "flat" : pct > 0 ? "up" : pct < 0 ? "down" : "flat";

  return (
    <aside
      className={`ws-market-dock ws-market-dock--${direction}`}
      data-testid={testId}
      data-symbol={selectedSymbol}
      data-asset-class={selectedAssetClass ?? "unknown"}
      aria-label={`${selectedSymbol} market chart`}
    >
      <header className="ws-market-dock__head">
        <span className="ws-market-dock__symbol">{selectedSymbol}</span>
        {selectedAssetClass ? (
          <span
            className="ws-market-dock__asset"
            data-testid={`${testId}-asset`}
          >
            {labelForAssetClass(selectedAssetClass)}
          </span>
        ) : null}
        {/* Phase 17A.3 — provider honesty pre-flight. Alpha Vantage has
            no native futures coverage, so a futures dock would otherwise
            present like equities and silently degrade. Surfacing the
            limit in the head means the operator sees the constraint
            before reading any numbers. The posture card still carries
            the authoritative provider chip. */}
        {selectedAssetClass === "futures" ? (
          <span
            className="ws-market-dock__limit"
            data-testid={`${testId}-limit`}
            title="Alpha Vantage does not natively cover index/rate futures — posture relies on news pressure only."
          >
            Limited coverage
          </span>
        ) : null}
        {last !== null ? (
          <span className="ws-market-dock__last">{formatPrice(last)}</span>
        ) : null}
        {pct !== null ? (
          <span
            className={`ws-market-dock__pct ws-market-dock__pct--${direction}`}
          >
            {pct >= 0 ? "+" : ""}
            {pct.toFixed(2)}%
          </span>
        ) : null}
        <button
          type="button"
          className="ws-market-dock__close"
          onClick={() => selectMarketSymbol(null)}
          aria-label="Close market chart"
          data-testid={`${testId}-close`}
        >
          ×
        </button>
      </header>
      <MarketChart
        symbol={selectedSymbol}
        asOf={asOf}
        height={220}
        testId={`${testId}-chart`}
        hideUnavailable
        compact
      />
      <MarketPostureCard
        symbol={selectedSymbol}
        assetClass={mapAssetClass(selectedAssetClass)}
        asOf={asOf}
        testId={`${testId}-posture`}
      />
    </aside>
  );
}

function mapAssetClass(
  cls: "equities" | "fx" | "commodities" | "futures" | null,
): "equities" | "fx" | "commodities" | "futures" | "unknown" | null {
  return cls;
}

function labelForAssetClass(
  cls: "equities" | "fx" | "commodities" | "futures",
): string {
  switch (cls) {
    case "equities":
      return "Equity";
    case "fx":
      return "FX";
    case "commodities":
      return "Commodity";
    case "futures":
      return "Future";
  }
}

function pickSymbol(event: SignalEvent): string | null {
  const p = event.properties ?? {};
  if (typeof p.symbol === "string") return p.symbol;
  if (typeof p.pair === "string") return p.pair;
  if (typeof p.commodity === "string") return p.commodity;
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatPrice(value: number): string {
  if (Math.abs(value) < 10) return value.toFixed(4);
  return value.toFixed(2);
}
