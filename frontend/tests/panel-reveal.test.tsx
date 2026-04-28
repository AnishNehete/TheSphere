// Phase 16 — panel reveal choreography.
//
// Asserts:
//   - PanelReveal preserves child order
//   - Each child is wrapped exactly once
//   - When reduceMotion is on, the wrapper switches to data-reveal="off" and
//     drops the per-slot delay style so no animation runs
//   - When reduceMotion is off, slots get an increasing per-step delay
//     (capped at REVEAL_MAX_STEPS) so the choreography is deterministic

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PanelReveal } from "@/components/workspace/motion/PanelReveal";
import { useAccessibilityStore } from "@/store/useAccessibilityStore";

beforeEach(() => {
  useAccessibilityStore.getState().setReduceMotion(false);
});

afterEach(() => {
  useAccessibilityStore.getState().setReduceMotion(false);
});

describe("PanelReveal", () => {
  it("preserves the order of section children", () => {
    render(
      <PanelReveal>
        <section data-testid="reveal-a">A</section>
        <section data-testid="reveal-b">B</section>
        <section data-testid="reveal-c">C</section>
      </PanelReveal>,
    );
    const wrapper = screen.getByTestId("panel-reveal");
    const slots = wrapper.querySelectorAll(".ws-panel-reveal__slot");
    expect(slots.length).toBe(3);
    expect(slots[0].textContent).toBe("A");
    expect(slots[1].textContent).toBe("B");
    expect(slots[2].textContent).toBe("C");
  });

  it("assigns increasing reveal delays when motion is enabled", () => {
    render(
      <PanelReveal>
        <div>one</div>
        <div>two</div>
        <div>three</div>
      </PanelReveal>,
    );
    const wrapper = screen.getByTestId("panel-reveal");
    expect(wrapper).toHaveAttribute("data-reveal", "on");
    const slots = wrapper.querySelectorAll(".ws-panel-reveal__slot");
    const delays = Array.from(slots).map(
      (s) => (s as HTMLElement).style.getPropertyValue("--reveal-delay"),
    );
    expect(delays.every((d) => d.endsWith("ms"))).toBe(true);
    const numeric = delays.map((d) => Number.parseInt(d, 10));
    // strictly non-decreasing — staggered, never simultaneous
    expect(numeric[1]).toBeGreaterThan(numeric[0]);
    expect(numeric[2]).toBeGreaterThan(numeric[1]);
  });

  it("disables motion when the accessibility store opts out", () => {
    useAccessibilityStore.getState().setReduceMotion(true);
    render(
      <PanelReveal>
        <div>one</div>
        <div>two</div>
      </PanelReveal>,
    );
    const wrapper = screen.getByTestId("panel-reveal");
    expect(wrapper).toHaveAttribute("data-reveal", "off");
    const slots = wrapper.querySelectorAll(".ws-panel-reveal__slot");
    for (const slot of Array.from(slots)) {
      expect((slot as HTMLElement).style.getPropertyValue("--reveal-delay")).toBe("");
    }
  });
});
