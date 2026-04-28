"use client";

import type { AgentTimeContext } from "@/lib/intelligence/types";

// Phase 18A.4 — surface the typed time framing from the retrieval bundle.
// The chip is intentionally calm: a single label and one of four
// coverage states. We do not render a chip for live-mode answers — that
// is the default and a chip there would be noise.

interface TimeContextChipProps {
  context: AgentTimeContext | null | undefined;
}

const COVERAGE_LABEL: Record<AgentTimeContext["coverage"], string> = {
  live: "Live",
  windowed: "Windowed",
  delta: "Delta",
  as_of: "As of",
  no_match: "No match",
};

export function TimeContextChip({ context }: TimeContextChipProps) {
  if (!context || context.coverage === "live") {
    return null;
  }
  const variant = context.coverage;
  const eyebrow = COVERAGE_LABEL[variant];
  const detail =
    variant === "no_match"
      ? `Window ${context.label} returned no signals`
      : context.answer_mode_label;
  return (
    <div
      className="ws-time-chip"
      data-variant={variant}
      data-testid="time-context-chip"
    >
      <span className="ws-time-chip__eyebrow">{eyebrow}</span>
      <span className="ws-time-chip__label">{detail}</span>
      {variant !== "no_match" && context.matched_event_count > 0 ? (
        <span className="ws-time-chip__count">
          {context.matched_event_count} signal
          {context.matched_event_count === 1 ? "" : "s"}
        </span>
      ) : null}
    </div>
  );
}
