// Wave 15B — PortfolioHoldingChart smoke test.
//
// Mocks lightweight-charts (no canvas in jsdom) and the intelligence client.
// Verifies the holding chart fetches candles, mounts the chart wrapper, and
// degrades cleanly when the candle endpoint fails. The detailed shape of the
// indicator overlays is asserted in the indicator and chart-wrapper tests.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("lightweight-charts", () => {
  const series = () => ({
    setData: vi.fn(),
    setMarkers: vi.fn(),
    priceScale: () => ({ applyOptions: vi.fn() }),
  });
  const chart = {
    addCandlestickSeries: vi.fn().mockImplementation(series),
    addLineSeries: vi.fn().mockImplementation(series),
    addHistogramSeries: vi.fn().mockImplementation(series),
    removeSeries: vi.fn(),
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

vi.mock("@/lib/intelligence/client", () => ({
  getHoldingCandles: vi.fn(),
}));

(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};

import * as LightweightCharts from "lightweight-charts";
import * as IntelligenceClient from "@/lib/intelligence/client";
import { PortfolioHoldingChart } from "@/components/workspace/PortfolioHoldingChart";

beforeEach(() => {
  vi.clearAllMocks();
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

afterEach(() => {
  vi.clearAllMocks();
});

describe("PortfolioHoldingChart", () => {
  it("fetches candles, mounts the chart wrapper, and renders a technical rating", async () => {
    const candles = Array.from({ length: 60 }, (_, i) => ({
      timestamp: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100 + i,
      volume: 1000,
    }));

    (IntelligenceClient.getHoldingCandles as ReturnType<typeof vi.fn>).mockResolvedValue({
      portfolio_id: "port_demo",
      symbol: "AAPL",
      range: "1y",
      as_of: null,
      provider: "synthetic",
      candles,
    });

    render(
      <PortfolioHoldingChart
        portfolioId="port_demo"
        symbol="AAPL"
        linkedEvents={[
          {
            event_id: "e1",
            title: "Headline event",
            type: "news",
            severity: "elevated",
            severity_score: 0.7,
            country_code: "USA",
            country_name: "United States",
            source_timestamp: new Date(Date.UTC(2026, 0, 15)).toISOString(),
            publisher: "test",
            url: null,
            matched_exposure_node_ids: ["country:USA"],
          },
        ]}
      />,
    );

    await waitFor(() =>
      expect(IntelligenceClient.getHoldingCandles).toHaveBeenCalledOnce(),
    );
    await waitFor(() =>
      expect(LightweightCharts.createChart).toHaveBeenCalled(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("technical-rating")).toBeInTheDocument(),
    );
  });

  it("surfaces honest error copy when candle fetch fails", async () => {
    (IntelligenceClient.getHoldingCandles as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network error"),
    );

    render(<PortfolioHoldingChart portfolioId="port_demo" symbol="AAPL" />);

    await waitFor(() =>
      expect(
        screen.getByTestId("portfolio-holding-chart").textContent,
      ).toContain("Chart unavailable"),
    );
  });
});
