import { create } from "zustand";

import { DEFAULT_DIAGNOSTICS_VIEW, DEFAULT_GLOBE_QUALITY } from "@/lib/runtime/renderSettings";
import type { CameraMode, DiagnosticsView, GeoAuditSettings, GlobeLayerId, GlobeQualityPreset, SearchResolutionType } from "@/lib/types";

export type InteractionMode = "boot" | "intro" | "explore" | "country-focus" | "signal-focus";
export type CameraOwner = "boot" | "intro" | "controls" | "focus";

export interface HoverTooltipPayload {
  x: number;
  y: number;
  iso3: string;
  eyebrow: string;
  title: string;
  score: number | null;
  signalCount: number;
  summary: string;
  activeLayer: GlobeLayerId | null;
}

export interface QueryBrief {
  query: string;
  title: string;
  detail: string;
  summary: string;
  actionLabel: string;
  type: SearchResolutionType;
  layer: GlobeLayerId | null;
}

interface RuntimeSettings {
  diagnosticsEnabled: boolean;
  diagnosticsView: DiagnosticsView;
  geoAuditEnabled: boolean;
  geoAudit: GeoAuditSettings;
  qualityPreset: GlobeQualityPreset;
  reduceMotion: boolean;
}

export interface AppState {
  engineReady: boolean;
  engineError: string | null;
  feedsReady: boolean;
  feedError: string | null;
  interactionMode: InteractionMode;
  cameraOwner: CameraOwner;
  introProgress: number;
  diagnosticsEnabled: boolean;
  diagnosticsView: DiagnosticsView;
  geoAuditEnabled: boolean;
  geoAudit: GeoAuditSettings;
  qualityPreset: GlobeQualityPreset;
  reduceMotion: boolean;
  activeLayer: GlobeLayerId;
  showBorders: boolean;
  showClouds: boolean;
  showLabels: boolean;
  showHeatmap: boolean;
  cameraMode: CameraMode;
  autoRotate: boolean;
  userInteracting: boolean;
  hoveredCountry: string | null;
  selectedCountry: string | null;
  selectedRegionSlug: string | null;
  selectedSignalId: string | null;
  hoverTooltip: HoverTooltipPayload | null;
  queryBrief: QueryBrief | null;
  setRuntimeSettings: (settings: RuntimeSettings) => void;
  setEngineReady: (ready: boolean) => void;
  setEngineError: (error: string | null) => void;
  setFeedsStatus: (ready: boolean, error?: string | null) => void;
  startIntro: () => void;
  setIntroProgress: (progress: number) => void;
  finishIntro: () => void;
  setCameraOwner: (owner: CameraOwner) => void;
  setActiveLayer: (layer: GlobeLayerId) => void;
  setShowBorders: (value: boolean) => void;
  setShowClouds: (value: boolean) => void;
  setShowLabels: (value: boolean) => void;
  setShowHeatmap: (value: boolean) => void;
  setHoveredCountry: (iso3: string | null) => void;
  focusCountry: (iso3: string) => void;
  focusRegion: (regionSlug: string) => void;
  focusSignal: (signalId: string, iso3Hint?: string | null) => void;
  clearFocus: () => void;
  setCameraMode: (mode: CameraMode) => void;
  setAutoRotate: (value: boolean) => void;
  setUserInteracting: (value: boolean) => void;
  setHoverTooltip: (payload: HoverTooltipPayload | null) => void;
  scrollProgress: number;
  setScrollProgress: (progress: number) => void;
  setQueryBrief: (payload: QueryBrief | null) => void;
  clearQueryBrief: () => void;
}

const DEFAULT_LAYER: GlobeLayerId = "flights";

export const useAppStore = create<AppState>((set) => ({
  engineReady: false,
  engineError: null,
  feedsReady: false,
  feedError: null,
  interactionMode: "boot",
  cameraOwner: "boot",
  introProgress: 0,
  diagnosticsEnabled: false,
  diagnosticsView: DEFAULT_DIAGNOSTICS_VIEW,
  geoAuditEnabled: false,
  geoAudit: {
    borders: false,
    pickHits: false,
    clouds: false,
    atmosphere: false,
    postprocessing: false,
    stars: false,
    sun: false,
    markers: false,
    night: false,
  },
  qualityPreset: DEFAULT_GLOBE_QUALITY,
  reduceMotion: false,
  activeLayer: DEFAULT_LAYER,
  showBorders: true,
  showClouds: true,
  showLabels: true,
  showHeatmap: true,
  cameraMode: "intro",
  autoRotate: true,
  userInteracting: false,
  hoveredCountry: null,
  selectedCountry: null,
  selectedRegionSlug: null,
  selectedSignalId: null,
  hoverTooltip: null,
  queryBrief: null,
  scrollProgress: 0,

  setRuntimeSettings: (settings) =>
    set(() => ({
      diagnosticsEnabled: settings.diagnosticsEnabled,
      diagnosticsView: settings.diagnosticsView,
      geoAuditEnabled: settings.geoAuditEnabled,
      geoAudit: settings.geoAudit,
      qualityPreset: settings.qualityPreset,
      reduceMotion: settings.reduceMotion,
      autoRotate: !settings.reduceMotion,
    })),

  setEngineReady: (engineReady) =>
    set((state) => {
      if (!engineReady) {
        return {
          engineReady,
          interactionMode: "boot" as InteractionMode,
          cameraOwner: "boot" as CameraOwner,
          introProgress: 0,
        };
      }

      if (state.engineReady) {
        return {
          engineReady,
        };
      }

      return {
        engineReady,
        // The homepage now loads directly into the investigation workspace.
        // Engine readiness should unlock search and spatial context immediately
        // instead of forcing a cinematic intro gate on the active route.
        interactionMode: "explore" as InteractionMode,
        cameraOwner: "controls" as CameraOwner,
        introProgress: 1,
        cameraMode: "live-idle" as CameraMode,
      };
    }),

  setEngineError: (engineError) =>
    set(() => ({
      engineError,
    })),

  setFeedsStatus: (feedsReady, feedError = null) =>
    set(() => ({
      feedsReady,
      feedError,
    })),

  startIntro: () =>
    set((state) => ({
      interactionMode: state.engineReady ? "intro" : "boot",
      cameraOwner: state.engineReady ? "intro" : "boot",
      introProgress: 0,
    })),

  setIntroProgress: (introProgress) =>
    set(() => ({
      introProgress: Math.max(0, Math.min(1, introProgress)),
    })),

  finishIntro: () =>
    set((state) => ({
      interactionMode:
        state.selectedSignalId !== null
          ? "signal-focus"
          : state.selectedCountry !== null || state.selectedRegionSlug !== null
            ? "country-focus"
            : "explore",
      cameraOwner: state.selectedSignalId || state.selectedCountry || state.selectedRegionSlug ? "focus" : "controls",
      introProgress: 1,
    })),

  setCameraOwner: (cameraOwner) =>
    set(() => ({
      cameraOwner,
    })),

  setActiveLayer: (activeLayer) =>
    set(() => ({
      activeLayer,
    })),

  setShowBorders: (showBorders) =>
    set(() => ({
      showBorders,
    })),

  setShowClouds: (showClouds) =>
    set(() => ({
      showClouds,
    })),

  setShowLabels: (showLabels) =>
    set(() => ({
      showLabels,
    })),

  setShowHeatmap: (showHeatmap) =>
    set(() => ({
      showHeatmap,
    })),

  setHoveredCountry: (hoveredCountry) =>
    set(() => ({
      hoveredCountry,
    })),

  focusCountry: (selectedCountry) =>
    set(() => ({
      selectedCountry,
      selectedRegionSlug: null,
      selectedSignalId: null,
      interactionMode: "country-focus",
      cameraOwner: "focus",
      autoRotate: false,
      userInteracting: false,
    })),

  focusRegion: (selectedRegionSlug) =>
    set(() => ({
      selectedCountry: null,
      selectedRegionSlug,
      selectedSignalId: null,
      interactionMode: "country-focus",
      cameraOwner: "focus",
      autoRotate: false,
      userInteracting: false,
    })),

  focusSignal: (selectedSignalId, iso3Hint = null) =>
    set(() => ({
      selectedCountry: iso3Hint ?? null,
      selectedRegionSlug: null,
      selectedSignalId,
      interactionMode: "signal-focus",
      cameraOwner: "focus",
      autoRotate: false,
      userInteracting: false,
    })),

  clearFocus: () =>
    set(() => ({
      selectedCountry: null,
      selectedRegionSlug: null,
      selectedSignalId: null,
      interactionMode: "explore",
      cameraOwner: "controls",
      autoRotate: true,
      userInteracting: false,
      hoverTooltip: null,
    })),

  setCameraMode: (cameraMode) =>
    set(() => ({
      cameraMode,
    })),

  setAutoRotate: (autoRotate) =>
    set(() => ({
      autoRotate,
    })),

  setUserInteracting: (userInteracting) =>
    set(() => ({
      userInteracting,
    })),

  setHoverTooltip: (hoverTooltip) =>
    set(() => ({
      hoverTooltip,
    })),

  setScrollProgress: (scrollProgress) =>
    set(() => ({
      scrollProgress: Math.max(0, Math.min(1, scrollProgress)),
    })),

  setQueryBrief: (queryBrief) =>
    set(() => ({
      queryBrief,
    })),

  clearQueryBrief: () =>
    set(() => ({
      queryBrief: null,
    })),
}));
