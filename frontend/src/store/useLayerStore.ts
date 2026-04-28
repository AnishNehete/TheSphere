import { create } from "zustand";

import type { GlobeLayerId } from "@/lib/types";

interface LayerState {
  activeLayer: GlobeLayerId;
  showBorders: boolean;
  showClouds: boolean;
  showLabels: boolean;
  showHeatmap: boolean;
  setActiveLayer: (layer: GlobeLayerId) => void;
  setShowBorders: (value: boolean) => void;
  setShowClouds: (value: boolean) => void;
  setShowLabels: (value: boolean) => void;
  setShowHeatmap: (value: boolean) => void;
}

export const useLayerStore = create<LayerState>((set) => ({
  activeLayer: "flights",
  showBorders: true,
  showClouds: true,
  showLabels: true,
  showHeatmap: true,

  setActiveLayer: (activeLayer) => set(() => ({ activeLayer })),
  setShowBorders: (showBorders) => set(() => ({ showBorders })),
  setShowClouds: (showClouds) => set(() => ({ showClouds })),
  setShowLabels: (showLabels) => set(() => ({ showLabels })),
  setShowHeatmap: (showHeatmap) => set(() => ({ showHeatmap })),
}));
