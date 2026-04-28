// Wave 15B — pure indicator math tests.
//
// The chart UI is hard to assert against in jsdom (no canvas). The math is
// the contract that makes the chart credible, so it gets the bulk of the
// indicator coverage.

import { describe, expect, it } from "vitest";

import { ema, lastDefined, macd, rsi, sma } from "@/lib/charts/indicators";

describe("sma", () => {
  it("returns all nulls when the input is shorter than the window", () => {
    expect(sma([1, 2, 3], 5)).toEqual([null, null, null]);
  });

  it("emits leading nulls then the rolling mean", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(2);
    expect(out[3]).toBeCloseTo(3);
    expect(out[4]).toBeCloseTo(4);
  });

  it("emits null for any window that contains a missing value", () => {
    const out = sma([1, 2, null, 4, 5], 3);
    expect(out[2]).toBeNull();
    expect(out[3]).toBeNull();
    expect(out[4]).toBeNull();
  });

  it("rejects non-positive windows", () => {
    expect(() => sma([1, 2, 3], 0)).toThrow();
  });
});

describe("ema", () => {
  it("returns all nulls when there are not enough valid samples to seed", () => {
    expect(ema([1, 2], 5)).toEqual([null, null]);
  });

  it("seeds with the SMA of the first window then decays exponentially", () => {
    const out = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
    // First two positions before seed
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(2); // SMA seed
    // Subsequent values strictly increase as the input is monotonic
    for (let i = 3; i < out.length; i++) {
      expect(out[i]).toBeGreaterThan(out[i - 1] as number);
    }
    // Final value must lie inside the input range
    expect(out[out.length - 1]).toBeGreaterThan(2);
    expect(out[out.length - 1]).toBeLessThan(10);
  });

  it("preserves position of nulls in the output without poisoning later EMA values", () => {
    const out = ema([1, 2, 3, null, 5, 6], 2);
    // After seed at index 1 (value 1.5), the null at idx 3 yields null,
    // but the next EMA at idx 4 must still compute against the prior EMA.
    expect(out[1]).toBeCloseTo(1.5);
    expect(out[3]).toBeNull();
    expect(out[4]).not.toBeNull();
  });
});

describe("rsi", () => {
  it("returns all nulls when the series is too short for the period", () => {
    const out = rsi([1, 2, 3], 14);
    expect(out.every((v) => v === null)).toBe(true);
  });

  it("computes 100 for a strictly-increasing series after the seed", () => {
    const series = Array.from({ length: 20 }, (_, i) => i + 1);
    const out = rsi(series, 14);
    const last = out[out.length - 1];
    expect(last).toBeCloseTo(100, 1);
  });

  it("computes 0 for a strictly-decreasing series after the seed", () => {
    const series = Array.from({ length: 20 }, (_, i) => 20 - i);
    const out = rsi(series, 14);
    const last = out[out.length - 1];
    expect(last).toBeCloseTo(0, 1);
  });

  it("emits values bounded in [0, 100] for a noisy series", () => {
    const series: number[] = [];
    let v = 100;
    for (let i = 0; i < 60; i++) {
      v += Math.sin(i * 0.4) * 1.2;
      series.push(v);
    }
    const out = rsi(series, 14);
    for (const value of out) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});

describe("macd", () => {
  it("returns the three aligned arrays equal to the input length", () => {
    const series = Array.from({ length: 50 }, (_, i) => i + 1);
    const result = macd(series);
    expect(result.macd).toHaveLength(50);
    expect(result.signal).toHaveLength(50);
    expect(result.histogram).toHaveLength(50);
  });

  it("emits null for indexes where either ema is undefined", () => {
    const series = Array.from({ length: 30 }, (_, i) => i + 1);
    const { macd: macdLine } = macd(series);
    expect(macdLine[0]).toBeNull();
    expect(macdLine[macdLine.length - 1]).not.toBeNull();
  });

  it("rejects illegal periods", () => {
    expect(() => macd([1, 2, 3], 26, 12)).toThrow();
    expect(() => macd([1, 2, 3], 0)).toThrow();
  });

  it("histogram sign agrees with macd-vs-signal", () => {
    const series = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 5);
    const { macd: m, signal: s, histogram } = macd(series);
    for (let i = 0; i < series.length; i++) {
      const mv = m[i];
      const sv = s[i];
      const hv = histogram[i];
      if (mv === null || sv === null || hv === null) continue;
      expect(Math.sign(hv)).toBe(Math.sign(mv - sv) || 0);
    }
  });
});

describe("lastDefined", () => {
  it("returns null on an empty or fully-null series", () => {
    expect(lastDefined([])).toBeNull();
    expect(lastDefined([null, null])).toBeNull();
  });

  it("returns the most recent finite value", () => {
    expect(lastDefined([1, 2, null, 4, null])).toBe(4);
    expect(lastDefined([null, 7])).toBe(7);
  });
});
