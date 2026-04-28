import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GlobeSelectionBridge } from "@/components/workspace/GlobeSelectionBridge";
import { useAppStore } from "@/store/useAppStore";
import { useOverlayStore } from "@/store/useOverlayStore";
import { useWorkspaceModeStore } from "@/store/useWorkspaceModeStore";

function resetStores() {
  useOverlayStore.getState().closeOverlay();
  useOverlayStore.getState().clearCompareTargets();
  useWorkspaceModeStore.setState({ mode: "investigate", explicitlySet: false });
  useAppStore.getState().clearFocus?.();
  useAppStore.setState({ selectedCountry: null } as Partial<
    ReturnType<typeof useAppStore.getState>
  >);
}

describe("GlobeSelectionBridge — Compare auto-add (Phase 17A.3)", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("auto-adds the picked country to compareTargets when workspace mode is 'compare'", () => {
    useWorkspaceModeStore.setState({ mode: "compare", explicitlySet: true });
    useOverlayStore.getState().openCompare();

    const utils = render(<GlobeSelectionBridge />);
    act(() => {
      useAppStore.setState({ selectedCountry: "JPN" } as Partial<
        ReturnType<typeof useAppStore.getState>
      >);
    });
    utils.rerender(<GlobeSelectionBridge />);

    const overlay = useOverlayStore.getState();
    expect(overlay.compareTargets.map((t) => t.id)).toContain("country:JPN");
    expect(overlay.mode).toBe("compare");
  });

  it("auto-adds two countries in sequence and stays in compare mode", () => {
    useWorkspaceModeStore.setState({ mode: "compare", explicitlySet: true });
    useOverlayStore.getState().openCompare();

    const utils = render(<GlobeSelectionBridge />);
    act(() => {
      useAppStore.setState({ selectedCountry: "JPN" } as Partial<
        ReturnType<typeof useAppStore.getState>
      >);
    });
    utils.rerender(<GlobeSelectionBridge />);
    act(() => {
      useAppStore.setState({ selectedCountry: "KOR" } as Partial<
        ReturnType<typeof useAppStore.getState>
      >);
    });
    utils.rerender(<GlobeSelectionBridge />);

    const overlay = useOverlayStore.getState();
    expect(overlay.compareTargets.map((t) => t.id)).toEqual([
      "country:JPN",
      "country:KOR",
    ]);
    expect(overlay.mode).toBe("compare");
  });

  it("falls back to opening a country brief when not in Compare mode", () => {
    useWorkspaceModeStore.setState({ mode: "investigate", explicitlySet: true });

    const utils = render(<GlobeSelectionBridge />);
    act(() => {
      useAppStore.setState({ selectedCountry: "USA" } as Partial<
        ReturnType<typeof useAppStore.getState>
      >);
    });
    utils.rerender(<GlobeSelectionBridge />);

    const overlay = useOverlayStore.getState();
    expect(overlay.mode).toBe("country");
    expect(overlay.selectedCountryCode).toBe("USA");
    expect(overlay.compareTargets).toHaveLength(0);
  });
});
