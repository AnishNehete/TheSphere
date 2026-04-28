// Wave 15C — entity-to-symbol relevance map tests.
//
// The map is the bridge between EventPanel's grounded summary and the
// multi-asset bottom strip. We assert:
//   - country / commodity / chokepoint / sector / currency lookups all work
//   - empty result for unmapped entities (no fabrication)
//   - duplicates dedup with the highest confidence kept
//   - sources are recorded so the panel can cite the basis

import { describe, expect, it } from "vitest";

import {
  mapEntityToSymbols,
  summariseEntityRelevance,
} from "@/lib/intelligence/entitySymbolMap";

describe("mapEntityToSymbols", () => {
  it("returns mapped tickers for a known country", () => {
    const result = mapEntityToSymbols({ countryCode: "JPN" });
    const symbols = result.symbols.map((s) => s.symbol);
    expect(symbols).toContain("EWJ");
    expect(symbols).toContain("USDJPY");
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it("returns futures for crude oil", () => {
    const result = mapEntityToSymbols({ commodity: "crude_oil" });
    const symbols = result.symbols.map((s) => s.symbol);
    expect(symbols).toContain("CL");
    expect(symbols).toContain("BZ");
  });

  it("normalizes commodity strings (oil → crude oil aliases)", () => {
    const result = mapEntityToSymbols({ commodity: "oil" });
    const symbols = result.symbols.map((s) => s.symbol);
    expect(symbols).toContain("CL");
  });

  it("returns chokepoint exposures for the Strait of Hormuz", () => {
    const result = mapEntityToSymbols({ chokepoint: "Strait of Hormuz" });
    const symbols = result.symbols.map((s) => s.symbol);
    expect(symbols).toContain("CL");
    expect(symbols).toContain("BZ");
  });

  it("returns nothing for an unknown entity rather than fabricating", () => {
    const result = mapEntityToSymbols({ countryCode: "XYZ" });
    expect(result.symbols).toHaveLength(0);
    expect(result.confidence).toBe(0);
    expect(result.sources).toHaveLength(0);
  });

  it("deduplicates symbols that show up via multiple entity axes", () => {
    const result = mapEntityToSymbols({
      countryCode: "SAU",
      commodity: "crude_oil",
    });
    const symbols = result.symbols.map((s) => s.symbol);
    const clCount = symbols.filter((s) => s === "CL").length;
    expect(clCount).toBe(1);
    const cl = result.symbols.find((s) => s.symbol === "CL");
    // commodity link confidence (0.95) > country link confidence (0.75)
    expect(cl?.confidence).toBeGreaterThan(0.9);
  });

  it("returns sector links by normalized key", () => {
    const result = mapEntityToSymbols({ sector: "Semiconductors" });
    const symbols = result.symbols.map((s) => s.symbol);
    expect(symbols).toContain("SOXX");
  });

  it("composes multi-axis lookups with mixed sources", () => {
    const result = mapEntityToSymbols({
      countryCode: "DEU",
      sector: "autos",
      currency: "EUR",
    });
    expect(result.sources.length).toBeGreaterThanOrEqual(2);
  });
});

describe("summariseEntityRelevance", () => {
  it("returns a compact summary string for a known entity", () => {
    const summary = summariseEntityRelevance({ countryCode: "JPN" });
    expect(summary).toContain("EWJ");
    expect(summary).toContain("confidence");
  });

  it("returns null when nothing maps", () => {
    expect(summariseEntityRelevance({ countryCode: "XYZ" })).toBeNull();
  });
});
