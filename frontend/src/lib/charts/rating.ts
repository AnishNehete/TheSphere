// Technical rating engine.
//
// Maps a small bundle of indicator readings to a five-band rating
// (Strong Sell / Sell / Neutral / Buy / Strong Buy). Deliberately simple
// and bounded — no AI hand-waving, no opaque weights, every contributing
// signal is exposed as a factor with a bull/bear/neutral vote so the UI
// can show the rationale honestly.
//
// The rating is *not* a recommendation. It summarises what the technicals
// look like right now, with explicit confidence based on how many of the
// underlying indicators were actually computable.

export type TechnicalRating =
  | "strong_sell"
  | "sell"
  | "neutral"
  | "buy"
  | "strong_buy";

export const TECHNICAL_RATING_LABEL: Record<TechnicalRating, string> = {
  strong_sell: "Strong Sell",
  sell: "Sell",
  neutral: "Neutral",
  buy: "Buy",
  strong_buy: "Strong Buy",
};

export interface RatingInput {
  close: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  ema21?: number | null;
  rsi14: number | null;
  macd?: {
    macd: number | null;
    signal: number | null;
    histogram: number | null;
  } | null;
}

export type FactorVote = "bull" | "bear" | "neutral";

export interface RatingFactor {
  id: string;
  label: string;
  vote: FactorVote;
  detail: string;
}

export interface RatingResult {
  rating: TechnicalRating;
  score: number; // signed average of votes, in [-1, 1]
  confidence: number; // share of indicators that contributed, in [0, 1]
  factors: RatingFactor[];
  rationale: string;
}

const TOTAL_FACTOR_SLOTS = 6;

function isNum(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function priceVsMa(
  close: number | null,
  ma: number | null,
  label: string,
  id: string,
): RatingFactor | null {
  if (!isNum(close) || !isNum(ma)) return null;
  const pct = (close - ma) / ma;
  const vote: FactorVote =
    pct > 0.005 ? "bull" : pct < -0.005 ? "bear" : "neutral";
  return {
    id,
    label,
    vote,
    detail: `${pct >= 0 ? "+" : ""}${(pct * 100).toFixed(1)}% vs ${label.toLowerCase()}`,
  };
}

function trendCross(
  fast: number | null,
  slow: number | null,
): RatingFactor | null {
  if (!isNum(fast) || !isNum(slow)) return null;
  const diff = (fast - slow) / slow;
  const vote: FactorVote =
    diff > 0.002 ? "bull" : diff < -0.002 ? "bear" : "neutral";
  return {
    id: "sma20-vs-sma50",
    label: "SMA20 vs SMA50",
    vote,
    detail:
      diff > 0
        ? `SMA20 ${(diff * 100).toFixed(1)}% above SMA50`
        : `SMA20 ${(Math.abs(diff) * 100).toFixed(1)}% below SMA50`,
  };
}

function rsiFactor(value: number | null): RatingFactor | null {
  if (!isNum(value)) return null;
  let vote: FactorVote;
  let detail: string;
  if (value >= 70) {
    vote = "bear";
    detail = `RSI ${value.toFixed(0)} — overbought, mean-reversion risk`;
  } else if (value <= 30) {
    vote = "bull";
    detail = `RSI ${value.toFixed(0)} — oversold, bounce risk`;
  } else if (value >= 55) {
    vote = "bull";
    detail = `RSI ${value.toFixed(0)} — momentum above 50`;
  } else if (value <= 45) {
    vote = "bear";
    detail = `RSI ${value.toFixed(0)} — momentum below 50`;
  } else {
    vote = "neutral";
    detail = `RSI ${value.toFixed(0)} — flat momentum`;
  }
  return { id: "rsi14", label: "RSI 14", vote, detail };
}

function macdFactor(
  histogram: number | null | undefined,
): RatingFactor | null {
  if (!isNum(histogram)) return null;
  const vote: FactorVote =
    histogram > 0 ? "bull" : histogram < 0 ? "bear" : "neutral";
  return {
    id: "macd",
    label: "MACD histogram",
    vote,
    detail: `${histogram >= 0 ? "+" : ""}${histogram.toFixed(3)}`,
  };
}

function voteToScore(vote: FactorVote): number {
  return vote === "bull" ? 1 : vote === "bear" ? -1 : 0;
}

function bandFor(score: number): TechnicalRating {
  if (score >= 0.6) return "strong_buy";
  if (score >= 0.2) return "buy";
  if (score > -0.2) return "neutral";
  if (score > -0.6) return "sell";
  return "strong_sell";
}

export function deriveTechnicalRating(input: RatingInput): RatingResult {
  const factors: RatingFactor[] = [];
  const push = (factor: RatingFactor | null) => {
    if (factor) factors.push(factor);
  };

  push(priceVsMa(input.close, input.sma20, "Price vs SMA20", "px-vs-sma20"));
  push(priceVsMa(input.close, input.sma50, "Price vs SMA50", "px-vs-sma50"));
  push(priceVsMa(input.close, input.sma200, "Price vs SMA200", "px-vs-sma200"));
  push(trendCross(input.sma20, input.sma50));
  push(rsiFactor(input.rsi14));
  push(macdFactor(input.macd?.histogram ?? null));

  if (factors.length === 0) {
    return {
      rating: "neutral",
      score: 0,
      confidence: 0,
      factors: [],
      rationale: "Insufficient data to compute a technical rating.",
    };
  }

  const sum = factors.reduce((acc, f) => acc + voteToScore(f.vote), 0);
  const score = sum / factors.length;
  const rating = bandFor(score);
  const confidence = factors.length / TOTAL_FACTOR_SLOTS;
  const bull = factors.filter((f) => f.vote === "bull").length;
  const bear = factors.filter((f) => f.vote === "bear").length;
  const neutral = factors.length - bull - bear;
  const rationale = `${bull} bull · ${bear} bear · ${neutral} flat across ${factors.length}/${TOTAL_FACTOR_SLOTS} indicators (score ${score.toFixed(2)}).`;

  return { rating, score, confidence, factors, rationale };
}
