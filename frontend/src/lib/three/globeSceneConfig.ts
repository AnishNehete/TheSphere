import { Color, Vector3 } from "three";

import type { GlobeQualityPreset } from "@/lib/types";

export const GLOBE_RADIUS = 1;
export const ATMOSPHERE_RADIUS = GLOBE_RADIUS * 1.03;
// COUNTRY_BORDER_RADIUS is intentionally hugged very close to the surface.
// Earlier iterations used 1.0018, which lifted the border mesh far enough
// off the planet that it read as a "wireframe shell" on top of the earth —
// see docs/ui/globe-borders.md. 1.00085 is the smallest offset that still
// avoids z-fighting with the earth mesh on mid/high quality presets. Hover
// and selected outlines add tiny additional offsets on top of this (see
// CountryFillLayer).
export const COUNTRY_BORDER_RADIUS = GLOBE_RADIUS * 1.00085;
export const COUNTRY_FILL_RADIUS = GLOBE_RADIUS * 1.0032;
export const REGION_FILL_RADIUS = GLOBE_RADIUS * 1.0042;
export const REGION_LINE_RADIUS = GLOBE_RADIUS * 1.0048;
// Phase 19C.3 — cloud shells lifted slightly so the cloud body reads as a
// distinct envelope above the planet rather than a UV-mapped surface
// decal. Inner shell sits well above the atmosphere inner radius so the
// limb shows real cloud thickness; outer shell carries cirrus/wispy haze.
export const CLOUD_RADIUS = GLOBE_RADIUS * 1.022;
export const CLOUD_SECONDARY_RADIUS = GLOBE_RADIUS * 1.032;

// Phase 3.6/3.7 — overlay tuning controls.
// OVERLAY_OPACITY_MULT is a global multiplier applied on top of the border
// layer's own base opacity. Drop it to further calm the wireframe feel at
// wide framing, raise it for documentation captures. 0 hides overlays
// entirely, 1 keeps their intrinsic base opacity.
//
// Phase 3.7 dropped this from 0.72 → 0.25 as part of the overlay calm-down
// pass: the borders/region overlays are now treated as restrained
// cartographic hints rather than a dominant visual layer, matching the
// product brief that the globe is *context* rather than a wireframe shell.
export const OVERLAY_OPACITY_MULT = 0.25;
// OVERLAY_DEPTH_BIAS is a radial offset added on top of COUNTRY_BORDER_RADIUS
// at render time. Positive values push the border mesh further off the
// surface (use with care: too much and the shell look returns). Negative
// values can be used to combat z-fighting on quality presets that show it.
// The bias is small enough that it does not introduce visible parallax.
export const OVERLAY_DEPTH_BIAS = 0.00015;

export const SUN_POSITION = new Vector3(7.2, 4.1, 5.4);
export const SUN_DIRECTION = SUN_POSITION.clone().normalize();

export const FILL_POSITION = new Vector3(-5.8, 1.4, -5.2);
export const FILL_COLOR = new Color("#88a7d6");
export const SUN_COLOR = new Color("#ffffff");
export const AMBIENT_COLOR = new Color("#d7e2ef");

export const CLOUD_ROTATION_SPEED = 0.0036;
export const CLOUD_SHADOW_UV_SPEED = CLOUD_ROTATION_SPEED / (Math.PI * 2);
// Keep the background muted so the globe stays dominant even after ACES and bloom.
// Phase 19C.4 verification — opacity raised again. The 0.78 value still
// produced a pure-black background in the actual screenshot (image #4
// in the verification batch). Bumping past the ACES + bloom-threshold
// knee so stars survive the post-processing pipeline. With AdditiveBlending
// + ACES tone mapping at exposure 0.92, the per-pixel post-tonemap value
// for an average star pixel was estimated at ~0.20 — borderline against
// the near-black background. Doubling here gives a clear-but-restrained
// star field.
export const STARFIELD_OPACITY = 1.95;
export const STARFIELD_TINT = new Color("#ccd6e8");
export const STARFIELD_ROTATION_SPEED = 0.0002;
// Exposure and bloom are intentionally conservative: preserve Earth detail first,
// then let the atmosphere rim and sun energy carry the cinematic lift.
// Phase 19C.2: reduced bloom strength and lifted threshold so the rim no longer
// reads as "electric/game-like". The atmosphere should support the globe, not
// scream for attention — Bloomberg-serious, not sci-fi UI.
export const TONE_MAPPING_EXPOSURE = 0.92;
export const BLOOM_STRENGTH = 0.16;
export const BLOOM_RADIUS = 0.62;
export const BLOOM_THRESHOLD = 0.88;
export const USER_IDLE_RESUME_MS = 2400;
export const ATMOSPHERE_DAY_COLOR = new Color("#3a9eff");
export const ATMOSPHERE_TWILIGHT_COLOR = new Color("#ff8833"); // kept for back-compat
// Multi-band twilight: warm orange inner belt, purple-blue outer belt
export const ATMOSPHERE_ORANGE_COLOR = new Color("#ff7118");
export const ATMOSPHERE_PURPLE_COLOR = new Color("#5514b8");
export const ATMOSPHERE_NIGHT_COLOR = new Color("#0d2d62");

// Phase 3.5 — shared atmospheric scatter palette.
// These are the *actual shipping values* used by the atmosphere shader and are
// also consumed by the earth shader so that the terminator reads as a single
// coherent band across atmosphere, ocean, night lights, and horizon coupling.
// Importers should `.clone()` these before passing into per-material uniforms.
//
// Phase 3.7 color science correction:
// - ATMOSPHERE_RAYLEIGH_TINT stays a clean, controlled day-sky blue.
// - ATMOSPHERE_TWILIGHT_TINT is pulled off the saturated red-orange of Phase 3.5
//   (#ff9a5c) toward a cooler, desaturated warm orange. The visual goal is a
//   sunrise color that reads as "photographed Earth at dawn", not as a crimson
//   stylized band. Red was the single biggest source of the hard twilight halo
//   in earlier phases — this desaturation is the color-science fix.
// Phase 19C.2 — restrained "premium intelligence" rim palette.
// The earlier #5fa8ff Rayleigh tint photographed as an electric/neon halo at
// the limb. Pulling the blue point toward a slightly desaturated, cooler day
// sky (#7eb1e6) keeps the spectral identity of Rayleigh while reading as
// physically plausible atmosphere instead of game-UI glow. The twilight band
// is also pulled away from saturated orange toward a restrained warm sunrise.
export const ATMOSPHERE_RAYLEIGH_TINT = new Color("#7eb1e6");
export const ATMOSPHERE_MIE_TINT = new Color("#f7dcb6");
export const ATMOSPHERE_TWILIGHT_TINT = new Color("#dfa276");
export const ATMOSPHERE_INTENSITY = 0.92;
export const ATMOSPHERE_FALLOFF = 1.55;
export const ATMOSPHERE_SUN_BOOST = 0.92;
export const ATMOSPHERE_TWILIGHT_SHARPNESS = 2.2;
export const ATMOSPHERE_EDGE_SHARPNESS = 3.6;
export const ATMOSPHERE_ALPHA_SCALE = 0.66;

// Render order is explicit because the scene mixes opaque shells, transparent overlays,
// additive effects, and label sprites. Keeping this centralized makes transparent-layer
// regressions easier to audit.
export const SCENE_RENDER_ORDER = {
  stars: 1,
  solarGlare: 2,
  earth: 10,
  atmosphere: 12,
  clouds: 14,
  cloudsOuter: 15,
  diagnosticsLines: 18,
  countryBorders: 20,
  regionFill: 22,
  regionLine: 23,
  hoveredCountryFill: 24,
  selectedCountryFill: 25,
  hoveredCountryLine: 26,
  selectedCountryLine: 27,
  flightArcs: 32,
  heatmap: 34,
  markers: 38,
  pulsesHealth: 39,
  pulsesConflict: 40,
  diagnosticsLabels: 44,
  labels: 45,
} as const;

export interface GlobeCloudLayerDefinition {
  key: "inner" | "outer";
  radius: number;
  uvSpeed: number;
  offsetBias: number;
  seed: number;
  alpha: number;
  brightness: number;
  contrast: number;
  shadowWeight: number;
  shadowSideFade: number;
  limbBoost: number;
  renderOrder: number;
}

// Phase 19C.3 — inner cloud body is the dominant visible cloud cover; the
// outer shell is a thin cirrus/wisp pass at higher altitude. Earlier
// values (alpha 0.30 / 0.14) read as a faint smear at orbit framing —
// reviewers couldn't see clouds in screenshots over Atlantic/Pacific.
// New base alpha is generous enough to read on day-side land and ocean
// without washing the planet out (the shader itself still gates by
// sun-facing, terminator, and night masks).
export const CLOUD_LAYER_DEFINITIONS: readonly GlobeCloudLayerDefinition[] = [
  {
    key: "inner",
    radius: CLOUD_RADIUS,
    uvSpeed: CLOUD_ROTATION_SPEED * 0.16,
    offsetBias: 0,
    seed: 0.18,
    alpha: 0.62,
    brightness: 1.02,
    contrast: 1.08,
    shadowWeight: 0.72,
    shadowSideFade: 0.14,
    limbBoost: 0.92,
    renderOrder: SCENE_RENDER_ORDER.clouds,
  },
  {
    key: "outer",
    radius: CLOUD_SECONDARY_RADIUS,
    uvSpeed: CLOUD_ROTATION_SPEED * 0.23,
    offsetBias: 0.137,
    seed: 0.63,
    alpha: 0.26,
    brightness: 1.06,
    contrast: 1.14,
    shadowWeight: 0.44,
    shadowSideFade: 0.18,
    limbBoost: 1.16,
    renderOrder: SCENE_RENDER_ORDER.cloudsOuter,
  },
] as const;

export const CLOUD_SHADOW_STRENGTH = 0.92;
export const CLOUD_SHADOW_SOFTNESS = 1.32;
export const CLOUD_SHADOW_DAY_FADE = 0.46;
export const CLOUD_SHADOW_DARKEN = 0.40;

export interface GlobeRenderQualitySettings {
  dprMax: number;
  earthSegments: number;
  cloudSegments: number;
  atmosphereSegments: number;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  starfieldOpacity: number;
  solarGlareOpacityScale: number;
  vignetteStrength: number;
  saturation: number;
  contrast: number;
  // Phase 6A — temporal stability
  fxaaEnabled: boolean;
  // Phase 7 — volumetric clouds + sky-captured ocean reflection
  /** Raymarch steps for volumetric clouds. 0 = use shell fallback. */
  volumetricCloudSteps: number;
  /** Sun-direction light march steps for cloud self-shadowing. */
  volumetricCloudLightSteps: number;
  /** Enable sky-captured ocean reflection (requires volumetric clouds). */
  skyCaptureEnabled: boolean;
  // Phase 10B — unified temporal / LOD / atmosphere budget dial.
  // These fields co-move so that tier changes scale the whole pipeline as one
  // coherent system instead of forcing individual callers to pick compatible
  // knobs. The volumetricCloudSteps value above now acts as the default /
  // wide-orbit count; cloudStepsMax is the near-shell ceiling used by the
  // adaptive step formula.
  /** Compile-time ceiling for cloud raymarch steps (used as #define MAX_CLOUD_STEPS). */
  cloudStepsMax: number;
  /** Runtime floor for adaptive cloud steps at wide orbital framing. */
  cloudStepsMin: number;
  /** Atmosphere single-scatter sample count (compile-time #define ATM_SAMPLES). */
  atmosphereSamples: number;
  /** Enable cloud temporal reprojection + history blend. */
  taaEnabled: boolean;
  /** Blend weight applied to reprojected history (0 = current only, 1 = history only). */
  taaBlend: number;
  /** Cloud coverage RT resolution: "macro" = 512x256, "detail" = 1024x512. */
  coverageRTResolution: "macro" | "detail";
  // Phase 10C — captured-image envelope. Each knob adds a small optical
  // cue and is tiered so the low preset runs a cost-free clean pipeline.
  /** Enable slow exposure adaptation (no framebuffer readback, geometry-biased). */
  exposureAdaptationEnabled: boolean;
  /** Star count multiplier vs the Phase 10B baseline (1.0 = baseline). */
  starDensityMultiplier: number;
  /** Atmosphere-rim chromatic aberration offset in framebuffer pixels. 0 = off. */
  rimChromaAmount: number;
  /** Static lens-dust overlay strength. 0 = off. ~0.02 = barely visible. */
  lensDustStrength: number;
  /** Static film-grain strength. 0 = off. Amplitude clamped to the mid-tone mask. */
  grainStrength: number;
}

export const GLOBE_RENDER_QUALITY: Record<GlobeQualityPreset, GlobeRenderQualitySettings> = {
  low: {
    dprMax: 1.2,
    earthSegments: 128,
    cloudSegments: 96,
    atmosphereSegments: 96,
    bloomStrength: 0.08,
    bloomRadius: 0.56,
    bloomThreshold: 0.92,
    starfieldOpacity: 1.20,
    solarGlareOpacityScale: 0.34,
    vignetteStrength: 0.1,
    saturation: 1.02,
    contrast: 1.03,
    fxaaEnabled: false,
    volumetricCloudSteps: 0,
    volumetricCloudLightSteps: 0,
    skyCaptureEnabled: false,
    cloudStepsMax: 32,
    cloudStepsMin: 0,
    atmosphereSamples: 4,
    taaEnabled: false,
    taaBlend: 0.0,
    coverageRTResolution: "macro",
    exposureAdaptationEnabled: false,
    starDensityMultiplier: 1.0,
    rimChromaAmount: 0,
    lensDustStrength: 0,
    grainStrength: 0,
  },
  medium: {
    dprMax: 1.6,
    earthSegments: 160,
    cloudSegments: 128,
    atmosphereSegments: 128,
    bloomStrength: 0.10,
    bloomRadius: 0.6,
    bloomThreshold: 0.92,
    starfieldOpacity: 1.55,
    solarGlareOpacityScale: 0.40,
    vignetteStrength: 0.12,
    saturation: 1.01,
    contrast: 1.03,
    fxaaEnabled: true,
    volumetricCloudSteps: 32,
    volumetricCloudLightSteps: 4,
    skyCaptureEnabled: true,
    cloudStepsMax: 48,
    cloudStepsMin: 18,
    atmosphereSamples: 6,
    // Phase 19C.4 — TAA disabled on medium tier. The framebuffer-history
    // reprojection in volumetricClouds.ts blends current cloud radiance
    // against the prior composited frame, so when a cloud forms over a
    // pixel that previously showed dark Earth or black space the cloud
    // inherits that dark color → renders as a black silhouette and only
    // pops to white when motion rejection trips the blend (the
    // black-flash behaviour reported in the 19C.4 verification screenshot).
    // Re-enable only if a separate cloud-only history RT is added.
    taaEnabled: false,
    taaBlend: 0.0,
    coverageRTResolution: "macro",
    exposureAdaptationEnabled: true,
    starDensityMultiplier: 1.22,
    rimChromaAmount: 0.45,
    lensDustStrength: 0.018,
    grainStrength: 0.008,
  },
  high: {
    dprMax: 2,
    earthSegments: 256,
    cloudSegments: 192,
    atmosphereSegments: 256,
    bloomStrength: BLOOM_STRENGTH,
    bloomRadius: BLOOM_RADIUS,
    bloomThreshold: BLOOM_THRESHOLD,
    starfieldOpacity: STARFIELD_OPACITY,
    solarGlareOpacityScale: 0.52,
    vignetteStrength: 0.14,
    saturation: 1.02,
    contrast: 1.04,
    fxaaEnabled: true,
    volumetricCloudSteps: 64,
    volumetricCloudLightSteps: 6,
    skyCaptureEnabled: true,
    cloudStepsMax: 96,
    cloudStepsMin: 28,
    atmosphereSamples: 8,
    // Phase 19C.4 — TAA disabled on high tier (see medium-tier note for
    // the framebuffer-history bug). Cleaner per-frame clouds are worth
    // more than temporal smoothing while the bug is unaddressed.
    taaEnabled: false,
    taaBlend: 0.0,
    coverageRTResolution: "detail",
    exposureAdaptationEnabled: true,
    starDensityMultiplier: 1.38,
    rimChromaAmount: 0.65,
    lensDustStrength: 0.024,
    grainStrength: 0.012,
  },
};
