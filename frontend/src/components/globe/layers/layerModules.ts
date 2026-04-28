import type { GlobeLayerId, LayerModuleContract } from "@/lib/types";

export interface LayerVisibilityContext {
  activeLayer: GlobeLayerId;
  showHeatmap: boolean;
  showLabels: boolean;
}

interface LayerModuleDefinition extends Omit<LayerModuleContract, "visible"> {
  isVisible: (context: LayerVisibilityContext) => boolean;
}

export const LAYER_MODULES: Record<
  "flightArcs" | "heatmap" | "markers" | "pulses" | "labels",
  LayerModuleDefinition
> = {
  flightArcs: {
    id: "flights",
    isVisible: (context) => context.activeLayer === "flights",
  },
  heatmap: {
    id: "weather",
    isVisible: (context) => context.showHeatmap && (context.activeLayer === "weather" || context.activeLayer === "health"),
  },
  markers: {
    id: "conflict",
    isVisible: (context) => context.activeLayer === "conflict",
  },
  pulses: {
    id: "health",
    isVisible: (context) => context.activeLayer === "health" || context.activeLayer === "conflict",
  },
  labels: {
    id: "health",
    isVisible: (context) => context.showLabels,
  },
};
