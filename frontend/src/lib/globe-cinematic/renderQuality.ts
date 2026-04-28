/**
 * Sphere Cinematic Globe - Quality Tiers (Phase 0)
 *
 * SINGLE SOURCE OF TRUTH for scalable quality. Every visual module reads
 * its tunables from here. Do NOT introduce per-system quality flags; if a
 * new knob is needed, add it to QualityDescriptor and set values for all
 * four tiers so behavior stays predictable.
 *
 * This file is pure config with no runtime dependencies. It is safe to
 * import from any layer including SSR code paths.
 */

export type QualityTier = "low" | "medium" | "high" | "ultra";

export const QUALITY_TIERS: readonly QualityTier[] = [
  "low",
  "medium",
  "high",
  "ultra",
] as const;

export interface TilesQualitySettings {
  /**
   * Screen-space error target for 3d-tiles-renderer. Higher = coarser
   * tiles = cheaper. Phase 1 wires this into the TilesRenderer instance.
   */
  readonly errorTarget: number;
  /** Maximum tile downloads in flight at once. */
  readonly maxDownloads: number;
  /** Soft cap on resident GPU tile cache (tile count). */
  readonly tileCacheSize: number;
}

export interface AtmosphereQualitySettings {
  /**
   * Optional outer artistic halo shell in addition to the inner shell.
   * Phase 2 (atmosphere) interprets this. Low/medium keep it off to save
   * overdraw at the horizon.
   */
  readonly enableOuterShell: boolean;
  /**
   * Integration / sample count for the atmosphere shader. Phase 2 (Y-path)
   * ports the artistic twilight shell from realistic-earth which ignores
   * this value; kept in the descriptor so a future Rayleigh/Mie upgrade
   * has a budget hook without requiring a schema change.
   */
  readonly integrationSamples: number;
}

export interface CloudQualitySettings {
  readonly enabled: boolean;
  /** Primary raymarch steps per pixel. */
  readonly raymarchSteps: number;
  /** Secondary (sun-to-sample) raymarch steps. */
  readonly raymarchLightSteps: number;
  /** Render-target downscale factor (0.5 = half resolution, upsampled). */
  readonly bufferScale: number;
}

export interface EarthRealismQualitySettings {
  readonly nightLights: boolean;
  readonly oceanSpecular: boolean;
}

export interface SpaceQualitySettings {
  readonly starfield: boolean;
  readonly starCount: number;
}

export interface EffectsQualitySettings {
  readonly postProcessing: boolean;
  readonly bloom: boolean;
  readonly temporalAntialiasing: boolean;
}

export interface QualityDescriptor {
  /** Clamp for window.devicePixelRatio. */
  readonly maxPixelRatio: number;
  /** Default offscreen buffer scale (1.0 = full resolution). */
  readonly offscreenBufferScale: number;
  readonly tiles: TilesQualitySettings;
  readonly atmosphere: AtmosphereQualitySettings;
  readonly clouds: CloudQualitySettings;
  readonly earth: EarthRealismQualitySettings;
  readonly space: SpaceQualitySettings;
  readonly effects: EffectsQualitySettings;
}

export const QUALITY_DESCRIPTORS: Readonly<
  Record<QualityTier, QualityDescriptor>
> = {
  low: {
    maxPixelRatio: 1,
    offscreenBufferScale: 0.5,
    tiles: { errorTarget: 24, maxDownloads: 4, tileCacheSize: 300 },
    atmosphere: { enableOuterShell: false, integrationSamples: 8 },
    clouds: {
      enabled: false,
      raymarchSteps: 0,
      raymarchLightSteps: 0,
      bufferScale: 0.5,
    },
    earth: { nightLights: true, oceanSpecular: false },
    space: { starfield: true, starCount: 2000 },
    effects: {
      postProcessing: false,
      bloom: false,
      temporalAntialiasing: false,
    },
  },
  medium: {
    maxPixelRatio: 1.25,
    offscreenBufferScale: 0.75,
    tiles: { errorTarget: 16, maxDownloads: 6, tileCacheSize: 600 },
    atmosphere: { enableOuterShell: false, integrationSamples: 12 },
    clouds: {
      enabled: true,
      raymarchSteps: 32,
      raymarchLightSteps: 4,
      bufferScale: 0.5,
    },
    earth: { nightLights: true, oceanSpecular: true },
    space: { starfield: true, starCount: 4000 },
    effects: {
      postProcessing: false,
      bloom: false,
      temporalAntialiasing: false,
    },
  },
  high: {
    maxPixelRatio: 1.5,
    offscreenBufferScale: 1.0,
    tiles: { errorTarget: 10, maxDownloads: 8, tileCacheSize: 900 },
    atmosphere: { enableOuterShell: true, integrationSamples: 16 },
    clouds: {
      enabled: true,
      raymarchSteps: 64,
      raymarchLightSteps: 6,
      bufferScale: 0.75,
    },
    earth: { nightLights: true, oceanSpecular: true },
    space: { starfield: true, starCount: 8000 },
    effects: {
      postProcessing: true,
      bloom: true,
      temporalAntialiasing: false,
    },
  },
  ultra: {
    maxPixelRatio: 2,
    offscreenBufferScale: 1.0,
    tiles: { errorTarget: 6, maxDownloads: 12, tileCacheSize: 1500 },
    atmosphere: { enableOuterShell: true, integrationSamples: 24 },
    clouds: {
      enabled: true,
      raymarchSteps: 96,
      raymarchLightSteps: 8,
      bufferScale: 1.0,
    },
    earth: { nightLights: true, oceanSpecular: true },
    space: { starfield: true, starCount: 12000 },
    effects: {
      postProcessing: true,
      bloom: true,
      temporalAntialiasing: true,
    },
  },
} as const;

export const DEFAULT_QUALITY_TIER: QualityTier = "high";

export function getQualityDescriptor(tier: QualityTier): QualityDescriptor {
  return QUALITY_DESCRIPTORS[tier];
}
