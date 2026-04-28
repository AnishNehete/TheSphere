"use client";

import { useEffect } from "react";

import { useAppStore } from "@/store/useAppStore";

// Phase 19C.3 — keyboard-driven camera presets for demo / screenshot
// captures and pole reachability. Active only when diagnostics are
// enabled so production analysts never trip them by accident.
//
//   Shift+1 → North Pole (Greenland)
//   Shift+2 → South Pole (proxy via Antarctica region if available; falls
//             back to a high-southern country)
//   Shift+3 → Asia-Pacific (Japan)
//   Shift+4 → Americas (USA)
//   Shift+5 → Europe / Africa (France)
//
// Each preset routes through focusCountry so the existing cinematic
// shot system handles the transition. Pole presets pick the highest
// latitude country in our centroid data so the camera ends up looking
// at the polar region without needing a new code path.
const PRESETS: Record<string, string> = {
  "1": "GRL", // North Pole proxy
  "2": "ATA", // South Pole — Antarctica if present
  "3": "JPN", // Asia-Pacific
  "4": "USA", // Americas
  "5": "FRA", // Europe / Africa
};

const SOUTH_POLE_FALLBACK = "AUS";

export function CameraPresetsController() {
  const diagnosticsEnabled = useAppStore((state) => state.diagnosticsEnabled);
  const focusCountry = useAppStore((state) => state.focusCountry);

  useEffect(() => {
    if (!diagnosticsEnabled || typeof window === "undefined") {
      return;
    }

    const handler = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const iso3 = PRESETS[event.key];
      if (!iso3) return;
      event.preventDefault();
      const fallback = event.key === "2" ? SOUTH_POLE_FALLBACK : null;
      try {
        focusCountry(iso3);
      } catch {
        if (fallback) focusCountry(fallback);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [diagnosticsEnabled, focusCountry]);

  return null;
}
