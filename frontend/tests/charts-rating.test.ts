// Wave 15B — technical rating engine tests.

import { describe, expect, it } from "vitest";

import { deriveTechnicalRating } from "@/lib/charts/rating";

describe("deriveTechnicalRating", () => {
  it("returns neutral with zero confidence when no indicators are available", () => {
    const result = deriveTechnicalRating({
      close: null,
      sma20: null,
      sma50: null,
      sma200: null,
      rsi14: null,
    });
    expect(result.rating).toBe("neutral");
    expect(result.confidence).toBe(0);
    expect(result.factors).toHaveLength(0);
  });

  it("returns strong_buy when all indicators are aligned bullish", () => {
    const result = deriveTechnicalRating({
      close: 110,
      sma20: 105,
      sma50: 100,
      sma200: 90,
      ema21: 106,
      rsi14: 62,
      macd: { macd: 1.5, signal: 1.0, histogram: 0.5 },
    });
    expect(result.rating).toBe("strong_buy");
    expect(result.score).toBeGreaterThan(0.6);
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("returns strong_sell when all indicators are aligned bearish", () => {
    const result = deriveTechnicalRating({
      close: 80,
      sma20: 85,
      sma50: 90,
      sma200: 100,
      ema21: 86,
      rsi14: 35,
      macd: { macd: -1.0, signal: -0.6, histogram: -0.4 },
    });
    expect(result.rating).toBe("strong_sell");
    expect(result.score).toBeLessThan(-0.6);
  });

  it("returns neutral when every contributing factor is flat", () => {
    const result = deriveTechnicalRating({
      close: 100,
      sma20: 100,    // |pct| within neutral band
      sma50: 100,
      sma200: null,
      rsi14: 50,     // 45-55 → flat momentum
    });
    expect(result.rating).toBe("neutral");
    expect(result.score).toBeCloseTo(0, 5);
  });

  it("lands in the sell band when one bullish factor is outweighed by two bearish factors", () => {
    const result = deriveTechnicalRating({
      close: 100,
      sma20: 95,   // bull (price above)
      sma50: 105,  // bear (price below)
      sma200: null,
      rsi14: 40,   // bear (45 floor)
    });
    // factors: bull=1, bear=2, neutral=0 → score = -1/3 ≈ -0.33 → sell
    expect(result.rating).toBe("sell");
    expect(result.score).toBeLessThan(0);
  });

  it("scales confidence to the share of indicators that contributed", () => {
    const result = deriveTechnicalRating({
      close: 100,
      sma20: 95,
      sma50: null,
      sma200: null,
      rsi14: null,
    });
    // Only price-vs-sma20 contributed; 1 of 6 slots = ~0.16 confidence
    expect(result.confidence).toBeCloseTo(1 / 6, 2);
  });

  it("flags RSI > 70 as bearish (overbought) even when price rides above MAs", () => {
    const result = deriveTechnicalRating({
      close: 100,
      sma20: 99,
      sma50: 95,
      sma200: 90,
      rsi14: 78,
      macd: { macd: 0, signal: 0, histogram: 0 },
    });
    const rsiFactor = result.factors.find((f) => f.id === "rsi14");
    expect(rsiFactor?.vote).toBe("bear");
  });

  it("emits a rationale with the bull/bear/flat counts", () => {
    const result = deriveTechnicalRating({
      close: 100,
      sma20: 99,
      sma50: 98,
      sma200: 95,
      rsi14: 60,
    });
    expect(result.rationale).toMatch(/bull/);
    expect(result.rationale).toMatch(/bear/);
    expect(result.rationale).toMatch(/score/);
  });
});
