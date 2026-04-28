"use client";

import { useMemo } from "react";

import { GlassPanel } from "@/components/ui/GlassPanel";
import { SystemIcon } from "@/components/ui/SystemIcon";
import { QUALITY_STORAGE_KEY } from "@/lib/runtime/renderSettings";
import { centroidForIso3 } from "@/lib/three/geo";
import { REDUCE_MOTION_STORAGE_KEY, useAccessibilityStore } from "@/store/useAccessibilityStore";
import { useDataStore } from "@/store/useDataStore";
import { useGlobeStore } from "@/store/useGlobeStore";
import { useLayerStore } from "@/store/useLayerStore";
import { useRenderSettingsStore } from "@/store/useRenderSettingsStore";

import { formatRelativeTime, LAYER_LABELS } from "./signalRows";

const QUALITY_ORDER = ["low", "medium", "high"] as const;
const QUALITY_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
} as const;
const DIAGNOSTIC_LABELS = {
  full: "Full Scene",
  earth: "Earth Only",
  borders: "Borders",
  dots: "Dots",
  uv: "UV Debug",
  day: "Day Map",
  normal: "Normal Map",
  specular: "Specular Map",
} as const;

export function TopBar() {
  const activeLayer = useLayerStore((state) => state.activeLayer);
  const lastUpdated = useDataStore((state) => state.lastUpdated);
  const selectedCountry = useGlobeStore((state) => state.selectedCountry);
  const selectedRegionSlug = useGlobeStore((state) => state.selectedRegionSlug);
  const regions = useDataStore((state) => state.regions);
  const reduceMotion = useAccessibilityStore((state) => state.reduceMotion);
  const setReduceMotion = useAccessibilityStore((state) => state.setReduceMotion);
  const diagnosticsEnabled = useRenderSettingsStore((state) => state.diagnosticsEnabled);
  const diagnosticsView = useRenderSettingsStore((state) => state.diagnosticsView);
  const qualityPreset = useRenderSettingsStore((state) => state.qualityPreset);
  const setQualityPreset = useRenderSettingsStore((state) => state.setQualityPreset);

  const focusLabel = useMemo(() => {
    if (selectedCountry) {
      return centroidForIso3(selectedCountry)?.name ?? selectedCountry;
    }

    if (selectedRegionSlug) {
      return regions.find((entry) => entry.slug === selectedRegionSlug)?.name ?? selectedRegionSlug;
    }

    return "Global";
  }, [regions, selectedCountry, selectedRegionSlug]);

  const toggleReduceMotion = () => {
    const nextValue = !reduceMotion;
    setReduceMotion(nextValue);
    window.localStorage.setItem(REDUCE_MOTION_STORAGE_KEY, String(nextValue));
  };

  const cycleQuality = () => {
    const currentIndex = QUALITY_ORDER.indexOf(qualityPreset);
    const nextValue = QUALITY_ORDER[(currentIndex + 1) % QUALITY_ORDER.length];
    setQualityPreset(nextValue);
    window.localStorage.setItem(QUALITY_STORAGE_KEY, nextValue);
  };

  return (
    <GlassPanel as="header" className="top-bar" data-testid="hud-top-bar">
      <div className="top-bar__brand">
        <div className="top-bar__brand-mark" aria-hidden>
          <SystemIcon name="globe" />
        </div>
        <div>
          <div className="top-bar__eyebrow">Disease Intelligence</div>
          <div className="top-bar__title">The Sphere</div>
        </div>
      </div>

      <div className="top-bar__strap">
        <span>Production-grade globe</span>
        <strong>{LAYER_LABELS[activeLayer]}</strong>
      </div>

      <div className="top-bar__meta">
        <div className="top-bar__meta-block">
          <span>Focus</span>
          <strong>{focusLabel}</strong>
        </div>
        <div className="top-bar__meta-block">
          <span>Layer</span>
          <strong>{LAYER_LABELS[activeLayer]}</strong>
        </div>
        <div className="top-bar__meta-block">
          <span>Live</span>
          <strong>{formatRelativeTime(lastUpdated)}</strong>
        </div>
        {diagnosticsEnabled ? (
          <div className="top-bar__meta-block top-bar__meta-block--diagnostics">
            <span>Diagnostics</span>
            <strong>{DIAGNOSTIC_LABELS[diagnosticsView]}</strong>
          </div>
        ) : null}
        <button type="button" className="top-bar__quality-toggle" data-quality={qualityPreset} onClick={cycleQuality}>
          <span>Quality</span>
          <strong>{QUALITY_LABELS[qualityPreset]}</strong>
        </button>
        <button
          type="button"
          className="top-bar__motion-toggle"
          aria-pressed={reduceMotion}
          onClick={toggleReduceMotion}
        >
          <span>Motion</span>
          <strong>{reduceMotion ? "Reduced" : "Standard"}</strong>
        </button>
      </div>
    </GlassPanel>
  );
}
