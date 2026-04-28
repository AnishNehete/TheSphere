"use client";

import { useEffect, useMemo, useState } from "react";

import {
  TheSphereChart,
  type ChartMarker,
  type ChartOverlay,
} from "@/components/charts/TheSphereChart";
import { TechnicalRatingBadge } from "@/components/charts/TechnicalRatingBadge";
import { ema, lastDefined, macd, rsi, sma } from "@/lib/charts/indicators";
import { deriveTechnicalRating } from "@/lib/charts/rating";
import { getHoldingCandles } from "@/lib/intelligence/client";
import type {
  Candle,
  CandleRange,
  PortfolioLinkedEvent,
} from "@/lib/intelligence/types";

interface PortfolioHoldingChartProps {
  portfolioId: string;
  symbol: string;
  range?: CandleRange;
  asOf?: string | null;
  linkedEvents?: PortfolioLinkedEvent[];
  height?: number;
}

const SMA20_COLOR = "#fbbf24";   // amber
const SMA50_COLOR = "#f97316";   // orange
const SMA200_COLOR = "#ef4444";  // red
const EMA21_COLOR = "#38bdf8";   // sky

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#f87171",
  elevated: "#f97316",
  watch: "#fbbf24",
  info: "#a3a3a3",
};

// Wave 15B — analytical chart surface.
//
// Replaces the Phase 13B.5 single-line chart with a serious indicator stack
// (SMA20/50/200, EMA21, RSI14, MACD), event markers tied to linked world
// signals, and a five-band technical rating that derives from the same
// indicator values. The charting library is hidden behind TheSphereChart
// so the rest of the app never imports lightweight-charts directly.
export function PortfolioHoldingChart({
  portfolioId,
  symbol,
  range = "1y",
  asOf = null,
  linkedEvents = [],
  height = 280,
}: PortfolioHoldingChartProps) {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setCandles(null);
    getHoldingCandles(
      portfolioId,
      symbol,
      { range, as_of: asOf ?? undefined },
      { signal: controller.signal },
    )
      .then((resp) => setCandles(resp.candles))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Chart unavailable");
      });
    return () => controller.abort();
  }, [portfolioId, symbol, range, asOf]);

  const indicators = useMemo(() => {
    if (!candles || candles.length === 0) return null;
    const closes = candles.map((c) => c.close);
    const sma20Series = sma(closes, 20);
    const sma50Series = sma(closes, 50);
    const sma200Series = sma(closes, 200);
    const ema21Series = ema(closes, 21);
    const rsi14Series = rsi(closes, 14);
    const macdResult = macd(closes);
    return {
      sma20: sma20Series,
      sma50: sma50Series,
      sma200: sma200Series,
      ema21: ema21Series,
      rsi14: rsi14Series,
      macd: macdResult,
    };
  }, [candles]);

  const overlays = useMemo<ChartOverlay[]>(() => {
    if (!indicators || !candles) return [];
    const list: ChartOverlay[] = [];
    if (candles.length >= 20) {
      list.push({
        id: "sma20",
        label: "SMA 20",
        values: indicators.sma20,
        color: SMA20_COLOR,
        dashed: true,
        lineWidth: 1,
      });
    }
    if (candles.length >= 50) {
      list.push({
        id: "sma50",
        label: "SMA 50",
        values: indicators.sma50,
        color: SMA50_COLOR,
        lineWidth: 1,
      });
    }
    if (candles.length >= 200) {
      list.push({
        id: "sma200",
        label: "SMA 200",
        values: indicators.sma200,
        color: SMA200_COLOR,
        lineWidth: 1,
      });
    }
    if (candles.length >= 21) {
      list.push({
        id: "ema21",
        label: "EMA 21",
        values: indicators.ema21,
        color: EMA21_COLOR,
        dashed: true,
        lineWidth: 1,
      });
    }
    return list;
  }, [indicators, candles]);

  const markers = useMemo<ChartMarker[]>(() => {
    return linkedEvents
      .filter((e) => Boolean(e.source_timestamp))
      .map((e) => ({
        time: e.source_timestamp as string,
        label: e.title,
        color: SEVERITY_COLOR[e.severity] ?? SEVERITY_COLOR.info,
        shape: e.severity === "critical" ? "arrowDown" : "circle",
        position: "aboveBar",
      }));
  }, [linkedEvents]);

  const rating = useMemo(() => {
    if (!indicators || !candles || candles.length === 0) return null;
    const close = candles[candles.length - 1].close;
    const macdHistory = indicators.macd;
    return deriveTechnicalRating({
      close,
      sma20: lastDefined(indicators.sma20),
      sma50: lastDefined(indicators.sma50),
      sma200: lastDefined(indicators.sma200),
      ema21: lastDefined(indicators.ema21),
      rsi14: lastDefined(indicators.rsi14),
      macd: {
        macd: lastDefined(macdHistory.macd),
        signal: lastDefined(macdHistory.signal),
        histogram: lastDefined(macdHistory.histogram),
      },
    });
  }, [indicators, candles]);

  const overlayLegend = overlays.map((o) => o.label).join(" · ");

  return (
    <section
      className="ws-section ws-portfolio-section ws-portfolio-chart"
      data-testid="portfolio-holding-chart"
    >
      <header
        className="ws-chart-meta"
        data-testid="portfolio-holding-chart-meta"
      >
        <span className="ws-chart-meta__symbol">{symbol}</span>
        <span className="ws-chart-meta__chip">{range.toUpperCase()}</span>
        <span
          className={`ws-chart-meta__chip ws-chart-meta__chip--${asOf ? "asof" : "live"}`}
          data-testid="portfolio-holding-chart-asof"
        >
          {asOf ? `As-of ${asOf.slice(0, 10)}` : "Live"}
        </span>
        {rating ? (
          <TechnicalRatingBadge result={rating} inline />
        ) : null}
        {overlayLegend ? (
          <span className="ws-chart-meta__overlays" title={overlayLegend}>
            {overlayLegend}
          </span>
        ) : null}
      </header>
      {error ? (
        <p className="ws-muted">Chart unavailable. {error}</p>
      ) : null}
      {!error ? (
        <TheSphereChart
          candles={candles ?? []}
          asOf={asOf}
          overlays={overlays}
          markers={markers}
          showVolume
          preferCandles
          height={height}
          ariaLabel={`${symbol} price chart`}
          testId="portfolio-holding-chart-canvas"
          className="ws-portfolio-chart__canvas"
        />
      ) : null}
      {rating ? (
        <TechnicalRatingBadge result={rating} />
      ) : null}
    </section>
  );
}
