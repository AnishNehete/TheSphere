// useGlobeIntelligence
// --------------------
// Derives the globe's "story context" from the current app state.
// The globe becomes query-aware, layer-aware, and focus-aware so that
// camera framing, label caps, border opacity, and cloud dimming all
// respond to what the user is doing — not just static scene defaults.
//
// StoryType describes what kind of narrative the globe is presenting:
//   idle          — no focus, global overview
//   country-focus — a country is selected
//   signal-focus  — a specific signal is pinned
//   region-focus  — a region is selected
//   layer-browse  — user is switching/exploring layers without a focus target

"use client";

import { useMemo } from "react";

import { getLayerVisualMode, type LayerVisualMode } from "@/lib/three/layerVisualModes";
import type { GlobeLayerId } from "@/lib/types";
import { useAppStore } from "@/store/useAppStore";

export type StoryType =
  | "idle"
  | "country-focus"
  | "signal-focus"
  | "region-focus"
  | "layer-browse";

export interface GlobeIntelligence {
  storyType: StoryType;
  activeLayer: GlobeLayerId;
  visualMode: LayerVisualMode;

  // Computed declutter values
  focusIntensity: number;
  labelCap: number;
  borderOpacityScale: number;
  cloudsDimmed: boolean;
}

function deriveStoryType(
  selectedCountry: string | null,
  selectedRegionSlug: string | null,
  selectedSignalId: string | null,
  interactionMode: string
): StoryType {
  if (selectedSignalId) return "signal-focus";
  if (selectedCountry) return "country-focus";
  if (selectedRegionSlug) return "region-focus";
  if (interactionMode === "explore") return "layer-browse";
  return "idle";
}

function deriveFocusIntensity(storyType: StoryType): number {
  switch (storyType) {
    case "signal-focus":
      return 1.0;
    case "country-focus":
      return 0.8;
    case "region-focus":
      return 0.7;
    case "layer-browse":
      return 0.3;
    case "idle":
      return 0;
  }
}

export function useGlobeIntelligence(): GlobeIntelligence {
  const activeLayer = useAppStore((state) => state.activeLayer);
  const selectedCountry = useAppStore((state) => state.selectedCountry);
  const selectedRegionSlug = useAppStore((state) => state.selectedRegionSlug);
  const selectedSignalId = useAppStore((state) => state.selectedSignalId);
  const interactionMode = useAppStore((state) => state.interactionMode);

  return useMemo(() => {
    const storyType = deriveStoryType(
      selectedCountry,
      selectedRegionSlug,
      selectedSignalId,
      interactionMode
    );

    const visualMode = getLayerVisualMode(activeLayer);
    const focusIntensity = deriveFocusIntensity(storyType);

    // During focus, reduce label count to declutter; during idle, use layer default
    const labelCap =
      storyType === "idle" || storyType === "layer-browse"
        ? visualMode.labelCap
        : Math.max(2, Math.round(visualMode.labelCap * (1 - focusIntensity * 0.5)));

    // Borders become more visible during country/region focus, dimmed during signal focus
    const borderOpacityScale =
      storyType === "country-focus" || storyType === "region-focus"
        ? Math.min(1.0, visualMode.borderOpacityScale * 1.4)
        : visualMode.borderOpacityScale * (1 - focusIntensity * 0.3);

    // Clouds dimmed when focus intensity is high and the layer wants them dimmed
    const cloudsDimmed = visualMode.cloudDimming > 0.3 && focusIntensity > 0.5;

    return {
      storyType,
      activeLayer,
      visualMode,
      focusIntensity,
      labelCap,
      borderOpacityScale,
      cloudsDimmed,
    };
  }, [activeLayer, interactionMode, selectedCountry, selectedRegionSlug, selectedSignalId]);
}
