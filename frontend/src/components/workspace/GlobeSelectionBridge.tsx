"use client";

import { useEffect } from "react";

import { centroidForIso3 } from "@/lib/three/geo";
import { useAppStore } from "@/store/useAppStore";
import { useOverlayStore } from "@/store/useOverlayStore";
import { useWorkspaceModeStore } from "@/store/useWorkspaceModeStore";

// Existing globe interaction code lives in useAppStore.selectedCountry. Instead
// of rewriting the raycaster, we subscribe to that canonical state and open the
// overlay whenever a country is pinned. The overlay close path also clears the
// globe selection so the two stay in sync.
export function GlobeSelectionBridge() {
  const selectedCountry = useAppStore((s) => s.selectedCountry);
  const openCountry = useOverlayStore((s) => s.openCountry);
  const pushCompareTarget = useOverlayStore((s) => s.pushCompareTarget);
  const selectedCountryCode = useOverlayStore((s) => s.selectedCountryCode);
  const isOpen = useOverlayStore((s) => s.isOpen);
  const mode = useOverlayStore((s) => s.mode);
  const focusIntent = useOverlayStore((s) => s.focusIntent);
  const workspaceMode = useWorkspaceModeStore((s) => s.mode);

  // Globe -> overlay: when the raycaster pins a country, open the brief.
  // Phase 17A.3 — when Compare workspace mode is active, route the click into
  // the compare set instead of swapping the panel back to a country brief.
  // This is the "auto-add" flow: two consecutive country picks build a
  // compare set without a manual "Add to compare" pivot.
  useEffect(() => {
    if (!selectedCountry) return;
    const code = selectedCountry.toUpperCase();
    if (workspaceMode === "compare") {
      const centroid = centroidForIso3(code);
      pushCompareTarget({
        kind: "country",
        id: `country:${code}`,
        label: centroid?.name ?? code,
        country_code: code,
      });
      return;
    }
    if (mode === "country" && selectedCountryCode === code) return;
    openCountry(code, undefined, "globe-click");
  }, [
    selectedCountry,
    selectedCountryCode,
    mode,
    workspaceMode,
    openCountry,
    pushCompareTarget,
  ]);

  // Overlay -> globe: when the overlay opens a country via search / deep-link,
  // nudge the globe to focus the same country so the two surfaces agree.
  // Skip when the intent already came from the globe to avoid a loop.
  useEffect(() => {
    if (mode !== "country") return;
    if (!selectedCountryCode) return;
    if (focusIntent === "globe-click") return;
    const app = useAppStore.getState();
    if ((app.selectedCountry ?? "").toUpperCase() === selectedCountryCode) return;
    app.focusCountry(selectedCountryCode);
  }, [mode, selectedCountryCode, focusIntent]);

  // Overlay close -> globe reset.
  useEffect(() => {
    if (isOpen) return;
    const app = useAppStore.getState();
    if (app.selectedCountry) {
      app.clearFocus();
    }
  }, [isOpen]);

  return null;
}
