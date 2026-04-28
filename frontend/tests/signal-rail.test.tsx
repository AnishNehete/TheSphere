import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { SignalStrip } from "@/components/workspace/SignalStrip";
import type { SignalEvent } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";
import { useSignalRailStore } from "@/store/useSignalRailStore";

function makeEvent(
  id: string,
  type: SignalEvent["type"],
  overrides: Partial<SignalEvent> = {},
): SignalEvent {
  return {
    id,
    dedupe_key: id,
    type,
    sub_type: null,
    title: `Signal ${id}`,
    summary: "summary",
    description: null,
    severity: "watch",
    severity_score: 0.5,
    confidence: 0.6,
    status: "active",
    place: {
      latitude: null,
      longitude: null,
      country_code: "USA",
      country_name: "United States",
      region: null,
      admin1: null,
      locality: null,
    },
    start_time: null,
    end_time: null,
    source_timestamp: "2026-04-24T12:00:00Z",
    ingested_at: "2026-04-24T12:00:00Z",
    sources: [],
    merged_from: [],
    tags: [],
    entities: [],
    score: null,
    properties: {},
    ...overrides,
  };
}

function resetStores() {
  useOverlayStore.getState().closeOverlay();
  useOverlayStore.getState().setLatestSignals([]);
  useSignalRailStore.setState({
    selectedDomain: "news",
    byDomain: {},
    errorByDomain: {},
  });
}

describe("SignalStrip multi-domain rail", () => {
  beforeEach(resetStores);

  it("renders all six domain tabs", () => {
    render(<SignalStrip />);
    for (const domain of ["news", "stocks", "weather", "flights", "health", "conflict"]) {
      expect(screen.getByTestId(`rail-tab-${domain}`)).toBeInTheDocument();
    }
  });

  it("falls back to overlay store latest signals on the news tab", () => {
    useOverlayStore
      .getState()
      .setLatestSignals([makeEvent("n1", "news", { title: "News one" })]);
    render(<SignalStrip />);
    expect(screen.getByText("News one")).toBeInTheDocument();
  });

  it("switches to a different domain bucket when a tab is clicked", () => {
    useSignalRailStore
      .getState()
      .setDomainSignals("weather", [
        makeEvent("w1", "weather", { title: "Storm forecast" }),
      ]);
    useSignalRailStore
      .getState()
      .setDomainSignals("news", [makeEvent("n1", "news", { title: "News one" })]);
    render(<SignalStrip />);

    expect(screen.getByText("News one")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("rail-tab-weather"));

    expect(useSignalRailStore.getState().selectedDomain).toBe("weather");
    expect(screen.getByText("Storm forecast")).toBeInTheDocument();
    expect(screen.queryByText("News one")).not.toBeInTheDocument();
  });

  it("renders a domain-specific empty state when the bucket is empty", () => {
    useSignalRailStore.getState().setSelectedDomain("flights");
    render(<SignalStrip />);
    expect(
      screen.getByText(/No active flights signals right now/i),
    ).toBeInTheDocument();
  });

  it("renders error copy when a domain feed reports an error", () => {
    useSignalRailStore.getState().setSelectedDomain("conflict");
    useSignalRailStore
      .getState()
      .setDomainError("conflict", "Conflict feed degraded.");
    render(<SignalStrip />);
    expect(screen.getByText("Conflict feed degraded.")).toBeInTheDocument();
  });

  it("ranks events by severity when populated", () => {
    useSignalRailStore.getState().setDomainSignals("news", [
      makeEvent("a", "news", { title: "Watch item", severity: "watch" }),
      makeEvent("b", "news", { title: "Critical item", severity: "critical" }),
      makeEvent("c", "news", { title: "Info item", severity: "info" }),
    ]);
    render(<SignalStrip />);
    const items = screen.getAllByTestId("rail-item");
    expect(items[0]).toHaveTextContent("Critical item");
    expect(items[1]).toHaveTextContent("Watch item");
    expect(items[2]).toHaveTextContent("Info item");
  });
});
