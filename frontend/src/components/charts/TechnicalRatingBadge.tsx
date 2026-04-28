"use client";

import {
  TECHNICAL_RATING_LABEL,
  type RatingResult,
  type TechnicalRating,
} from "@/lib/charts/rating";

interface TechnicalRatingBadgeProps {
  result: RatingResult;
  compact?: boolean;
  /**
   * Phase 16 — `inline` is a single-pill render used inside chart headers
   * and panel metadata strips. It carries the rating + confidence only and
   * defers the factor breakdown to a hover tooltip.
   */
  inline?: boolean;
}

const RATING_TONE: Record<TechnicalRating, string> = {
  strong_sell: "ws-rating--strong-sell",
  sell: "ws-rating--sell",
  neutral: "ws-rating--neutral",
  buy: "ws-rating--buy",
  strong_buy: "ws-rating--strong-buy",
};

export function TechnicalRatingBadge({
  result,
  compact = false,
  inline = false,
}: TechnicalRatingBadgeProps) {
  const tone = RATING_TONE[result.rating];
  const confidencePct = Math.round(result.confidence * 100);

  if (inline) {
    return (
      <span
        className={`ws-rating ws-rating--inline ${tone}`}
        data-testid="technical-rating-inline"
        data-rating={result.rating}
        title={`${result.rationale}${result.factors.length > 0 ? "\n" + result.factors.map((f) => `${f.label}: ${f.detail}`).join("\n") : ""}`}
      >
        <span className="ws-rating__label">
          {TECHNICAL_RATING_LABEL[result.rating]}
        </span>
        <span className="ws-rating__confidence">{confidencePct}%</span>
      </span>
    );
  }

  return (
    <div
      className={`ws-rating ${tone}${compact ? " ws-rating--compact" : ""}`}
      data-testid="technical-rating"
      data-rating={result.rating}
    >
      <div className="ws-rating__head">
        <span className="ws-rating__label">{TECHNICAL_RATING_LABEL[result.rating]}</span>
        <span className="ws-rating__confidence">{confidencePct}% coverage</span>
      </div>
      {!compact ? (
        <p className="ws-rating__rationale">{result.rationale}</p>
      ) : null}
      {!compact && result.factors.length > 0 ? (
        <ul className="ws-rating__factors" data-testid="technical-rating-factors">
          {result.factors.map((factor) => (
            <li
              key={factor.id}
              className={`ws-rating__factor ws-rating__factor--${factor.vote}`}
            >
              <span className="ws-rating__factor-label">{factor.label}</span>
              <span className="ws-rating__factor-detail">{factor.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
