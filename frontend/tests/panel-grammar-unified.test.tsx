// Wave 15C — unified panel grammar tests.
//
// Beyond 15B's EventPanel-only grammar contract, every analyst-facing panel
// now exposes a `data-grammar-field` metadata strip. We assert that:
//   - EventPanel keeps the canonical 15B fields
//   - CountryPanel exposes scope · severity · confidence · freshness
//   - PortfolioPanel exposes scope · confidence · freshness · status
//   - QueryPanel exposes scope · confidence · freshness · status
//   - the workspace-wide ReplayBadge appears in each panel and respects asOf

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CountryPanel } from "@/components/workspace/CountryPanel";
import { EventPanel } from "@/components/workspace/EventPanel";
import { PortfolioPanel } from "@/components/workspace/PortfolioPanel";
import type {
  CountryDetailResponse,
  PortfolioBrief,
  PortfolioRecord,
  SignalEvent,
} from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

vi.mock("@/lib/intelligence/client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/intelligence/client")
  >("@/lib/intelligence/client");
  // Mocks return pending promises — the panels under test render their
  // grammar-strip from the store payload we set, not from network.
  const pending = () => new Promise(() => undefined);
  return {
    ...actual,
    getCountrySummary: vi.fn(pending),
    getPortfolio: vi.fn(pending),
    getPortfolioBrief: vi.fn(pending),
    getPortfolioTechnical: vi.fn(pending),
    getPortfolioSemantic: vi.fn(pending),
    getPortfolioRiskScore: vi.fn(pending),
    queryAgent: vi.fn(pending),
    getHoldingCandles: vi.fn(pending),
    // Phase 17A.2 — EventPanel mounts MarketPostureCard which calls
    // this for any market-class signal.
    getMarketCandles: vi.fn(pending),
    getMarketPosture: vi.fn(pending),
    // Phase 17A.3 — narrative client; lazy-fetched once posture lands.
    getMarketNarrative: vi.fn(pending),
  };
});

function makeEvent(overrides: Partial<SignalEvent> = {}): SignalEvent {
  return {
    id: "evt-1",
    dedupe_key: "evt-1",
    type: "news",
    sub_type: null,
    title: "Headline shock in Berlin",
    summary: "Reports of a sudden disruption affecting downstream logistics.",
    description: null,
    severity: "elevated",
    severity_score: 0.72,
    confidence: 0.65,
    status: "active",
    place: {
      latitude: 52.52,
      longitude: 13.4,
      country_code: "DEU",
      country_name: "Germany",
      region: "Brandenburg",
      admin1: null,
      locality: "Berlin",
    },
    start_time: null,
    end_time: null,
    source_timestamp: "2026-04-24T11:00:00Z",
    ingested_at: "2026-04-24T11:01:00Z",
    sources: [],
    merged_from: [],
    tags: [],
    entities: [],
    score: null,
    properties: {},
    ...overrides,
  };
}

beforeEach(() => {
  useOverlayStore.getState().closeOverlay();
});

describe("Unified panel grammar", () => {
  it("EventPanel exposes the canonical 15B metadata fields", () => {
    useOverlayStore.getState().openEvent(makeEvent());
    render(<EventPanel />);
    const meta = screen.getByTestId("signal-grammar-meta");
    const fields = Array.from(
      meta.querySelectorAll("[data-grammar-field]"),
    ).map((el) => el.getAttribute("data-grammar-field"));
    expect(fields.slice(0, 5)).toEqual([
      "domain",
      "severity",
      "confidence",
      "freshness",
      "status",
    ]);
  });

  it("EventPanel renders a ReplayBadge that flips to as-of when set", () => {
    useOverlayStore.getState().openEvent(makeEvent());
    useOverlayStore.getState().setPortfolioAsOf("2026-04-01T12:00:00Z");
    render(<EventPanel />);
    const badge = screen.getByTestId("event-panel-replay-badge");
    expect(badge).toHaveAttribute("data-asof", "2026-04-01T12:00:00Z");
    expect(badge.textContent).toContain("As-of");
  });

  it("EventPanel shows the trend strip with three windows", () => {
    useOverlayStore.getState().openEvent(makeEvent());
    render(<EventPanel />);
    const strip = screen.getByTestId("trend-strip");
    expect(strip.querySelectorAll("[data-window]")).toHaveLength(3);
  });

  it("EventPanel surfaces a market-relevance section with mapped DEU symbols", () => {
    useOverlayStore.getState().openEvent(makeEvent());
    render(<EventPanel />);
    const list = screen.getByTestId("signal-grammar-market-symbols");
    expect(list.textContent).toContain("EWG");
  });

  it("CountryPanel exposes scope · severity · confidence · freshness fields", () => {
    const detail: CountryDetailResponse = {
      summary: {
        country_code: "DEU",
        country_name: "Germany",
        updated_at: "2026-04-24T12:00:00Z",
        watch_score: 0.42,
        watch_delta: 0.05,
        watch_label: "elevated",
        counts_by_category: {},
        top_signals: [],
        headline_signal_id: null,
        confidence: 0.72,
        sources: [],
        summary: "Stable.",
      },
      events: [],
    };
    useOverlayStore.getState().openCountry("DEU", "Germany");
    useOverlayStore.getState().setCountryDetail(detail);
    render(<CountryPanel />);
    const meta = screen.getByTestId("country-grammar-meta");
    const fields = Array.from(
      meta.querySelectorAll("[data-grammar-field]"),
    ).map((el) => el.getAttribute("data-grammar-field"));
    expect(fields).toEqual(["scope", "severity", "confidence", "freshness"]);
    expect(screen.getByTestId("country-panel-replay-badge")).toBeInTheDocument();
  });

  it("PortfolioPanel exposes a metadata strip with replay badge", async () => {
    const portfolio: PortfolioRecord = {
      id: "p1",
      name: "Demo",
      description: null,
      base_currency: "USD",
      benchmark_symbol: null,
      notes: null,
      tags: [],
      created_at: "2026-04-01T00:00:00Z",
      updated_at: "2026-04-24T00:00:00Z",
      holdings: [],
    };
    const brief: PortfolioBrief = {
      portfolio_id: "p1",
      name: "Demo",
      base_currency: "USD",
      generated_at: "2026-04-24T12:00:00Z",
      holdings_count: 3,
      holdings: [],
      exposure_summary: {
        countries: [],
        sectors: [],
        currencies: [],
        commodities: [],
        macro_themes: [],
        chokepoints: [],
      },
      exposure_graph: { portfolio_id: "p1", nodes: [], edges: [] },
      dependency_paths: [],
      top_risks: [],
      linked_events: [],
      entity: {
        id: "p1",
        name: "Demo",
        primary_country_codes: [],
        primary_sectors: [],
        primary_currencies: [],
      },
      confidence: 0.62,
      notes: [],
      valuation_summary: null,
    };
    useOverlayStore.getState().openPortfolio("p1", portfolio);
    useOverlayStore.getState().setPortfolioBrief(brief);
    useOverlayStore.getState().setPortfolioRecord(portfolio);
    render(<PortfolioPanel />);
    const meta = screen.getByTestId("portfolio-grammar-meta");
    // Restrict to the top-level metadata strip cells (the dl > div nodes)
    // so a nested ReplayBadge (which also exposes data-grammar-field) does
    // not double-count.
    const fields = Array.from(
      meta.querySelectorAll(":scope > dl > [data-grammar-field]"),
    ).map((el) => el.getAttribute("data-grammar-field"));
    expect(fields).toEqual(["scope", "confidence", "freshness", "status"]);
    expect(screen.getByTestId("portfolio-replay-badge")).toBeInTheDocument();
  });
});
