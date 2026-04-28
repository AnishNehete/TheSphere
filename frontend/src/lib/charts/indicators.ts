// Pure technical-indicator helpers for the chart surface.
//
// All functions are stateless, allocation-free in the hot path, and produce
// arrays aligned 1:1 with the input series. Leading values that cannot be
// computed (insufficient lookback, missing data) are emitted as `null` so the
// caller can distinguish "no value yet" from a real zero. Charting code maps
// these to whitespace/null on the series so the line is honest about where
// it actually has signal.
//
// Why pure modules instead of methods on a chart wrapper: the indicator math
// is the most testable part of the analytical surface. Keeping it free of
// rendering concerns lets us unit-test it in isolation and reuse the same
// helpers in non-chart contexts (technical rating, server-side parity, etc.).

export type Series = ReadonlyArray<number | null | undefined>;

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Simple moving average over a fixed window.
 * Emits `null` for the first `window - 1` positions and any window that
 * contains at least one missing value. The implementation is the standard
 * O(n) running-sum sliding window.
 */
export function sma(values: Series, window: number): (number | null)[] {
  if (window <= 0) {
    throw new Error("sma window must be > 0");
  }
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < window) {
    return out;
  }
  let sum = 0;
  let validInWindow = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isFiniteNumber(v)) {
      sum += v;
      validInWindow += 1;
    }
    if (i >= window) {
      const drop = values[i - window];
      if (isFiniteNumber(drop)) {
        sum -= drop;
        validInWindow -= 1;
      }
    }
    if (i >= window - 1 && validInWindow === window) {
      out[i] = sum / window;
    }
  }
  return out;
}

/**
 * Exponential moving average. Seeded with the SMA of the first `window`
 * valid samples so the curve does not jump from the first observation. The
 * recursive form `ema_t = alpha * x_t + (1 - alpha) * ema_{t-1}` is used
 * after the seed, with alpha = 2 / (window + 1).
 *
 * If a value is missing inside the series we hold the previous EMA in place
 * and emit `null` for that index; this keeps the indicator honest about gaps
 * without contaminating future values with stale interpolated data.
 */
export function ema(values: Series, window: number): (number | null)[] {
  if (window <= 0) {
    throw new Error("ema window must be > 0");
  }
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length === 0) return out;
  const alpha = 2 / (window + 1);

  // Find seed index: position of the `window`-th valid value.
  let seen = 0;
  let seedIdx = -1;
  let seedSum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFiniteNumber(v)) continue;
    seen += 1;
    seedSum += v;
    if (seen === window) {
      seedIdx = i;
      break;
    }
  }
  if (seedIdx < 0) return out;

  let prev = seedSum / window;
  out[seedIdx] = prev;
  for (let i = seedIdx + 1; i < values.length; i++) {
    const v = values[i];
    if (!isFiniteNumber(v)) {
      out[i] = null;
      continue;
    }
    prev = alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's RSI. Default period is 14. Returns values in [0, 100] aligned
 * to the input series; any position that lacks a full `period + 1` lookback
 * window of valid samples is emitted as `null`.
 *
 * Uses Wilder's smoothing (alpha = 1 / period), which is the convention every
 * platform a serious analyst will compare against.
 */
export function rsi(values: Series, period = 14): (number | null)[] {
  if (period <= 0) {
    throw new Error("rsi period must be > 0");
  }
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
  let seeded = false;
  let validInSeed = 0;

  for (let i = 1; i < values.length; i++) {
    const curr = values[i];
    const prev = values[i - 1];
    if (!isFiniteNumber(curr) || !isFiniteNumber(prev)) {
      // Reset seed if a hole appears before we have one — keep it simple
      // and conservative rather than papering over missing data.
      if (!seeded) {
        avgGain = 0;
        avgLoss = 0;
        validInSeed = 0;
      }
      continue;
    }
    const change = curr - prev;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    if (!seeded) {
      avgGain += gain;
      avgLoss += loss;
      validInSeed += 1;
      if (validInSeed === period) {
        avgGain /= period;
        avgLoss /= period;
        seeded = true;
        out[i] = computeRsiValue(avgGain, avgLoss);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = computeRsiValue(avgGain, avgLoss);
    }
  }
  return out;
}

function computeRsiValue(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

/**
 * MACD = EMA(fast) - EMA(slow). The signal line is an EMA of the MACD
 * series itself; histogram = MACD - signal. Defaults are the conventional
 * 12 / 26 / 9. Aligned to the input series; positions where either the fast
 * or slow EMA is undefined emit `null` for the macd line and the histogram.
 */
export function macd(
  values: Series,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  if (fastPeriod <= 0 || slowPeriod <= 0 || signalPeriod <= 0) {
    throw new Error("macd periods must be > 0");
  }
  if (fastPeriod >= slowPeriod) {
    throw new Error("macd fastPeriod must be < slowPeriod");
  }
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const macdLine: (number | null)[] = values.map((_, i) => {
    const f = fast[i];
    const s = slow[i];
    return isFiniteNumber(f) && isFiniteNumber(s) ? f - s : null;
  });
  const signalLine = ema(macdLine, signalPeriod);
  const histogram: (number | null)[] = macdLine.map((m, i) => {
    const s = signalLine[i];
    return isFiniteNumber(m) && isFiniteNumber(s) ? m - s : null;
  });
  return { macd: macdLine, signal: signalLine, histogram };
}

/**
 * Convenience helper — returns the most recent non-null value in the series,
 * or `null` if the series is empty / fully null. Used by the rating engine
 * and the rating badge so callers do not all hand-roll the same scan.
 */
export function lastDefined(series: ReadonlyArray<number | null>): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (isFiniteNumber(v)) return v;
  }
  return null;
}
