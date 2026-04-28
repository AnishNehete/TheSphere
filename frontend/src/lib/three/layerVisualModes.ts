// layerVisualModes
// -----------------
// Per-layer visual biases that shape how the globe presents each domain.
// Each mode encodes camera framing preferences, visual declutter settings,
// and atmosphere emphasis so switching layers feels intentional and premium.
//
// These are pure data — consumed by useGlobeIntelligence and the camera rig.

import type { GlobeLayerId } from "@/lib/types";

export interface LayerVisualMode {
  /** Layer this mode applies to. */
  layer: GlobeLayerId;

  // Camera framing biases (additive offsets applied to the resolved shot)
  distanceBias: number;
  polarBias: number;
  fovBias: number;

  // Visual declutter
  borderOpacityScale: number;
  labelCap: number;
  cloudDimming: number;

  // Atmosphere emphasis (0 = default, 1 = maximum emphasis)
  atmosphereEmphasis: number;
}

const FLIGHTS_MODE: LayerVisualMode = {
  layer: "flights",
  // Wider corridor framing to show flight routes
  distanceBias: 0.12,
  polarBias: -0.04,
  fovBias: 2,
  borderOpacityScale: 0.6,
  labelCap: 8,
  cloudDimming: 0.3,
  atmosphereEmphasis: 0.2,
};

const WEATHER_MODE: LayerVisualMode = {
  layer: "weather",
  // More atmosphere and cloud emphasis
  distanceBias: 0.05,
  polarBias: 0,
  fovBias: 1,
  borderOpacityScale: 0.4,
  labelCap: 6,
  cloudDimming: 0,
  atmosphereEmphasis: 0.7,
};

const CONFLICT_MODE: LayerVisualMode = {
  layer: "conflict",
  // Tighter hotspot framing
  distanceBias: -0.1,
  polarBias: 0.02,
  fovBias: -1,
  borderOpacityScale: 0.9,
  labelCap: 5,
  cloudDimming: 0.5,
  atmosphereEmphasis: 0.1,
};

const HEALTH_MODE: LayerVisualMode = {
  layer: "health",
  // Softer regional focus
  distanceBias: 0,
  polarBias: 0,
  fovBias: 0,
  borderOpacityScale: 0.7,
  labelCap: 5,
  cloudDimming: 0.2,
  atmosphereEmphasis: 0.3,
};

const LAYER_VISUAL_MODES: Record<GlobeLayerId, LayerVisualMode> = {
  flights: FLIGHTS_MODE,
  weather: WEATHER_MODE,
  conflict: CONFLICT_MODE,
  health: HEALTH_MODE,
};

export function getLayerVisualMode(layer: GlobeLayerId): LayerVisualMode {
  return LAYER_VISUAL_MODES[layer];
}
