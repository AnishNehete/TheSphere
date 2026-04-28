import { create } from "zustand";

import type { CameraMode } from "@/lib/types";

interface GlobeState {
  hoveredCountry: string | null;
  selectedCountry: string | null;
  selectedRegionSlug: string | null;
  cameraMode: CameraMode;
  autoRotate: boolean;
  userInteracting: boolean;
  selectedSignalId: string | null;
  setHoveredCountry: (iso3: string | null) => void;
  focusCountry: (iso3: string) => void;
  focusSignal: (signalId: string, iso3Hint?: string | null) => void;
  focusRegion: (regionSlug: string) => void;
  clearFocus: () => void;
  setCameraMode: (mode: CameraMode) => void;
  setAutoRotate: (autoRotate: boolean) => void;
  setUserInteracting: (userInteracting: boolean) => void;
}

export const useGlobeStore = create<GlobeState>((set) => ({
  hoveredCountry: null,
  selectedCountry: null,
  selectedRegionSlug: null,
  cameraMode: "intro",
  autoRotate: true,
  userInteracting: false,
  selectedSignalId: null,

  setHoveredCountry: (hoveredCountry) =>
    set(() => ({
      hoveredCountry,
    })),

  focusCountry: (selectedCountry) =>
    set(() => ({
      selectedCountry,
      selectedRegionSlug: null,
      selectedSignalId: null,
      autoRotate: false,
      userInteracting: false,
    })),

  focusSignal: (selectedSignalId, iso3Hint) =>
    set(() => ({
      selectedCountry: iso3Hint ?? null,
      selectedRegionSlug: null,
      selectedSignalId,
      autoRotate: false,
      userInteracting: false,
    })),

  focusRegion: (selectedRegionSlug) =>
    set(() => ({
      selectedCountry: null,
      selectedRegionSlug,
      selectedSignalId: null,
      autoRotate: false,
      userInteracting: false,
    })),

  clearFocus: () =>
    set(() => ({
      selectedCountry: null,
      selectedRegionSlug: null,
      selectedSignalId: null,
      autoRotate: true,
      userInteracting: false,
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
}));
