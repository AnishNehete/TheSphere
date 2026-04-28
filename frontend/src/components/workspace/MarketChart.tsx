"use client";

import { useEffect, useMemo, useState } from "react";

import {
  TheSphereChart,
  type ChartOverlay,
} from "@/components/charts/TheSphereChart";
import { TechnicalRatingBadge } from "@/components/charts/TechnicalRatingBadge";
import { ema, lastDefined, macd, rsi, sma } from "@/lib/charts/indicators";
import { deriveTechnicalRating } from "@/lib/charts/rating";
import { getMarketCandles } from "@/lib/intelligence/client";
import type { Candle, CandleRange } from "@/lib/intelligence/types";

// Phase 16.7 — universal market chart.
//
// Mirrors the indicator stack of `PortfolioHoldingChart` but is decoupled
// from portfolio context. Any supported equity / FX / commodity / future
// can be charted by handing the wrapper a symbol — no holdings required.
//
// We deliberately reuse `TheSphereChart` so there is exactly one charting
// library boundary in the workspace. Honest-data rule: an empty candle
// stream renders an "unavailable" state, never a fabricated series.

interface MarketChartProps {
  symbol: string;
  range?: CandleRange;
  asOf?: string | null;
  height?: number;
  testId?: string;
  /**
   * When true, the chart silently renders nothing instead of the
   * "Chart unavailable" / error affordance when candles are empty or
   * the request fails. Used wherever a sibling surface (e.g. the
   * MarketPostureCard) already explains why the symbol has no chart —
   * we don't want the operator reading two different "unavailable"
   * messages for the same fact.
   */
  hideUnavailable?: boolean;
  /**
   * Phase 17A.3 — when rendered inside a parent that already shows the
   * symbol prominently (e.g. MarketDock head), drop the duplicate symbol
   * label from the chart's own meta row so the operator doesn't read
   * the symbol twice. Range / as-of chips and indicator legend still
   * render so the chart context stays self-explanatory.
   */
  compact?: boolean;
}

const SMA20_COLOR = "#fbbf24";
const SMA50_COLOR = "#f97316";
const SMA200_COLOR = "#ef4444";
const EMA21_COLOR = "#38bdf8";

export function MarketChart({
  symbol,
  range = "1y",
  asOf = null,
  height = 240,
  testId = "market-chart",
  hideUnavailable = false,
  compact = false,
}: MarketChartProps) {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<string>("…");

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setCandles(null);
    getMarketCandles(
      symbol,
      { range, as_of: asOf ?? undefined },
      { signal: controller.signal },
    )
      .then((resp) => {
        setCandles(resp.candles);
        setProvider(resp.provider);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Chart unavailable");
      });
    return () => controller.abort();
  }, [symbol, range, asOf]);

  const indicators = useMemo(() => {
    if (!candles || candles.length === 0) return null;
    const closes = candles.map((c) => c.close);
    return {
      sma20: sma(closes, 20),
      sma50: sma(closes, 50),
      sma200: sma(closes, 200),
      ema21: ema(closes, 21),
      rsi14: rsi(closes, 14),
      macd: macd(closes),
    };
  }, [candles]);

  const overlays = useMemo<ChartOverlay[]>(() => {
    if (!indicators || !candles) return [];
    const list: ChartOverlay[] = [];
    if (candles.length >= 20)
      list.push({ id: "sma20", label: "SMA 20", values: indicators.sma20, color: SMA20_COLOR, dashed: true, lineWidth: 1 });
    if (candles.length >= 50)
      list.push({ id: "sma50", label: "SMA 50", values: indicators.sma50, color: SMA50_COLOR, lineWidth: 1 });
    if (candles.length >= 200)
      list.push({ id: "sma200", label: "SMA 200", values: indicators.sma200, color: SMA200_COLOR, lineWidth: 1 });
    if (candles.length >= 21)
      list.push({ id: "ema21", label: "EMA 21", values: indicators.ema21, color: EMA21_COLOR, dashed: true, lineWidth: 1 });
    return list;
  }, [indicators, candles]);

  const rating = useMemo(() => {
    if (!indicators || !candles || candles.length === 0) return null;
    const close = candles[candles.length - 1].close;
    return deriveTechnicalRating({
      close,
      sma20: lastDefined(indicators.sma20),
      sma50: lastDefined(indicators.sma50),
      sma200: lastDefined(indicators.sma200),
      ema21: lastDefined(indicators.ema21),
      rsi14: lastDefined(indicators.rsi14),
      macd: {
        macd: lastDefined(indicators.macd.macd),
        signal: lastDefined(indicators.macd.signal),
        histogram: lastDefined(indicators.macd.histogram),
      },
    });
  }, [indicators, candles]);

  const overlayLegend = overlays.map((o) => o.label).join(" · ");
  const isEmpty = candles !== null && candles.length === 0 && !error;
  const isSynthetic = provider.toLowerCase().includes("synthetic");
  const sourceChipKind = asOf ? "asof" : isSynthetic ? "demo" : "live";
  const sourceChipLabel = asOf
    ? `As-of ${asOf.slice(0, 10)}`
    : isSynthetic
      ? "Demo data"
      : "Live";

  // When `hideUnavailable` is set and we have no chart to draw, render
  // nothing — the surrounding surface (e.g. MarketPostureCard) already
  // tells the operator what's going on, and double-stating it ("Chart
  // unavailable" + "Not covered · Alpha Vantage") was confusing.
  if (hideUnavailable && (error || isEmpty)) {
    return null;
  }

  return (
    <section
      className="ws-market-chart"
      data-testid={testId}
      data-symbol={symbol.toUpperCase()}
      data-provider={provider}
    >
      <header
        className={`ws-chart-meta${compact ? " ws-chart-meta--compact" : ""}`}
        data-testid={`${testId}-meta`}
      >
        {compact ? null : (
          <span className="ws-chart-meta__symbol">{symbol.toUpperCase()}</span>
        )}
        <span className="ws-chart-meta__chip">{range.toUpperCase()}</span>
        <span
          className={`ws-chart-meta__chip ws-chart-meta__chip--${sourceChipKind}`}
          data-testid={`${testId}-asof`}
          title={
            isSynthetic
              ? `Provider ${provider}: no live key configured — showing deterministic demo candles`
              : undefined
          }
        >
          {sourceChipLabel}
        </span>
        {rating ? <TechnicalRatingBadge result={rating} inline /> : null}
        {overlayLegend ? (
          <span className="ws-chart-meta__overlays" title={overlayLegend}>
            {overlayLegend}
          </span>
        ) : null}
      </header>
      {error ? (
        <p className="ws-muted" data-testid={`${testId}-error`}>
          Chart unavailable. {error}
        </p>
      ) : null}
      {isEmpty ? (
        <p
          className="ws-muted"
          data-testid={`${testId}-empty`}
        >
          No price history for {symbol.toUpperCase()} from the configured
          provider ({provider}). This may mean the symbol is outside
          coverage rather than a transient gap — check the posture card
          for provider health.
        </p>
      ) : null}
      {!error && !isEmpty ? (
        <TheSphereChart
          candles={candles ?? []}
          asOf={asOf}
          overlays={overlays}
          showVolume
          preferCandles
          height={height}
          ariaLabel={`${symbol} price chart`}
          testId={`${testId}-canvas`}
          className="ws-market-chart__canvas"
        />
      ) : null}
      {/* Phase 17A.3 hotfix — in compact (dock) mode the inline rating
          chip in the meta header already conveys the SELL/HOLD/BUY
          call, so we skip the verbose rating breakdown here. The
          verbose card with all six indicator tiles is kept for the
          full-detail surfaces (event panel, portfolio holding chart). */}
      {rating && !compact ? (
        <TechnicalRatingBadge result={rating} />
      ) : null}
    </section>
  );
}
