// Wave 15B — chart wrapper tests.
//
// jsdom has no canvas, so the lightweight-charts API is mocked. We assert
// the wrapper's responsibilities: candle-vs-line series choice, overlay
// rendering, marker placement, volume series, and as-of truncation.

import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("lightweight-charts", () => {
  const series = () => ({
    setData: vi.fn(),
    setMarkers: vi.fn(),
    priceScale: () => ({ applyOptions: vi.fn() }),
  });
  const addCandlestickSeries = vi.fn().mockImplementation(series);
  const addLineSeries = vi.fn().mockImplementation(series);
  const addHistogramSeries = vi.fn().mockImplementation(series);
  const removeSeries = vi.fn();
  const chart = {
    addCandlestickSeries,
    addLineSeries,
    addHistogramSeries,
    removeSeries,
    timeScale: () => ({ fitContent: vi.fn() }),
    applyOptions: vi.fn(),
    remove: vi.fn(),
  };
  return {
    createChart: vi.fn().mockReturnValue(chart),
    ColorType: { Solid: "solid" },
    LineStyle: { Solid: 0, Dashed: 2 },
  };
});

import * as LightweightCharts from "lightweight-charts";
import {
  TheSphereChart,
  type ChartOverlay,
} from "@/components/charts/TheSphereChart";
import type { Candle } from "@/lib/intelligence/types";

function makeCandles(n: number, opts: { ohlcSpread?: boolean } = {}): Candle[] {
  const spread = opts.ohlcSpread ?? true;
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + i;
    return {
      timestamp: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      open: close,
      high: spread ? close + 1 : close,
      low: spread ? close - 1 : close,
      close,
      volume: 1000 + i * 10,
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-wire chart instance because clearAllMocks reset the mock return value.
  const series = () => ({
    setData: vi.fn(),
    setMarkers: vi.fn(),
    priceScale: () => ({ applyOptions: vi.fn() }),
  });
  (LightweightCharts.createChart as ReturnType<typeof vi.fn>).mockReturnValue({
    addCandlestickSeries: vi.fn().mockImplementation(series),
    addLineSeries: vi.fn().mockImplementation(series),
    addHistogramSeries: vi.fn().mockImplementation(series),
    removeSeries: vi.fn(),
    timeScale: () => ({ fitContent: vi.fn() }),
    applyOptions: vi.fn(),
    remove: vi.fn(),
  });
});

afterEach(() => vi.clearAllMocks());

describe("TheSphereChart", () => {
  it("creates a candlestick series when OHLC has meaningful spread", () => {
    render(<TheSphereChart candles={makeCandles(40)} preferCandles />);
    const chart = (LightweightCharts.createChart as ReturnType<typeof vi.fn>).mock
      .results[0]?.value as { addCandlestickSeries: ReturnType<typeof vi.fn> };
    expect(chart.addCandlestickSeries).toHaveBeenCalledTimes(1);
  });

  it("falls back to a line series when OHLC is collapsed (close-only feed)", () => {
    render(
      <TheSphereChart candles={makeCandles(40, { ohlcSpread: false })} preferCandles />,
    );
    const chart = (LightweightCharts.createChart as ReturnType<typeof vi.fn>).mock
      .results[0]?.value as {
        addCandlestickSeries: ReturnType<typeof vi.fn>;
        addLineSeries: ReturnType<typeof vi.fn>;
      };
    expect(chart.addCandlestickSeries).not.toHaveBeenCalled();
    expect(chart.addLineSeries).toHaveBeenCalled();
  });

  it("renders one line series per overlay", () => {
    const overlays: ChartOverlay[] = [
      { id: "a", label: "A", values: Array(40).fill(50), color: "#fff" },
      { id: "b", label: "B", values: Array(40).fill(51), color: "#aaa" },
    ];
    render(
      <TheSphereChart candles={makeCandles(40)} overlays={overlays} preferCandles />,
    );
    const chart = (LightweightCharts.createChart as ReturnType<typeof vi.fn>).mock
      .results[0]?.value as { addLineSeries: ReturnType<typeof vi.fn> };
    expect(chart.addLineSeries).toHaveBeenCalledTimes(2);
  });

  it("adds a histogram series when showVolume is enabled", () => {
    render(
      <TheSphereChart candles={makeCandles(40)} showVolume preferCandles />,
    );
    const chart = (LightweightCharts.createChart as ReturnType<typeof vi.fn>).mock
      .results[0]?.value as { addHistogramSeries: ReturnType<typeof vi.fn> };
    expect(chart.addHistogramSeries).toHaveBeenCalledTimes(1);
  });

  it("truncates candles strictly after the asOf timestamp", () => {
    const candles = makeCandles(40);
    const asOf = new Date(Date.UTC(2026, 0, 10)).toISOString();
    const overlays: ChartOverlay[] = [
      {
        id: "ov",
        label: "ov",
        values: Array.from({ length: 40 }, (_, i) => i),
        color: "#fff",
      },
    ];
    const { getByTestId } = render(
      <TheSphereChart candles={candles} overlays={overlays} asOf={asOf} preferCandles />,
    );
    const node = getByTestId("the-sphere-chart");
    expect(node.getAttribute("data-asof")).toBe(asOf);

    const chart = (LightweightCharts.createChart as ReturnType<typeof vi.fn>).mock
      .results[0]?.value as {
        addCandlestickSeries: ReturnType<typeof vi.fn>;
      };
    // The candle series should have received only the bars at-or-before asOf.
    const candleSeries = chart.addCandlestickSeries.mock.results[0]?.value as {
      setData: ReturnType<typeof vi.fn>;
    };
    const data = candleSeries.setData.mock.calls[0]?.[0] as { time: number }[];
    expect(data.length).toBe(10);
  });

  it("filters markers down to the visible candle window", () => {
    const candles = makeCandles(20);
    const markers = [
      // outside window — before
      { time: new Date(Date.UTC(2025, 0, 1)).toISOString(), color: "#fff" },
      // inside window
      { time: new Date(Date.UTC(2026, 0, 5)).toISOString(), color: "#fff" },
      // outside window — after
      { time: new Date(Date.UTC(2027, 0, 1)).toISOString(), color: "#fff" },
    ];
    render(
      <TheSphereChart candles={candles} markers={markers} preferCandles />,
    );
    const chart = (LightweightCharts.createChart as ReturnType<typeof vi.fn>).mock
      .results[0]?.value as {
        addCandlestickSeries: ReturnType<typeof vi.fn>;
      };
    const series = chart.addCandlestickSeries.mock.results[0]?.value as {
      setMarkers: ReturnType<typeof vi.fn>;
    };
    const placed = series.setMarkers.mock.calls[0]?.[0] as unknown[];
    expect(placed).toHaveLength(1);
  });
});
