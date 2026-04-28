// Phase 16.6 hotfix — honest market snapshot in EventPanel.
//
// Verifies that for any market event with at least two of {price, prev,
// day_low, day_high}, an inline snapshot renders with the symbol, last,
// and percent change. Non-market events do not get a snapshot.

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventPanel } from "@/components/workspace/EventPanel";
import type { SignalEvent } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

vi.mock("@/lib/intelligence/client", () => ({
  getHoldingCandles: vi.fn(() => new Promise(() => undefined)),
  getMarketCandles: vi.fn(() => new Promise(() => undefined)),
  // Phase 17A.2 — EventPanel now mounts MarketPostureCard for market
  // events, which calls getMarketPosture on render. Stub a never-
  // resolving promise so the snapshot tests don't fight an unmocked
  // network call.
  getMarketPosture: vi.fn(() => new Promise(() => undefined)),
  // Phase 17A.3 — narrative fetch fires lazily after posture lands;
  // stubbed identically since posture itself never resolves here.
  getMarketNarrative: vi.fn(() => new Promise(() => undefined)),
  getDependenciesForEvent: vi.fn(() => new Promise(() => undefined)),
  getDependenciesForCountry: vi.fn(() => new Promise(() => undefined)),
}));

function makeMarketEvent(overrides: Partial<SignalEvent> = {}): SignalEvent {
  return {
    id: "eq:AAPL",
    dedupe_key: "eq:AAPL",
    type: "stocks",
    title: "AAPL",
    summary: "Apple session pop on iPhone shipments.",
    severity: "info",
    severity_score: 0.1,
    confidence: 0.9,
    status: "active",
    source_timestamp: "2026-04-26T15:00:00Z",
    ingested_at: "2026-04-26T15:00:00Z",
    place: {
      country_code: "USA",
      country_name: "United States",
      locality: null,
      region: null,
      admin1: null,
      latitude: null,
      longitude: null,
    },
    properties: {
      symbol: "AAPL",
      price: 184.2,
      previous_close: 182.0,
      day_low: 181.4,
      day_high: 184.7,
      change_pct: 1.2,
    },
    sources: [],
    tags: [],
    entities: [],
    sub_type: null,
    description: null,
    merged_from: [],
    score: null,
    start_time: null,
    end_time: null,
    ...overrides,
  };
}

function reset() {
  useOverlayStore.setState({
    selectedEvent: null,
    selectedEventId: null,
    selectedPortfolio: null,
    selectedPortfolioId: null,
    selectedMarketSymbol: null,
    portfolioAsOf: null,
  });
}

beforeEach(reset);
afterEach(reset);

describe("Market snapshot in EventPanel (Phase 16.6 hotfix)", () => {
  it("renders an honest day-range snapshot for a stocks event", () => {
    const event = makeMarketEvent();
    useOverlayStore.setState({
      selectedEvent: event,
      selectedEventId: event.id,
    });
    render(<EventPanel />);

    const snap = screen.getByTestId("event-panel-snapshot");
    expect(snap.getAttribute("data-symbol")).toBe("AAPL");
    expect(snap.textContent).toContain("AAPL");
    expect(snap.textContent).toContain("+1.20%");
  });

  it("places both prev-close and last markers when both are present", () => {
    const event = makeMarketEvent();
    useOverlayStore.setState({
      selectedEvent: event,
      selectedEventId: event.id,
    });
    render(<EventPanel />);

    expect(screen.getByTestId("snapshot-marker-prev")).toBeInTheDocument();
    expect(screen.getByTestId("snapshot-marker-last")).toBeInTheDocument();
  });

  it("renders the universal market chart even when no portfolio holds the symbol", () => {
    const event = makeMarketEvent();
    useOverlayStore.setState({
      selectedEvent: event,
      selectedEventId: event.id,
    });
    render(<EventPanel />);

    // Phase 16.7: universal chart is no longer gated on portfolio
    // membership — any market-class signal mounts the chart directly.
    expect(screen.getByTestId("event-panel-chart")).toBeInTheDocument();
    expect(
      screen.queryByTestId("event-panel-portfolio-compare"),
    ).not.toBeInTheDocument();
  });

  it("does not render the snapshot for non-market events", () => {
    const news = makeMarketEvent({
      id: "news:1",
      type: "news",
      title: "Headline",
      properties: { tone: 0.2 },
    });
    useOverlayStore.setState({
      selectedEvent: news,
      selectedEventId: news.id,
    });
    render(<EventPanel />);

    expect(
      screen.queryByTestId("event-panel-snapshot"),
    ).not.toBeInTheDocument();
  });
});
