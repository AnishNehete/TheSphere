import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AlertsBell } from "@/components/workspace/AlertsBell";
import type {
  AlertEventListResponseWire,
  AlertEventWire,
  AlertRuleListResponseWire,
} from "@/lib/intelligence/alerts";
import type { MarketPostureResponse } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

const SEEN_KEY = "sphere.alerts.lastSeenAt";

function postureFixture(symbol: string = "AAPL"): MarketPostureResponse {
  return {
    symbol,
    asset_class: "equities",
    posture: "buy",
    posture_label: "Buy",
    tilt: 0.3,
    effective_tilt: 0.2,
    confidence: 0.7,
    components: { technical: 0.4, semantic: 0.2, macro: null, uncertainty: 0.3 },
    drivers: [],
    caveats: [],
    freshness_seconds: 60,
    as_of: "2026-04-26T12:00:00Z",
    notes: [],
    provider: "alphavantage",
    provider_health: "live",
    semantic_pressure: null,
  };
}

function eventFixture(
  overrides: Partial<AlertEventWire> = {},
): AlertEventWire {
  return {
    id: overrides.id ?? "alev_1",
    rule_id: overrides.rule_id ?? "alrt_1",
    rule_name: overrides.rule_name ?? "AAPL band",
    fired_at: overrides.fired_at ?? "2026-04-26T12:00:00Z",
    triggering_posture: overrides.triggering_posture ?? postureFixture(),
    delta: overrides.delta ?? {
      kind: "posture_band_change",
      field: "posture",
      from_value: "neutral",
      to_value: "buy",
      magnitude: 1,
      summary: "AAPL posture moved from neutral to buy (1 band).",
    },
  };
}

interface FetchScript {
  events?: AlertEventListResponseWire;
  rules?: AlertRuleListResponseWire;
}

function installFetchMock(script: FetchScript) {
  const fetchMock = vi.fn(async (url: string) => {
    const target = String(url);
    if (target.includes("/api/intelligence/alerts/events")) {
      return new Response(
        JSON.stringify(script.events ?? { total: 0, items: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (target.includes("/api/intelligence/alerts/rules")) {
      return new Response(
        JSON.stringify(script.rules ?? { total: 0, items: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("", { status: 404 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("AlertsBell", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
    window.localStorage.removeItem(SEEN_KEY);
    useOverlayStore.getState().closeOverlay();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    cleanup();
    vi.useRealTimers();
  });

  it("renders no badge when there are zero events", async () => {
    installFetchMock({});
    render(<AlertsBell />);
    // Allow the initial poll to resolve.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId("alerts-bell-badge")).toBeNull();
  });

  it("shows the unread count from the backend events", async () => {
    installFetchMock({
      events: {
        total: 2,
        items: [
          eventFixture({ id: "alev_2", fired_at: "2026-04-26T12:01:00Z" }),
          eventFixture({ id: "alev_1", fired_at: "2026-04-26T12:00:00Z" }),
        ],
      },
    });
    render(<AlertsBell />);
    await act(async () => {
      await Promise.resolve();
    });
    const badge = await screen.findByTestId("alerts-bell-badge");
    expect(badge.textContent).toBe("2");
  });

  it("respects the lastSeenAt cursor from localStorage", async () => {
    window.localStorage.setItem(SEEN_KEY, "2026-04-26T12:00:30Z");
    installFetchMock({
      events: {
        total: 2,
        items: [
          eventFixture({ id: "alev_2", fired_at: "2026-04-26T12:01:00Z" }),
          eventFixture({ id: "alev_1", fired_at: "2026-04-26T12:00:00Z" }),
        ],
      },
    });
    render(<AlertsBell />);
    await act(async () => {
      await Promise.resolve();
    });
    const badge = await screen.findByTestId("alerts-bell-badge");
    // Only the newer event counts as unread.
    expect(badge.textContent).toBe("1");
  });

  it("opening the popover marks events as seen and clears the badge", async () => {
    installFetchMock({
      events: {
        total: 1,
        items: [
          eventFixture({ id: "alev_1", fired_at: "2026-04-26T12:00:00Z" }),
        ],
      },
    });
    render(<AlertsBell />);
    await act(async () => {
      await Promise.resolve();
    });
    expect((await screen.findByTestId("alerts-bell-badge")).textContent).toBe(
      "1",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("alerts-bell-trigger"));
      // setTimeout(0) for the seen-mark.
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(screen.queryByTestId("alerts-bell-badge")).toBeNull();
    expect(window.localStorage.getItem(SEEN_KEY)).toBe(
      "2026-04-26T12:00:00Z",
    );
  });

  it("clicking an event hands the symbol to the canonical store setter", async () => {
    installFetchMock({
      events: {
        total: 1,
        items: [
          eventFixture({
            id: "alev_1",
            fired_at: "2026-04-26T12:00:00Z",
            triggering_posture: postureFixture("MSFT"),
          }),
        ],
      },
    });
    render(<AlertsBell />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("alerts-bell-trigger"));
      await new Promise((r) => setTimeout(r, 5));
    });
    fireEvent.click(screen.getByText("AAPL band"));
    expect(useOverlayStore.getState().selectedMarketSymbol).toBe("MSFT");
  });

  it("polls the events endpoint at the configured cadence", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetchMock({});
    render(<AlertsBell />);
    // Initial mount fires one poll.
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
