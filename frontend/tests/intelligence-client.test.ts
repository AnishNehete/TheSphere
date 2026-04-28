import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getCountrySummary,
  getHealth,
  getLatestSignals,
  getMarketPosture,
  searchIntelligence,
} from "@/lib/intelligence/client";
import { IntelligenceApiError } from "@/lib/intelligence/types";
import type { MarketPostureResponse } from "@/lib/intelligence/types";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status = 500): Response {
  return new Response("fail", { status });
}

describe("intelligence client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getHealth hits /api/intelligence/health and returns typed payload", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        status: "ok",
        totalCycles: 2,
        totalEventsIngested: 42,
        lastCycle: null,
        adapters: [],
      }),
    );
    const result = await getHealth({
      baseUrl: "http://localhost:8000",
      fetcher: fetchMock as unknown as typeof fetch,
    });
    expect(result.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/api/intelligence/health",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("getLatestSignals encodes category and default limit", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ total: 0, items: [] }));
    await getLatestSignals(
      { category: "news" },
      { baseUrl: "http://api.example", fetcher: fetchMock as unknown as typeof fetch },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.example/api/intelligence/events/latest?category=news&limit=25",
      expect.any(Object),
    );
  });

  it("getCountrySummary URL-encodes the code", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        summary: {
          country_code: "SGP",
          country_name: "Singapore",
          updated_at: "",
          watch_score: 0,
          watch_delta: 0,
          watch_label: "info",
          counts_by_category: {},
          top_signals: [],
          headline_signal_id: null,
          confidence: 0,
          sources: [],
          summary: null,
        },
        events: [],
      }),
    );
    await getCountrySummary("sgp", {
      baseUrl: "http://api.example",
      fetcher: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.example/api/intelligence/country/sgp",
      expect.any(Object),
    );
  });

  it("searchIntelligence forwards q + optional filters", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        query: "jp port",
        resolved_country_code: "JPN",
        total: 0,
        hits: [],
      }),
    );
    await searchIntelligence(
      { q: "jp port", category: "news", country: "JPN", limit: 10 },
      { baseUrl: "http://api.example", fetcher: fetchMock as unknown as typeof fetch },
    );
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("q=jp+port");
    expect(calledUrl).toContain("category=news");
    expect(calledUrl).toContain("country=JPN");
    expect(calledUrl).toContain("limit=10");
  });

  it("throws IntelligenceApiError on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(503));
    await expect(
      getHealth({ baseUrl: "http://api.example", fetcher: fetchMock as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(IntelligenceApiError);
  });

  // Phase 17A.1 — deterministic posture client.
  it("getMarketPosture URL-encodes symbol, forwards asset_class, returns typed envelope", async () => {
    const wire: MarketPostureResponse = {
      symbol: "AAPL",
      asset_class: "equities",
      posture: "buy",
      posture_label: "Buy",
      tilt: 0.42,
      effective_tilt: 0.31,
      confidence: 0.74,
      components: {
        technical: 0.6,
        semantic: 0.2,
        macro: null,
        uncertainty: 0.26,
      },
      drivers: [
        {
          component: "technical",
          label: "Trend strength",
          signed_contribution: 0.3,
          rationale: "20d EMA above 50d EMA with rising momentum.",
          evidence_ids: [],
        },
      ],
      caveats: [],
      freshness_seconds: 60,
      as_of: "2026-04-26T00:00:00Z",
      notes: [],
      provider: "alphavantage+cache",
      provider_health: "live",
      semantic_pressure: null,
    };
    fetchMock.mockResolvedValueOnce(okResponse(wire));

    const result = await getMarketPosture(
      "aapl/x",
      { asset_class: "equities" },
      {
        baseUrl: "http://api.example",
        fetcher: fetchMock as unknown as typeof fetch,
      },
    );

    expect(result.posture).toBe("buy");
    expect(result.tilt).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    // URL-encoded symbol so a slash in the path can't escape the segment.
    expect(calledUrl).toBe(
      "http://api.example/api/intelligence/market/aapl%2Fx/posture?asset_class=equities",
    );
  });

  it("getMarketPosture skips undefined params (no asset_class, no as_of)", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        symbol: "EURUSD",
        asset_class: "unknown",
        posture: "neutral",
        posture_label: "Neutral",
        tilt: 0,
        effective_tilt: 0,
        confidence: 0.1,
        components: {
          technical: null,
          semantic: null,
          macro: null,
          uncertainty: 0.9,
        },
        drivers: [],
        caveats: ["Insufficient data"],
        freshness_seconds: null,
        as_of: "2026-04-26T00:00:00Z",
        notes: ["pinned neutral due to low confidence"],
        provider: "unconfigured",
        provider_health: "unconfigured",
        semantic_pressure: null,
      } satisfies MarketPostureResponse),
    );
    await getMarketPosture(
      "EURUSD",
      {},
      {
        baseUrl: "http://api.example",
        fetcher: fetchMock as unknown as typeof fetch,
      },
    );
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    // No querystring at all when no params are supplied — empty
    // params must not leak `?asset_class=undefined`.
    expect(calledUrl).toBe(
      "http://api.example/api/intelligence/market/EURUSD/posture",
    );
  });

  it("wraps network errors into IntelligenceApiError", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket closed"));
    await expect(
      getLatestSignals(
        {},
        { baseUrl: "http://api.example", fetcher: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({
      name: "IntelligenceApiError",
      status: null,
    });
  });
});
