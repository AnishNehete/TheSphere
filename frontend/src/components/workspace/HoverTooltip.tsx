"use client";

import { useAppStore } from "@/store/useAppStore";

// Renders the globe hover summary. The raycaster keeps writing the payload
// into useAppStore.hoverTooltip on every pointer move; this component is just
// the view. It sits above the chrome + overlay so it always reads clearly,
// and uses pointer-events: none so it never blocks hover/click on the globe
// or the overlay panel underneath.
export function HoverTooltip() {
  const tooltip = useAppStore((s) => s.hoverTooltip);
  if (!tooltip) return null;

  const score =
    typeof tooltip.score === "number" ? Math.round(tooltip.score * 100) : null;

  return (
    <div
      className="ws-hover-tooltip"
      style={{ left: tooltip.x, top: tooltip.y }}
      role="status"
      aria-live="polite"
    >
      <span className="ws-hover-tooltip__eyebrow">{tooltip.eyebrow}</span>
      <strong className="ws-hover-tooltip__title">{tooltip.title}</strong>
      {tooltip.summary ? (
        <p className="ws-hover-tooltip__summary">{tooltip.summary}</p>
      ) : null}
      {score !== null || tooltip.signalCount > 0 ? (
        <div className="ws-hover-tooltip__meta">
          {score !== null ? <span>{score} watch</span> : null}
          {tooltip.signalCount > 0 ? (
            <span>
              {tooltip.signalCount} signal{tooltip.signalCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
