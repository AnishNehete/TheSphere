// Wave 15B — selected-signal grammar tests.
//
// The grammar order is the contract that makes the panel feel like a real
// operator brief across domains. We assert the canonical section order and
// the conditional sections that should only render when the underlying
// signal carries the right data.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { EventPanel } from "@/components/workspace/EventPanel";
import type { SignalEvent, SignalCategory } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

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
    entities: [
      {
        entity_id: "ent:1",
        entity_type: "country",
        name: "Germany",
        country_code: "DEU",
        score: 0.9,
      },
    ],
    score: null,
    properties: {},
    ...overrides,
  };
}

function selectEvent(event: SignalEvent) {
  useOverlayStore.getState().openEvent(event, "signal-strip");
}

describe("EventPanel signal grammar", () => {
  beforeEach(() => {
    useOverlayStore.getState().closeOverlay();
  });

  it("renders the canonical metadata strip in the documented order", () => {
    selectEvent(makeEvent());
    render(<EventPanel />);
    const meta = screen.getByTestId("signal-grammar-meta");
    const fields = Array.from(meta.querySelectorAll("[data-grammar-field]")).map(
      (el) => el.getAttribute("data-grammar-field"),
    );
    expect(fields.slice(0, 5)).toEqual([
      "domain",
      "severity",
      "confidence",
      "freshness",
      "status",
    ]);
  });

  it("renders place, summary, why-it-matters, and entities in canonical order", () => {
    selectEvent(makeEvent());
    render(<EventPanel />);
    const place = screen.getByTestId("signal-grammar-place");
    const summary = screen.getByTestId("signal-grammar-summary");
    const why = screen.getByTestId("signal-grammar-why");
    const entities = screen.getByTestId("signal-grammar-entities");
    const sources = screen.getByTestId("signal-grammar-sources");

    const order = [place, summary, why, entities, sources];
    for (let i = 1; i < order.length; i++) {
      // eslint-disable-next-line no-bitwise
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("omits the technical posture section when the signal has no quantitative fields", () => {
    selectEvent(makeEvent());
    render(<EventPanel />);
    expect(screen.queryByTestId("signal-grammar-technical")).not.toBeInTheDocument();
  });

  it("renders technical posture rows for an equity signal with price + RSI fields", () => {
    selectEvent(
      makeEvent({
        type: "stocks" as SignalCategory,
        properties: {
          symbol: "AAPL",
          price: 175.5,
          previous_close: 174.0,
          change_pct: 0.86,
          day_high: 176.2,
          day_low: 173.8,
          volume: 52_000_000,
          rsi14: 58.4,
          sma200: 165.0,
        },
      }),
    );
    render(<EventPanel />);
    const tech = screen.getByTestId("signal-grammar-technical");
    expect(tech).toBeInTheDocument();
    expect(tech.textContent).toContain("Last");
    expect(tech.textContent).toContain("RSI 14");
    expect(tech.textContent).toContain("vs SMA200");
  });

  it("renders a market-relevance section for a directly-priced FX signal", () => {
    selectEvent(
      makeEvent({
        type: "currency" as SignalCategory,
        properties: { pair: "EURUSD", change_pct: -0.42 },
      }),
    );
    render(<EventPanel />);
    expect(screen.getByTestId("signal-grammar-market")).toBeInTheDocument();
  });
});
