"use client";

// Phase 16.6 hotfix — honest day-range snapshot.
//
// We can't fabricate intraday OHLC for tickers that aren't in an active
// portfolio (the candles endpoint is portfolio-scoped). We *can* honestly
// visualise the numbers a SignalEvent already carries: today's low / high,
// the previous close, and the last trade. This component renders that as
// a single horizontal range bar with markers — no fake series, no
// cosmetic candles, no hidden interpolation.
//
// It's intentionally small: this is a snapshot, not a chart. The full
// chart (TheSphereChart) still mounts when the symbol is held in the
// active portfolio.

interface MarketSnapshotProps {
  symbol: string;
  last: number | null;
  previousClose: number | null;
  dayLow: number | null;
  dayHigh: number | null;
  changePct: number | null;
}

export function MarketSnapshot({
  symbol,
  last,
  previousClose,
  dayLow,
  dayHigh,
  changePct,
}: MarketSnapshotProps) {
  const range = resolveRange(dayLow, dayHigh, last, previousClose);
  if (!range) return null;

  const lastPos = positionWithin(last, range);
  const prevPos = positionWithin(previousClose, range);
  const direction =
    changePct === null ? "flat" : changePct > 0 ? "up" : changePct < 0 ? "down" : "flat";

  return (
    <div
      className={`ws-market-snapshot ws-market-snapshot--${direction}`}
      data-testid="event-panel-snapshot"
      data-symbol={symbol}
    >
      <div className="ws-market-snapshot__head">
        <span className="ws-market-snapshot__symbol">{symbol}</span>
        <span className="ws-market-snapshot__last">
          {last !== null ? formatPrice(last) : "—"}
        </span>
        {changePct !== null ? (
          <span
            className={`ws-market-snapshot__pct ws-market-snapshot__pct--${direction}`}
          >
            {changePct >= 0 ? "+" : ""}
            {changePct.toFixed(2)}%
          </span>
        ) : null}
      </div>
      <div
        className="ws-market-snapshot__range"
        role="img"
        aria-label={buildAria(range, last, previousClose, changePct)}
      >
        <span className="ws-market-snapshot__rail" aria-hidden="true" />
        {prevPos !== null ? (
          <span
            className="ws-market-snapshot__marker ws-market-snapshot__marker--prev"
            style={{ left: `${prevPos * 100}%` }}
            aria-hidden="true"
            data-testid="snapshot-marker-prev"
          />
        ) : null}
        {lastPos !== null ? (
          <span
            className={`ws-market-snapshot__marker ws-market-snapshot__marker--last ws-market-snapshot__marker--${direction}`}
            style={{ left: `${lastPos * 100}%` }}
            aria-hidden="true"
            data-testid="snapshot-marker-last"
          />
        ) : null}
      </div>
      <div className="ws-market-snapshot__legend">
        <span>
          Low <strong>{formatPrice(range.low)}</strong>
        </span>
        {previousClose !== null ? (
          <span>
            Prev <strong>{formatPrice(previousClose)}</strong>
          </span>
        ) : null}
        <span>
          High <strong>{formatPrice(range.high)}</strong>
        </span>
      </div>
    </div>
  );
}

interface Range {
  low: number;
  high: number;
}

function resolveRange(
  dayLow: number | null,
  dayHigh: number | null,
  last: number | null,
  prev: number | null,
): Range | null {
  // Prefer the explicit day_low/day_high. If the feed is sparse, expand
  // the range to include last/prev so we can still show *something* honest.
  const candidates = [dayLow, dayHigh, last, prev].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (candidates.length < 2) return null;
  const low = Math.min(...candidates);
  const high = Math.max(...candidates);
  if (high <= low) return null;
  return { low, high };
}

function positionWithin(value: number | null, range: Range): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return null;
  const clamped = Math.min(Math.max(value, range.low), range.high);
  return (clamped - range.low) / (range.high - range.low);
}

function formatPrice(value: number): string {
  if (Math.abs(value) < 10) return value.toFixed(4);
  return value.toFixed(2);
}

function buildAria(
  range: Range,
  last: number | null,
  prev: number | null,
  pct: number | null,
): string {
  const parts: string[] = [
    `Range ${formatPrice(range.low)} to ${formatPrice(range.high)}`,
  ];
  if (last !== null) parts.push(`last ${formatPrice(last)}`);
  if (prev !== null) parts.push(`previous close ${formatPrice(prev)}`);
  if (pct !== null) {
    const sign = pct >= 0 ? "+" : "";
    parts.push(`change ${sign}${pct.toFixed(2)} percent`);
  }
  return parts.join(", ");
}
