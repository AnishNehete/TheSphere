"use client";

import { Children, isValidElement, type ReactNode } from "react";

import { useAccessibilityStore } from "@/store/useAccessibilityStore";

// Phase 16 — panel reveal choreography.
//
// Wraps the children of a panel scroll body with a small, deterministic
// stagger so each section enters with a short, premium-feeling delay.
// The choreography is implemented as a CSS-only animation gated by
// `data-reveal="ready"` on the wrapper. We only assign the index style;
// the keyframes live in workspace.css.
//
// Reduced-motion path: if the global accessibility flag is on (or the OS
// preference reduces motion via the @media query in workspace.css) we
// drop the animation entirely. The dom shape stays identical so content
// order, focus order, and a11y are unchanged.

const REVEAL_STEP_MS = 32; // small, fast — the analyst is the audience
const REVEAL_MAX_STEPS = 12;
const REVEAL_BASE_DELAY_MS = 12;

interface PanelRevealProps {
  /** Optional override id — useful for tests so they can scope the wrapper. */
  testId?: string;
  className?: string;
  children: ReactNode;
}

export function PanelReveal({ testId, className, children }: PanelRevealProps) {
  const reduceMotion = useAccessibilityStore((s) => s.reduceMotion);
  const items = Children.toArray(children).filter(Boolean);

  return (
    <div
      className={`ws-panel-reveal${className ? ` ${className}` : ""}`}
      data-reveal={reduceMotion ? "off" : "on"}
      data-testid={testId ?? "panel-reveal"}
    >
      {items.map((child, index) => {
        const stepIndex = Math.min(index, REVEAL_MAX_STEPS - 1);
        const delayMs = reduceMotion
          ? 0
          : REVEAL_BASE_DELAY_MS + stepIndex * REVEAL_STEP_MS;
        const key = isValidElement(child) && child.key ? child.key : index;
        return (
          <div
            key={key}
            className="ws-panel-reveal__slot"
            data-reveal-index={stepIndex}
            style={
              reduceMotion
                ? undefined
                : ({ ["--reveal-delay" as string]: `${delayMs}ms` } as React.CSSProperties)
            }
          >
            {child}
          </div>
        );
      })}
    </div>
  );
}
