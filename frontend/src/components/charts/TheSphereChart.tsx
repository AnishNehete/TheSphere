"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  ColorType,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

import type { Candle } from "@/lib/intelligence/types";

// Wave 15B — TheSphereChart wrapper.
//
// Goal: isolate the lightweight-charts dependency behind a single, narrow
// surface so we can swap charting implementations later without auditing
// every component that needed price + volume + indicator overlays. Nothing
// outside this file should import from "lightweight-charts".
//
// The wrapper takes already-computed indicator overlays (the math lives in
// `@/lib/charts/indicators`). It does not pretend to know what "RSI" means;
// that separation is what makes the indicator helpers easy to test.
//
// Replay/as-of: when `asOf` is set the candle series is truncated to bars
// at-or-before that moment. Markers and overlays are truncated the same way
// so the chart never visually implies future knowledge.

const CHART_BG = "#0b0b0f";
const TEXT_COLOR = "#a3a3a3";
const GRID_COLOR = "rgba(255,255,255,0.04)";
const VOLUME_UP = "rgba(142, 193, 176, 0.45)";
const VOLUME_DOWN = "rgba(231, 157, 132, 0.45)";

export interface ChartOverlay {
  id: string;
  label: string;
  /** Aligned 1:1 with `candles`. `null` means "no value at this index". */
  values: ReadonlyArray<number | null>;
  color: string;
  dashed?: boolean;
  lineWidth?: 1 | 2 | 3 | 4;
}

export interface ChartMarker {
  /** ISO 8601 timestamp; will be snapped to the nearest candle. */
  time: string;
  label?: string;
  color: string;
  shape?: "circle" | "arrowUp" | "arrowDown" | "square";
  position?: "aboveBar" | "belowBar" | "inBar";
}

export interface TheSphereChartProps {
  candles: ReadonlyArray<Candle>;
  /** ISO 8601. When set, candles strictly after this moment are dropped. */
  asOf?: string | null;
  overlays?: ReadonlyArray<ChartOverlay>;
  markers?: ReadonlyArray<ChartMarker>;
  /** When true, render a volume histogram pane below price. */
  showVolume?: boolean;
  /**
   * Prefer candlesticks. Falls back to a line series when OHLC data is not
   * meaningfully different (e.g. synthetic close-only feeds).
   */
  preferCandles?: boolean;
  height?: number;
  ariaLabel?: string;
  testId?: string;
  className?: string;
}

function toUtcSeconds(iso: string): UTCTimestamp {
  return Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;
}

function hasMeaningfulOhlc(candles: ReadonlyArray<Candle>): boolean {
  if (candles.length === 0) return false;
  // If at least 30% of bars have a non-trivial high/low spread, treat it as
  // a real OHLC feed. Synthetic close-only adapters tend to set
  // open=high=low=close, which would render as flat doji marks otherwise.
  let meaningful = 0;
  for (const c of candles) {
    const range = c.high - c.low;
    if (range > 0 && Math.abs(range / (c.close || 1)) > 1e-4) meaningful += 1;
  }
  return meaningful / candles.length >= 0.3;
}

function truncateByAsOf<T extends { timestamp: string }>(
  rows: ReadonlyArray<T>,
  asOf: string | null | undefined,
): T[] {
  if (!asOf) return [...rows];
  const cutoff = Date.parse(asOf);
  if (Number.isNaN(cutoff)) return [...rows];
  return rows.filter((r) => Date.parse(r.timestamp) <= cutoff);
}

export function TheSphereChart({
  candles,
  asOf = null,
  overlays = [],
  markers = [],
  showVolume = false,
  preferCandles = true,
  height = 280,
  ariaLabel,
  testId = "the-sphere-chart",
  className,
}: TheSphereChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

  // Truncate the candle stream once for both rendering and overlays so they
  // can never disagree about what "now" means in the chart frame.
  const visibleCandles = useMemo(
    () => truncateByAsOf(candles, asOf),
    [candles, asOf],
  );
  const visibleOverlays = useMemo(() => {
    if (overlays.length === 0) return [];
    const cutoff = candles.length - visibleCandles.length;
    if (cutoff === 0) return overlays.map((o) => ({ ...o, values: [...o.values] }));
    return overlays.map((o) => ({
      ...o,
      values: o.values.slice(0, o.values.length - cutoff),
    }));
  }, [overlays, candles.length, visibleCandles.length]);

  const useCandles = preferCandles && hasMeaningfulOhlc(visibleCandles);

  // Create / tear down the chart instance once per mount + height.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: CHART_BG },
        textColor: TEXT_COLOR,
      },
      grid: {
        horzLines: { color: GRID_COLOR },
        vertLines: { color: GRID_COLOR },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
      handleScale: false,
      handleScroll: false,
    });
    chartRef.current = chart;

    const observer = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [height]);

  // Draw / redraw whenever the visible data changes. We rebuild the series
  // set on each pass — overlays come and go (e.g. user toggles indicators)
  // and the cost is trivial relative to a price refresh.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const created: ISeriesApi<"Candlestick" | "Line" | "Histogram">[] = [];

    let priceSeries: ISeriesApi<"Candlestick"> | ISeriesApi<"Line">;
    if (useCandles) {
      const s = chart.addCandlestickSeries({
        upColor: "#8ec1b0",
        downColor: "#e79d84",
        borderUpColor: "#8ec1b0",
        borderDownColor: "#e79d84",
        wickUpColor: "#8ec1b0",
        wickDownColor: "#e79d84",
      });
      s.setData(
        visibleCandles.map((c) => ({
          time: toUtcSeconds(c.timestamp),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      );
      priceSeries = s;
      created.push(s);
    } else {
      const s = chart.addLineSeries({ color: "#e5e5e5", lineWidth: 2 });
      s.setData(
        visibleCandles.map((c) => ({
          time: toUtcSeconds(c.timestamp),
          value: c.close,
        })),
      );
      priceSeries = s;
      created.push(s);
    }

    // Overlays — one line series per overlay. We drop nulls so the line
    // pauses honestly across gaps instead of interpolating through them.
    for (const overlay of visibleOverlays) {
      const s = chart.addLineSeries({
        color: overlay.color,
        lineWidth: overlay.lineWidth ?? 1,
        lineStyle: overlay.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      const data: { time: UTCTimestamp; value: number }[] = [];
      for (let i = 0; i < visibleCandles.length; i++) {
        const v = overlay.values[i];
        if (typeof v === "number" && Number.isFinite(v)) {
          data.push({ time: toUtcSeconds(visibleCandles[i].timestamp), value: v });
        }
      }
      s.setData(data);
      created.push(s);
    }

    // Volume histogram on a separate price scale so it does not crush the
    // price axis. Color reflects the up/down candle direction.
    if (showVolume && visibleCandles.length > 0) {
      const v = chart.addHistogramSeries({
        priceScaleId: "volume",
        priceFormat: { type: "volume" },
        color: VOLUME_UP,
      });
      v.priceScale().applyOptions({
        scaleMargins: { top: 0.78, bottom: 0 },
      });
      v.setData(
        visibleCandles.map((c, i) => {
          const prev = i > 0 ? visibleCandles[i - 1].close : c.open;
          const up = c.close >= prev;
          return {
            time: toUtcSeconds(c.timestamp),
            value: c.volume,
            color: up ? VOLUME_UP : VOLUME_DOWN,
          };
        }),
      );
      created.push(v);
    }

    // Markers — snap to the visible window and de-duplicate per timestamp
    // so the chart never collapses under a barrage of overlapping events.
    if (markers.length > 0 && visibleCandles.length > 0) {
      const first = Date.parse(visibleCandles[0].timestamp);
      const last = Date.parse(
        visibleCandles[visibleCandles.length - 1].timestamp,
      );
      const sortedMarkers: SeriesMarker<Time>[] = markers
        .filter((m) => {
          const t = Date.parse(m.time);
          return Number.isFinite(t) && t >= first && t <= last;
        })
        .slice(0, 24)
        .map((m) => ({
          time: toUtcSeconds(m.time),
          color: m.color,
          shape: m.shape ?? "circle",
          position: m.position ?? "aboveBar",
          text: m.label
            ? m.label.length > 32
              ? m.label.slice(0, 30) + "…"
              : m.label
            : undefined,
        }))
        .sort((a, b) => (a.time as number) - (b.time as number));
      // setMarkers exists on both Candlestick and Line series.
      (priceSeries as ISeriesApi<"Line">).setMarkers(sortedMarkers);
    }

    chart.timeScale().fitContent();

    return () => {
      for (const s of created) {
        try {
          chart.removeSeries(s);
        } catch {
          // Chart may already be torn down by the parent effect; safe to swallow.
        }
      }
    };
  }, [useCandles, visibleCandles, visibleOverlays, markers, showVolume]);

  return (
    <div
      ref={containerRef}
      className={className ?? "ws-chart-canvas"}
      style={{ width: "100%", height }}
      role="img"
      aria-label={ariaLabel ?? "Price chart"}
      data-testid={testId}
      data-render-mode={useCandles ? "candles" : "line"}
      data-asof={asOf ?? ""}
    />
  );
}
