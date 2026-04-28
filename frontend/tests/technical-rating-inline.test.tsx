// Phase 16 — inline technical rating badge.
//
// Asserts the productized inline pill renders the canonical label, a
// percentage, and the rating data-attribute. The factor breakdown is
// deferred to a hover tooltip in inline mode so the chart header stays
// dense without losing the rationale.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TechnicalRatingBadge } from "@/components/charts/TechnicalRatingBadge";
import type { RatingResult } from "@/lib/charts/rating";

const RESULT: RatingResult = {
  rating: "buy",
  score: 0.4,
  confidence: 0.83,
  rationale: "3 bull · 1 bear · 2 flat across 6/6 indicators (score 0.40).",
  factors: [
    { id: "px-vs-sma20", label: "Price vs SMA20", vote: "bull", detail: "+1.2%" },
    { id: "rsi14", label: "RSI 14", vote: "neutral", detail: "RSI 53 — flat momentum" },
    { id: "macd", label: "MACD histogram", vote: "bull", detail: "+0.020" },
  ],
};

describe("TechnicalRatingBadge — inline (Phase 16)", () => {
  it("renders the rating label and confidence percentage in inline mode", () => {
    render(<TechnicalRatingBadge result={RESULT} inline />);
    const badge = screen.getByTestId("technical-rating-inline");
    expect(badge).toHaveAttribute("data-rating", "buy");
    expect(badge.textContent).toContain("Buy");
    expect(badge.textContent).toContain("83%");
  });

  it("does not render the factor list in inline mode", () => {
    render(<TechnicalRatingBadge result={RESULT} inline />);
    expect(screen.queryByTestId("technical-rating-factors")).not.toBeInTheDocument();
    // The full rich-layout testid is also distinct from the inline one
    expect(screen.queryByTestId("technical-rating")).not.toBeInTheDocument();
  });

  it("preserves the rich layout when inline is false", () => {
    render(<TechnicalRatingBadge result={RESULT} />);
    expect(screen.getByTestId("technical-rating")).toBeInTheDocument();
    expect(screen.getByTestId("technical-rating-factors")).toBeInTheDocument();
  });
});
