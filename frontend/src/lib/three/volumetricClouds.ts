/**
 * Phase 7A / 7.9A / 7.9F / 8A — Volumetric Cloud Rendering
 *
 * Raymarched volumetric clouds through a bounded spherical shell with
 * procedural weather structure, domain-warped swirl, latitude-aware
 * climate organization, real Earth land/ocean anchoring, persistent
 * storm advection, and altitude-stratified density.
 *
 * Phase 7.9A additions:
 *  - Two-level domain warp with Coriolis rotation for cyclonic swirl
 *  - Procedural storm system seeds via domain-warped noise fields
 *  - Latitude-based climate bands (ITCZ, mid-latitude storm tracks,
 *    subtropical calm, polar sheets)
 *  - Per-fragment weather context computed once, used in all density
 *    sampling including light march self-shadowing
 *  - Extended debug modes for macro coverage, swirl, storms, climate
 *
 * Phase 7.9F additions (Earth-like organization):
 *  - Multi-frequency continental geography (3 octaves, asymmetric
 *    hemisphere phases) replaces single-frequency sinusoid.
 *  - Anisotropic storm noise stretches east-west like jet-stream bands.
 *  - Activity-gated swirl suppresses domain warp in calm regions.
 *  - Stable regional-identity noise biases basins.
 *  - Multi-peak ITCZ with longitudinal structure.
 *  - Eastern-basin subtropical dry zones reinforce the horse latitudes.
 *
 * Phase 8A additions (Earth-anchored weather):
 *  - Real Earth land/ocean mask (sampled from the specular texture) is
 *    woven into the climate bias. Oceans get a wet additive bias,
 *    continental interiors get a dry subtractive bias with a soft
 *    coastal falloff so the transition does not read as a hard edge.
 *  - Storm advection rotates the storm-seed position around the polar
 *    axis, eastward, at a latitude-dependent rate (peaks in mid-lat
 *    jet-stream bands). Storms now drift like identifiable systems
 *    instead of respawning diffusely.
 *  - Altitude stratification splits the cloud shell into a low dense
 *    regime (weather-driven — stratocumulus / convective tops) and a
 *    high thin regime (cirrus veil, more uniform). The mix profile
 *    varies by regime: storm corridors push mass low, subtropical
 *    calms and polar caps favor the thin high layer.
 *  - New debug modes: land/ocean mask, wet/dry bias, advection velocity,
 *    altitude-layer contribution, coupled coverage.
 *
 * Lighting model:
 *  - Beer-Lambert absorption along the view ray
 *  - Coarse-density light march toward the sun (self-shadowing)
 *  - Dual-lobe Henyey-Greenstein phase function (diffuse + silver lining)
 *  - Multi-scatter powder approximation
 *  - Shared atmosphere palette for twilight/Rayleigh coupling
 *  - Night-side suppression matching the earth shader
 *
 * Performance:
 *  - Step count injected via #define (avoids runtime branch overhead)
 *  - Light march uses coarse (texture-only) density — no noise
 *  - Weather context computed once per fragment, not per step
 *  - Land-mask sampled once per fragment (one extra texture read)
 *  - Early discard for fragments with no cloud coverage
 *  - Early exit when transmittance drops below threshold
 *  - Stable screen-space dither eliminates banding without temporal crawl
 */

import { Color, Matrix4, Texture, Vector2, Vector3 } from "three";

import {
  ATMOSPHERE_MIE_TINT,
  ATMOSPHERE_RAYLEIGH_TINT,
  ATMOSPHERE_TWILIGHT_TINT,
  SUN_DIRECTION,
} from "@/lib/three/globeSceneConfig";

// Cloud shell geometry — thicker than the old shell pair (1.018/1.026)
// to give the raymarch genuine depth to work with.
export const VOLUMETRIC_CLOUD_INNER_RADIUS = 1.012;
export const VOLUMETRIC_CLOUD_OUTER_RADIUS = 1.045;

// Density and absorption tuning.
// The cloud shell is only 0.033 world units thick, so density must be high
// enough for 64 steps through that thin shell to accumulate visible opacity.
//
// Phase 19C.3 — density scale lifted from 4.2 → 5.6 so cloud cover is
// clearly legible at orbit framing in screenshots and on first
// impression. Phase 19C.4 — applied authorized micro-tune 5.6 → 7.0
// after verification showed clouds still under-reading at the new wider
// camera framing (distance 4.6, FOV 32°). Absorption is held so the
// cloud body still looks soft rather than chalky.
export const VOLUMETRIC_CLOUD_DENSITY_SCALE = 7.0;
export const VOLUMETRIC_CLOUD_ABSORPTION = 7.5;

/* ------------------------------------------------------------------ */
/*  Vertex shader                                                      */
/* ------------------------------------------------------------------ */
export const VOLUMETRIC_CLOUD_VERTEX = /* glsl */ `
  varying vec3 vWorldPosition;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPosition = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

/* ------------------------------------------------------------------ */
/*  Fragment shader                                                    */
/* ------------------------------------------------------------------ */
export const VOLUMETRIC_CLOUD_FRAGMENT = /* glsl */ `
  precision highp float;

  const float PI = 3.141592653589793;

  // Phase 10B — MAX_CLOUD_STEPS is the compile-time ceiling used to satisfy
  // the WebGL for-loop constant requirement. The actual runtime step count
  // is uCloudStepCount (adaptive, set per-frame from JS based on camera
  // distance to the shell). Loops use i < MAX_CLOUD_STEPS as the bound and
  // early-break when i >= uCloudStepCount. LIGHT_STEPS remains a fixed
  // compile-time constant (its light-march is already coarse).

  uniform sampler2D uCloudMap;
  uniform sampler2D uLandMask;    // Phase 8A — r channel: water=bright, land=dark
  uniform sampler2D uClimatology; // Phase 8B — RGBA: R convection, G cover, B itcz, A corridor
  uniform float uCloudOffset;
  uniform vec3  uSunDirection;
  uniform float uTime;
  uniform float uInnerRadius;
  uniform float uOuterRadius;
  uniform float uDensityScale;
  uniform float uAbsorption;
  uniform vec3  uAtmosphereRayleighTint;
  uniform vec3  uAtmosphereTwilightTint;
  uniform vec3  uAtmosphereMieTint;
  uniform float uTwilightLift;
  uniform float uWrapLight;
  uniform float uTransmittedLight;
  uniform float uShadowTint;
  uniform float uNightFloor;
  uniform int   uCloudDebugMode;
  // Phase 7.9A — weather structure tuning
  uniform float uSwirlStrength;
  uniform float uStormIntensity;
  uniform float uClimateStrength;
  // Phase 8A — Earth-anchored weather tuning
  uniform float uLandMaskStrength;    // 0 disables land/ocean anchoring
  uniform float uStormAdvection;      // 0 freezes storms, 1 default
  uniform float uAltitudeBlend;       // 0 = all low, 1 = default mix
  // Phase 8B — orbital-realism tuning
  uniform float uClimatologyStrength; // 0 disables sampled climatology
  uniform float uAerialPerspective;   // 0 disables atmospheric scatter on clouds
  uniform float uCirrusStreakStrength;// 0 disables cirrus shear
  uniform float uAnvilStrength;       // 0 disables anvil-top behavior
  // Phase 9A — true shadow parity + band-specific scattering
  uniform float uStormMassBoost;      // 0 disables storm-core density multiplier
  uniform float uLowPhaseG;           // low-band HG forward-scatter asymmetry
  uniform float uHighPhaseG;          // high-band (cirrus) forward-scatter asymmetry
  uniform float uCloudTopShadow;      // 0 = flat, 1 = full cloud-top/underside separation
  uniform float uLimbSoftness;        // 0 = no limb tint, 1 = full Phase 8B strength
  // Phase 9B — orbital light transport refinement
  uniform sampler2D uSkyMap;
  uniform float uUseSkyMap;           // 0 disables sky-capture ambient
  uniform float uSkyAmbientStrength;  // 0 = analytic Rayleigh only, 1 = full sky lift
  uniform float uEarthShadowStrength; // 0 = no earth occlusion, 1 = full shadow
  uniform float uFrameIndex;          // temporal jitter driver (golden-ratio rotation)

  // Phase 10B Part 2 — adaptive step count. MAX_CLOUD_STEPS is the
  // compile-time ceiling, uCloudStepCount is the runtime cutoff.
  uniform int   uCloudStepCount;
  // Phase 10B Part 3 — cloud LOD bias. 0 = near / full detail, 1 = far /
  // detail passes suppressed. Driven from JS by camera distance to the
  // cloud shell so wide orbital framing loses expensive per-step noise
  // first, and zoom-ins recover the full micro-structure.
  uniform float uLODBias;
  // Phase 10B Part 1 — temporal reprojection state. uHistoryTex is the
  // previous-frame framebuffer. uPrevViewProjection re-projects the
  // current cloud-shell midpoint into the previous frame's screen space.
  // uTaaBlend caps the reprojected contribution; motion / alpha gates
  // further suppress it when the reprojection is unreliable.
  uniform float     uTaaEnabled;
  uniform float     uTaaBlend;
  uniform float     uHistoryReady;
  uniform vec2      uHistoryInvResolution;
  uniform mat4      uPrevViewProjection;
  uniform sampler2D uHistoryTex;

  varying vec3 vWorldPosition;

  /* ── Per-fragment weather globals ─────────────────────────────── */
  // Computed once in main() before the raymarch loop, used by all
  // density functions including the light march.
  vec3  gSwirlWarp;
  float gClimateBias;
  float gStormField;
  float gCorridorMask;
  float gRegionalIdentity;   // stable basin bias (±~0.08)
  float gContinentalFactor;  // + = continental (dry), - = oceanic (wet)
  float gCalmMask;           // subtropical + continental calm suppression
  // Phase 8A — new globals for land/ocean anchoring + altitude regimes.
  float gOceanicness;        // 0 = land interior, 1 = deep ocean
  float gWetDryBias;         // signed (+ wet / - dry) bias added to coverage
  float gAdvectionSpeed;     // local eastward drift rate (radians / second)
  float gLowCloudWeight;     // 0..1 weight for the low dense regime
  float gHighCloudWeight;    // 0..1 weight for the high thin regime
  // Phase 8B — new globals.
  float gMidCloudWeight;     // 0..1 weight for the mid altostratus regime
  float gAnvilBoost;         // >0 where storm anvils extend upward
  float gClimConvection;     // sampled R channel (convective likelihood)
  float gClimCover;          // sampled G channel (mean cloud cover)
  float gClimITCZ;           // sampled B channel (itcz proxy)
  float gClimCorridor;       // sampled A channel (storm corridor)

  /* ── Noise ────────────────────────────────────────────────────── */

  float hash3(vec3 p) {
    p = fract(p * vec3(443.897, 397.297, 491.187));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }

  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash3(i),               hash3(i + vec3(1,0,0)), f.x),
          mix(hash3(i + vec3(0,1,0)),  hash3(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash3(i + vec3(0,0,1)),  hash3(i + vec3(1,0,1)), f.x),
          mix(hash3(i + vec3(0,1,1)),  hash3(i + vec3(1,1,1)), f.x), f.y),
      f.z
    );
  }

  float fbm2(vec3 p) {
    return vnoise(p) * 0.625 + vnoise(p * 2.03) * 0.375;
  }

  /* ── Geometry ─────────────────────────────────────────────────── */

  vec2 raySphere(vec3 ro, vec3 rd, float r) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - r * r;
    float d = b * b - c;
    if (d < 0.0) return vec2(-1.0);
    d = sqrt(d);
    return vec2(-b - d, -b + d);
  }

  vec2 sphericalUv(vec3 n) {
    float lon = atan(-n.z, n.x);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    return vec2(fract(lon / (2.0 * PI) + 0.5), lat / PI + 0.5);
  }

  /* ── Phase 8A: land/ocean mask ─────────────────────────────────
     The specular texture doubles as the ocean mask. r-channel:
     bright = water, dark = land. We smooth the transition so the
     coastal band is a gentle gradient (no banding at the shore). */
  float sampleOceanicness(vec3 n) {
    vec2 uv = sphericalUv(n);
    float water = texture2D(uLandMask, uv).r;
    return smoothstep(0.10, 0.72, water);
  }

  /* ── Phase 8A / 8B: zonal advection with sign flip per regime ────
     Real atmosphere: tropical trade winds blow westward (easterlies),
     mid-latitude westerlies blow eastward, polar easterlies blow
     westward again. We return a signed rate so the rotation direction
     flips by latitude band. Magnitudes peak in the mid-lat jets and
     in the trade band; go quiet at the horse latitudes. */
  float advectionRate(float lat) {
    float absLat = abs(lat);
    float tradeBand  = smoothstep(0.02, 0.26, absLat)
                     * (1.0 - smoothstep(0.34, 0.52, absLat));
    float midBand    = smoothstep(0.55, 0.85, absLat)
                     * (1.0 - smoothstep(1.05, 1.38, absLat));
    float polarBand  = smoothstep(1.18, 1.42, absLat);
    // Eastward = positive, westward = negative.
    return (midBand * 0.95) - (tradeBand * 0.55) - (polarBand * 0.35);
  }

  /* ── Phase 7.9F: regional persistent identity ───────────────────
     Stable low-frequency spherical noise (no time term). */
  float regionalIdentitySample(vec3 n) {
    vec3 s1 = n * 0.90 + vec3(7.3, 11.1, 3.7);
    vec3 s2 = n * 1.55 + vec3(17.7, 5.3, 9.1);
    return (vnoise(s1) * 0.65 + vnoise(s2) * 0.35 - 0.5);
  }

  /* ── Phase 7.9F: continental geography (deterministic) ────────── */
  float continentalGeography(float lon, float hem, float absLat) {
    float p1 = mix(-1.3, 0.8, step(0.0, hem));
    float p2 = mix(0.7, 2.1, step(0.0, hem));
    float p3 = mix(2.5, -1.6, step(0.0, hem));
    float g1 = sin(lon * 1.00 + p1);
    float g2 = sin(lon * 2.30 + p2);
    float g3 = sin(lon * 4.10 + p3);
    float geo = g1 * 0.55 + g2 * 0.30 + g3 * 0.15;
    geo += hem * 0.10 * smoothstep(0.22, 0.55, absLat);
    return geo;
  }

  /* ── Phase 8A: eastward rotation around polar axis ──────────────
     Rotates a direction vector in the xz-plane. Used to "look back
     in time" at storm fields so the pattern appears to drift east. */
  vec3 rotateEastward(vec3 n, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec3(
      n.x * c - n.z * s,
      n.y,
      n.x * s + n.z * c
    );
  }

  void setupWeatherContext(vec3 n) {
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float absLat = abs(lat);
    float lon = atan(-n.z, n.x);
    float hem = sign(n.y + 0.001);

    // ── Phase 8A: land/ocean sample (one texture read) ──
    float oceanicness = sampleOceanicness(n);
    gOceanicness = oceanicness;

    // ── Phase 8B: climatology sample (one texture read) ──
    vec2 climUv = sphericalUv(n);
    vec4 clim = texture2D(uClimatology, climUv);
    gClimConvection = clim.r;
    gClimCover = clim.g;
    gClimITCZ = clim.b;
    gClimCorridor = clim.a;

    // ── Coriolis rotation ──
    float coriolis = sign(n.y) * smoothstep(0.08, 0.42, abs(n.y));
    float ca = cos(coriolis * 0.85);
    float sa = sin(coriolis * 0.85);

    // ── Two-level domain warp ──
    vec3 ws1 = n * 1.8 + vec3(uTime * 0.00035, 0.0, uTime * 0.00025);
    vec3 w1 = vec3(
      vnoise(ws1) - 0.5,
      0.0,
      vnoise(ws1 + vec3(31.7, 17.3, 23.1)) - 0.5
    );
    w1.xz = vec2(ca * w1.x - sa * w1.z, sa * w1.x + ca * w1.z);

    vec3 warpedN = normalize(n + w1 * 0.16);
    vec3 ws2 = warpedN * 3.2 + vec3(uTime * 0.00055, 0.0, uTime * 0.00040);
    vec3 w2 = vec3(
      vnoise(ws2) - 0.5,
      0.0,
      vnoise(ws2 + vec3(23.1, 31.7, 17.3)) - 0.5
    );
    w2.xz = vec2(ca * w2.x - sa * w2.z, sa * w2.x + ca * w2.z);

    // ── Regime activity envelopes ──
    float midLatActivity = exp(-pow(absLat - 0.82, 2.0) / 0.040);
    float tropicalSteady = exp(-absLat * absLat / 0.028);

    // ── Phase 7.9F: multi-frequency continental geography ──
    float continentalFactor = continentalGeography(lon, hem, absLat);
    float g1Axis = sin(lon * 1.00 + mix(-1.3, 0.8, step(0.0, hem)));

    float continentalDry = max(continentalFactor, 0.0)
                         * smoothstep(0.12, 0.48, absLat)
                         * (1.0 - smoothstep(0.90, 1.20, absLat))
                         * 0.06;

    float oceanicWet = max(-continentalFactor, 0.0) * midLatActivity * 0.09;

    // ── Phase 7.9F: stable regional identity ──
    float regional = regionalIdentitySample(n);
    float regionalIdentity = regional * 0.16;

    // ── Phase 8A: land/ocean-anchored wet/dry bias ──
    // Ocean = wet lift (+), land interior = dry floor (-). The strength
    // is modulated by uLandMaskStrength so the effect can be dialed off
    // entirely for debug. Coastal pixels fall smoothly between the two
    // thanks to the smoothstep in sampleOceanicness.
    //
    // The wet bias peaks in the tropical-to-midlat band where oceans
    // actually drive deep convection. Dry bias peaks in the subtropical
    // continental interiors (Sahara, Arabian, Central Asia, Outback).
    float oceanWetLift = oceanicness
                       * (0.035 + midLatActivity * 0.065 + tropicalSteady * 0.030);
    float landDryDip   = (1.0 - oceanicness)
                       * smoothstep(0.12, 0.55, absLat)
                       * (1.0 - smoothstep(1.05, 1.30, absLat))
                       * 0.065;
    float wetDryBias = (oceanWetLift - landDryDip) * uLandMaskStrength;
    gWetDryBias = wetDryBias;

    // ── Climate zones ──
    float itczBase = exp(-absLat * absLat / 0.020);
    float itczLonMask = 0.55
                     + 0.30 * sin(lon * 3.0 + 0.4)
                     + 0.15 * sin(lon * 1.0 - 1.2);
    itczLonMask = clamp(itczLonMask, 0.25, 1.05);
    // Phase 8A: ITCZ prefers the ocean-warm-pool side (e.g. maritime
    // continent, Amazon basin rainfall is fed by Atlantic moisture).
    float itczOceanBoost = mix(0.85, 1.15, oceanicness);
    float itcz = itczBase * 0.22 * itczLonMask * itczOceanBoost;

    // Mid-latitude storm tracks — already boosted in oceanic corridors
    // via oceanicWet. Phase 8A adds an explicit land-mask boost for the
    // North Atlantic / North Pacific storm bands.
    float midStorm = exp(-pow(absLat - 0.82, 2.0) / 0.030) * 0.22
                   + oceanicWet
                   + midLatActivity * oceanicness * 0.04;

    // Subtropical calm (horse latitudes) — reinforced on continents.
    float subtropCalmEnvelope = exp(-pow(absLat - 0.44, 2.0) / 0.022);
    float easternBasinDry = max(-g1Axis, 0.0) * subtropCalmEnvelope * 0.05;
    float subtropCalm = subtropCalmEnvelope * 0.10 + continentalDry + easternBasinDry;

    // Polar front: stronger in SH (unbroken Southern Ocean).
    float polarFront = exp(-pow(absLat - 1.10, 2.0) / 0.045) * 0.14
                     * (1.0 + step(-0.1, -n.y) * 0.35);

    // Phase 8B — sampled climatology nudges the analytic bias toward
    // the baked Earth backbone. Effect is small (additive ~±0.06) so
    // the hand-tuned structure still dominates, but a sampled ITCZ /
    // convection / cover map eliminates the "same heuristic everywhere"
    // character.
    float climBias = (gClimCover - 0.45) * 0.08
                   + (gClimITCZ  - 0.05) * 0.12
                   + (gClimConvection - 0.30) * 0.06;
    gClimateBias = (itcz + midStorm + polarFront - subtropCalm
                  + regionalIdentity + wetDryBias
                  + climBias * uClimatologyStrength)
                 * uClimateStrength;
    gRegionalIdentity = regionalIdentity;
    gContinentalFactor = continentalFactor;
    gCalmMask = subtropCalm;

    // ── Phase 8A / 8B: latitude-dependent signed zonal advection ──
    // Mid-lat westerlies (+), tropical easterlies (-), polar easterlies (-).
    // The sample point is rotated "back" by the advection angle so the
    // underlying noise field appears to drift in the correct direction
    // for each latitude band.
    float advectSignedRate = advectionRate(lat) * uStormAdvection;
    gAdvectionSpeed = advectSignedRate;
    float advectAngle = uTime * 0.00018 * advectSignedRate;
    vec3 advectedN = rotateEastward(n, -advectAngle);

    // ── Storm systems (Phase 7.9F anisotropy + 8A advection) ──
    // Phase 8A moves the time offset from a noise-space translation
    // into an actual world-space eastward rotation of the sample point.
    // Pattern persistence improves because the noise field itself is
    // static — only the sample point moves.
    vec3 stormPos = normalize(advectedN + w1 * 0.12);
    vec3 stormSeed = vec3(stormPos.x * 3.6, stormPos.y * 1.8, stormPos.z * 3.6);
    float stormNoise = vnoise(stormSeed) * 0.60
                     + vnoise(stormSeed * vec3(2.1, 1.4, 2.1)
                              + vec3(11.3, 7.7, 19.1)) * 0.40;

    // Oceans should trigger stormy noise more readily than continents.
    float oceanStormBias = (oceanicness - 0.5) * 0.05 * uLandMaskStrength;
    float stormThresholdLo = 0.44 - regionalIdentity * 1.2 - oceanStormBias;
    float stormThresholdHi = 0.68 - regionalIdentity * 1.2 - oceanStormBias;
    float rawStorm = smoothstep(stormThresholdLo, stormThresholdHi, stormNoise);

    // Corridor mask: storms concentrate in weather-active zones.
    // Phase 8B — blended with the sampled corridor climatology so the
    // storm tracks match real Earth geography rather than the analytic
    // hump alone.
    float corridorMask = midLatActivity * 0.70
                       + oceanicWet * 2.8
                       + oceanicness * midLatActivity * 0.25
                       + step(-0.1, -n.y) * smoothstep(0.65, 0.90, absLat) * 0.40;
    corridorMask = mix(corridorMask,
                       max(corridorMask, gClimCorridor * 0.9),
                       uClimatologyStrength * 0.6);
    corridorMask = clamp(corridorMask, 0.20, 1.0);
    gCorridorMask = corridorMask;

    float stormLatMod = smoothstep(0.10, 0.32, absLat)
                      * (1.0 - smoothstep(1.20, 1.45, absLat));
    gStormField = rawStorm * stormLatMod * corridorMask * uStormIntensity;

    // ── Phase 7.9F: activity-gated swirl ──
    float activityGate = clamp(
      midLatActivity * 0.55 + corridorMask * 0.40 + rawStorm * 0.35,
      0.18, 1.0
    );
    float swirlMod = mix(0.45, 1.0, midLatActivity) * (1.0 - tropicalSteady * 0.35);
    gSwirlWarp = (w1 * 0.075 + w2 * 0.045) * uSwirlStrength * swirlMod * activityGate;

    // ── Phase 8B: three-band altitude regime weights ──
    // Low  — stratocumulus, cumulus, frontal cloud shields (dense).
    // Mid  — altostratus / warm-front shields (moderate, wide).
    // High — cirrus veil, subtropical jet exit, polar sheets (thin, wispy).
    // Anvil boost lifts the high band sharply under strong storm cores,
    // producing the overshooting-top silhouette without adding noise.
    float lowWeight  = clamp(0.55
                       + gStormField * 0.42
                       + oceanWetLift * 3.0
                       + itcz * 1.6
                       - subtropCalm * 1.2, 0.20, 1.05);

    float midWeight  = clamp(0.30
                       + midStorm * 0.70
                       + itcz * 0.55
                       + gStormField * 0.18
                       - subtropCalm * 0.80, 0.10, 0.85);

    float highWeight = clamp(0.42
                       + subtropCalmEnvelope * 0.22
                       + smoothstep(0.55, 1.10, absLat) * 0.24
                       + gClimConvection * 0.18 * uClimatologyStrength
                       - gStormField * 0.15, 0.18, 0.95);

    // Anvil top: strong storm cells push a narrow plume into the upper
    // band. gAnvilBoost is used by altitudeProfile to extend the high
    // gaussian when a storm core is underneath it.
    float anvil = smoothstep(0.55, 0.90, gStormField) * uAnvilStrength;
    gAnvilBoost = anvil;

    gLowCloudWeight  = mix(1.0, lowWeight,  uAltitudeBlend);
    gMidCloudWeight  = mix(0.0, midWeight,  uAltitudeBlend);
    gHighCloudWeight = mix(0.0, highWeight + anvil * 0.35, uAltitudeBlend);
  }

  /* ── Cloud density ────────────────────────────────────────────── */

  float coverageSample(vec3 pos) {
    vec3 n = normalize(pos);
    vec3 warpedN = normalize(n + gSwirlWarp);
    vec2 uv = sphericalUv(warpedN);
    uv.x = fract(uv.x + uCloudOffset);
    float texCov = texture2D(uCloudMap, uv).a;
    float enhanced = texCov + gClimateBias;
    float weatherFloor = texCov * 0.35;
    return clamp(max(max(enhanced, gStormField), weatherFloor), 0.0, 1.0);
  }

  /* ── Phase 8A: altitude-aware height profile ────────────────────
     Two gaussians in normalized shell height:
       low  — peaked at h=0.30, broad, dense
       high — peaked at h=0.76, narrow, thin
     The per-fragment regime weights (gLowCloudWeight, gHighCloudWeight)
     control how much each layer contributes. The sum stays bounded so
     overall opacity does not blow out over storm corridors. */
  float altitudeProfile(float h) {
    // Phase 8B — three-band profile with anvil-extended high band.
    float lowBand  = exp(-pow(h - 0.22, 2.0) / 0.060);
    float midBand  = exp(-pow(h - 0.52, 2.0) / 0.040) * 0.72;
    // The high band's peak rises with the anvil boost so storm cores
    // visibly loft cirrus into the top of the shell.
    float highPeak = 0.78 + gAnvilBoost * 0.08;
    float highSpread = 0.022 + gAnvilBoost * 0.012;
    float highBand = exp(-pow(h - highPeak, 2.0) / highSpread) * 0.55;
    return clamp(lowBand  * gLowCloudWeight
               + midBand  * gMidCloudWeight
               + highBand * gHighCloudWeight, 0.0, 1.3);
  }

  float densityCoarse(vec3 pos) {
    float r  = length(pos);
    float h  = clamp((r - uInnerRadius) / (uOuterRadius - uInnerRadius), 0.0, 1.0);
    return coverageSample(pos) * altitudeProfile(h);
  }

  float densityFull(vec3 pos) {
    float coarse = densityCoarse(pos);
    if (coarse < 0.03) return 0.0;

    float r = length(pos);
    float h = clamp((r - uInnerRadius) / (uOuterRadius - uInnerRadius), 0.0, 1.0);

    vec3 n  = normalize(pos);
    vec3 nc = n * 8.0 + vec3(uTime * 0.004, 0.0, uTime * 0.002);

    // Phase 10B Part 3 — LOD detail weight. uLODBias = 0 at near range
    // (full micro-structure: erosion, detail noise, cirrus streaks), 1 at
    // wide orbital framing (only the macro coarse density remains). The
    // blend preserves the cloud *character* — the same coverage map still
    // drives the shape — but strips away the expensive per-step noise
    // taps that would otherwise run at every step for every screen pixel
    // just to produce sub-pixel wisps nobody can see from orbit.
    float detailGate = 1.0 - clamp(uLODBias, 0.0, 1.0);

    float noise   = fbm2(nc);
    float erosion = noise * 0.34 * detailGate;
    float density = smoothstep(0.05 + erosion * 0.34, 0.50 + erosion * 0.12, coarse);

    // Phase 8A/8B — altitude-aware erosion + cirrus shear.
    // High band gets anisotropic east-west stretched noise so cirrus
    // reads as wind-sheared streaks rather than isotropic wisps.
    float highBand = smoothstep(0.55, 0.95, h);
    float midBand  = smoothstep(0.35, 0.60, h) * (1.0 - highBand);
    // Phase 10B — skip the detail noise tap entirely when LOD is maxed.
    // Saves one vnoise call per density sample at wide framing.
    float detail = 0.0;
    float streak = 0.0;
    if (detailGate > 0.01) {
      detail = vnoise(nc * 4.2) * mix(0.08, 0.16, highBand) * detailGate;
      // Anisotropic cirrus: stretched along east-west (longitude) axis.
      // Only pay the two vnoise taps for shear when detail is meaningful.
      if (uCirrusStreakStrength > 0.02 && highBand > 0.05) {
        vec3 shearPos = vec3(nc.x * 0.35, nc.y * 3.2, nc.z * 0.35)
                      + vec3(uTime * 0.0015, 0.0, uTime * 0.0011);
        float cirrusShear = (vnoise(shearPos) * 0.65 + vnoise(shearPos * 2.07) * 0.35);
        streak = (cirrusShear - 0.5) * uCirrusStreakStrength
               * highBand * 0.22 * detailGate;
      }
    }
    density = max(density - detail * (1.0 - h * 0.4) + streak, 0.0);
    // Mid band stays smoother (altostratus = sheet, not streak).
    density = mix(density, density * 1.04, midBand * 0.15);

    // Phase 9A — storm-mass boost. In regions where the storm field
    // is active, push the cloud mass up to ~1.32× so major systems
    // read with more body instead of as thin coverage painted over
    // the shell. Bounded so non-storm regions are unaffected.
    float stormMassBoost = 1.0 + gStormField * uStormMassBoost * 0.32;
    density *= stormMassBoost;

    return density * uDensityScale;
  }

  /* ── Phase 9B: Earth occlusion on the light path ───────────────
     Analytic ray-sphere perpendicular-distance test. Instead of
     marching toward the sun and sampling density along the way, we
     check whether a straight line from the cloud sample to the sun
     clears the solid Earth. If the closest approach of that line to
     the origin is less than the earth radius, the sample is in the
     planet's shadow. A smoothstep across the inner radius creates a
     gentle terminator curve so twilight samples keep a warm edge
     rather than clipping black. Returns 1.0 = fully lit, 0.0 = in
     Earth's shadow. One analytic op per sample; no marching. */
  float earthLightClear(vec3 sp, vec3 sd) {
    float b = dot(sp, sd);
    if (b >= 0.0) return 1.0; // sun is on the cloud's side
    float t = -b;
    vec3 closest = sp + sd * t;
    float r = length(closest);
    return smoothstep(uInnerRadius - 0.006, uInnerRadius + 0.018, r);
  }

  /* ── Light march (coarse only) ────────────────────────────────── */

  float lightMarch(vec3 pos) {
    vec3  sd    = normalize(uSunDirection);
    float thick = (uOuterRadius - uInnerRadius) * 1.6;
    float step  = thick / float(LIGHT_STEPS);
    float acc   = 0.0;

    for (int i = 0; i < LIGHT_STEPS; i++) {
      pos += sd * step;
      float r = length(pos);
      if (r > uOuterRadius || r < uInnerRadius) break;
      acc += densityCoarse(pos) * step;
    }

    float extinction = exp(-acc * uAbsorption * 2.8);
    return max(extinction, 0.03);
  }

  /* ── Henyey-Greenstein phase function ──────────────────────────── */

  float hgPhase(float mu, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
  }

  /* ── Main ──────────────────────────────────────────────────────── */

  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorldPosition - ro);

    vec2 outerHit = raySphere(ro, rd, uOuterRadius);
    vec2 innerHit = raySphere(ro, rd, uInnerRadius);
    if (outerHit.x < 0.0) discard;

    float tStart  = max(outerHit.x, 0.0);
    float tEnd    = innerHit.x > 0.0 ? innerHit.x : outerHit.y;
    float pathLen = tEnd - tStart;
    if (pathLen < 0.0001) discard;

    // ── Weather context (once per fragment) ─────────────────────
    vec3 midNorm = normalize(ro + rd * (tStart + pathLen * 0.5));
    setupWeatherContext(midNorm);

    // ── Early rejection ─────────────────────────────────────────
    vec3 probe1 = ro + rd * (tStart + pathLen * 0.33);
    vec3 probe2 = ro + rd * (tStart + pathLen * 0.67);
    if (max(coverageSample(probe1), coverageSample(probe2)) < 0.03) discard;

    // ── Raymarch setup ──────────────────────────────────────────
    // Phase 10B Part 2 — adaptive step count. uCloudStepCount is a runtime
    // cutoff computed from camera distance to the shell; the for loop still
    // bounds at MAX_CLOUD_STEPS (compile-time) but breaks early once the
    // runtime budget is spent. stepLen also uses the runtime count so each
    // step marches the same segment of the shell regardless of tier.
    int stepCount = uCloudStepCount < 4 ? 4 :
                    (uCloudStepCount > MAX_CLOUD_STEPS ? MAX_CLOUD_STEPS : uCloudStepCount);
    float stepLen = pathLen / float(stepCount);
    // Phase 9B Part 6 — temporal jitter. Add a golden-ratio-rotated
    // per-frame offset to the stable screen-space dither so successive
    // frames sample *different* sub-step positions; eye integrates them
    // into a smoother result. Paired with Phase 10B's history blend this
    // becomes a full TAA instead of an eye-integration trick.
    float frameJitter = fract(uFrameIndex * 0.61803398875);
    float dither = fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)) + frameJitter);
    float t      = tStart + stepLen * dither;

    vec3  sd    = normalize(uSunDirection);
    float mu    = dot(rd, sd);
    // Phase 9A — band-specific phase blend. Low (stratocumulus) gets a
    // moderate forward lobe and noticeable backscatter body. Mid
    // (altostratus) stays balanced. High (cirrus) is sharply
    // forward-scattering so sun-side cirrus lights up while shadow-side
    // cirrus stays dim — the signature ISS-photo look.
    float phaseLow  = mix(hgPhase(mu, 0.10), hgPhase(mu, uLowPhaseG),  0.44);
    float phaseMid  = mix(hgPhase(mu, 0.18), hgPhase(mu, 0.72),         0.48);
    float phaseHigh = mix(hgPhase(mu, 0.35), hgPhase(mu, uHighPhaseG), 0.62);

    vec3  totalColor    = vec3(0.0);
    float transmittance = 1.0;

    // ── Raymarch loop ───────────────────────────────────────────
    for (int i = 0; i < MAX_CLOUD_STEPS; i++) {
      if (i >= stepCount) break;
      if (transmittance < 0.01) break;

      vec3  sp = ro + rd * t;
      float d  = densityFull(sp);

      if (d > 0.001) {
        vec3  norm  = normalize(sp);
        float NdotL = dot(norm, sd);
        float day        = smoothstep(-0.15, 0.30, NdotL);
        float twi        = smoothstep(-0.22, 0.05, NdotL)
                          * (1.0 - smoothstep(0.05, 0.22, NdotL));
        float night      = 1.0 - smoothstep(-0.32, -0.10, NdotL);
        float dusk       = smoothstep(-0.38, 0.10, NdotL)
                          * (1.0 - smoothstep(0.10, 0.50, NdotL));

        // Phase 9A — per-sample altitude band weights. h in [0..1]
        // along the shell drives a three-way low/mid/high partition.
        float rSample = length(sp);
        float hSample = clamp((rSample - uInnerRadius) / (uOuterRadius - uInnerRadius), 0.0, 1.0);
        float lowBand  = 1.0 - smoothstep(0.18, 0.42, hSample);
        float highBand = smoothstep(0.58, 0.88, hSample);
        float midBand  = max(1.0 - lowBand - highBand, 0.0);
        float phaseSample = phaseLow * lowBand + phaseMid * midBand + phaseHigh * highBand;

        float sunVisRaw  = lightMarch(sp);
        float sunVisFloor = mix(0.03, 0.14, dusk);
        float sunVis     = max(sunVisRaw, sunVisFloor);
        // Phase 9B Part 1 — Earth shadow on clouds. Ray-test whether the
        // sun-path from this sample clears the solid Earth. Clouds on
        // the night side lose direct sun (keeping only ambient + wrap +
        // transmitted), which gives the clean terminator arc you see
        // from orbit instead of clouds glowing on the night hemisphere.
        float earthClear = mix(1.0, earthLightClear(sp, sd), uEarthShadowStrength);
        sunVis *= earthClear;
        // Phase 9A — cirrus absorbs less. pow(x, k<1) raises x, so the
        // high band receives more direct light and casts softer
        // shadows on itself. Matches the luminous edge on real cirrus.
        float sunVisBand = pow(sunVis, mix(1.0, 0.55, highBand));
        vec3  sunCol     = vec3(1.0, 0.97, 0.92);
        vec3  direct     = sunCol * sunVisBand * phaseSample;

        float wrapN       = clamp((NdotL + 0.35) / 1.35, 0.0, 1.0);
        vec3  wrapLight   = sunCol * wrapN * uWrapLight
                            * (1.0 - night * 0.85);

        float transmitMask = clamp(mu, 0.0, 1.0) * exp(-d * stepLen * uAbsorption * 0.5);
        vec3  transmitted  = uAtmosphereTwilightTint * transmitMask
                            * uTransmittedLight * dusk;

        vec3  twilightLift = uAtmosphereTwilightTint * dusk * uTwilightLift;

        vec3 ambient = uAtmosphereRayleighTint * 0.30 * day
                     + uAtmosphereTwilightTint * twi * 0.24;
        // Phase 9B Part 2 — sky-driven cloud ambient. The fixed
        // Rayleigh/Twilight tint approximates a clear-sky integrator;
        // if the sky-capture RT is bound it *is* today's sky (atmosphere
        // + atmosphere-lit clouds under this sample). Sample at the
        // outward normal — that's the hemisphere of sky this cloud face
        // actually sees — and blend over the analytic ambient.
        if (uUseSkyMap > 0.5) {
          vec2 skyUv = sphericalUv(norm);
          vec3 capturedSky = texture2D(uSkyMap, skyUv).rgb * 2.2;
          vec3 skyAmbient = capturedSky * 0.38;
          ambient = mix(ambient, skyAmbient,
                        uSkyAmbientStrength * (1.0 - night));
        }

        vec3 shadowTint = uAtmosphereRayleighTint * uShadowTint
                          * (1.0 - sunVis) * day;

        float powder = 1.0 - exp(-d * stepLen * uAbsorption * 2.0);
        vec3  ms     = sunCol * powder * 0.12 * day;

        vec3 sc = direct + wrapLight + transmitted + twilightLift
               + ambient + shadowTint + ms;

        sc = mix(sc, sc * uAtmosphereTwilightTint * 1.14, twi * 0.32);
        sc = mix(sc, sc * uAtmosphereRayleighTint * 1.04, (1.0 - day) * 0.06);
        sc *= mix(uNightFloor, 1.0, 1.0 - night);

        // Phase 9A — cloud-top mass readability. smoothstep across the
        // shell height lifts the top samples and darkens the base, so
        // storm bodies visibly read as three-dimensional blocks rather
        // than flat coverage painted on the shell. Bounded range (0.72
        // .. 1.10) keeps non-storm clouds from flickering.
        float topShadow = mix(0.72, 1.10, smoothstep(0.05, 0.55, hSample));
        sc *= mix(1.0, topShadow, uCloudTopShadow);

        float NdotV    = max(dot(norm, -rd), 0.0);
        float limb     = pow(1.0 - NdotV, 2.4);
        // Phase 9A — softer limb. Original 0.28/0.32 mixes produced a
        // neon-bloom shell; scaling by uLimbSoftness (default 0.65)
        // halves the tint so the limb reads photographic, not graphic.
        vec3  limbDayTint   = mix(sc, sc * uAtmosphereRayleighTint * 1.08,
                                  day  * limb * 0.28 * uLimbSoftness);
        vec3  limbTwiTint   = mix(limbDayTint, limbDayTint * uAtmosphereTwilightTint * 1.12,
                                  dusk * limb * 0.32 * uLimbSoftness);
        sc = limbTwiTint;

        // Phase 10A — spectral aerial perspective. Replaces the 8B luma-
        // squash with per-channel exponential extinction. The aerial beta
        // follows roughly 1/λ^4 proportions (blue survives longest) so
        // distant clouds cool and desaturate toward the Rayleigh tint
        // without collapsing chroma. Day/dusk gating preserves clean
        // night limbs and keeps black space untouched.
        float camDist = length(sp - ro);
        float airMass = clamp((camDist - 1.02) / 1.1, 0.0, 1.0)
                      * uAerialPerspective
                      * (day * 0.85 + dusk * 0.45);
        vec3 aerialBeta = vec3(0.10, 0.28, 0.82);
        vec3 aerialTr = exp(-aerialBeta * airMass * 1.8);
        vec3 aerialScatter = uAtmosphereRayleighTint * airMass * 0.32 * (day * 0.8 + dusk * 0.45);
        aerialScatter = mix(aerialScatter, uAtmosphereTwilightTint * airMass * 0.34, dusk * 0.55);
        sc = sc * aerialTr + aerialScatter;

        // Debug isolation modes
        if (uCloudDebugMode == 1) sc = direct;
        else if (uCloudDebugMode == 2) sc = wrapLight;
        else if (uCloudDebugMode == 3) sc = transmitted;
        else if (uCloudDebugMode == 4) sc = twilightLift;
        else if (uCloudDebugMode == 5) sc = shadowTint;
        else if (uCloudDebugMode == 6) sc = ambient + ms;
        // Phase 7.9A — weather structure debug modes
        else if (uCloudDebugMode == 7) sc = vec3(coverageSample(sp));
        else if (uCloudDebugMode == 8) sc = vec3(length(gSwirlWarp) * 6.0, abs(gSwirlWarp.x) * 4.0, abs(gSwirlWarp.z) * 4.0);
        else if (uCloudDebugMode == 9) sc = vec3(gStormField, gStormField * 0.6, 0.0);
        else if (uCloudDebugMode == 10) sc = vec3(max(gClimateBias, 0.0) * 3.0, 0.0, max(-gClimateBias, 0.0) * 3.0);
        else if (uCloudDebugMode == 11) sc = vec3(d / uDensityScale);
        else if (uCloudDebugMode == 12) sc = vec3(gCorridorMask, gCorridorMask * 0.5, 0.0);
        else if (uCloudDebugMode == 13) sc = vec3(max(gClimateBias, 0.0) * 3.0, gCorridorMask, max(-gClimateBias, 0.0) * 3.0);
        // Phase 7.9F — regional identity, ocean/continent, calm mask
        else if (uCloudDebugMode == 14) sc = vec3(max(gRegionalIdentity, 0.0) * 8.0, 0.0, max(-gRegionalIdentity, 0.0) * 8.0);
        else if (uCloudDebugMode == 15) sc = vec3(max(gContinentalFactor, 0.0), 0.0, max(-gContinentalFactor, 0.0));
        else if (uCloudDebugMode == 16) sc = vec3(gCalmMask * 5.0, gCalmMask * 3.0, 0.0);
        // Phase 8A — earth-anchored weather debug modes
        else if (uCloudDebugMode == 17) sc = vec3(gOceanicness * 0.15, gOceanicness * 0.35, gOceanicness);
        else if (uCloudDebugMode == 18) sc = vec3(max(-gWetDryBias, 0.0) * 10.0, 0.0, max(gWetDryBias, 0.0) * 10.0);
        else if (uCloudDebugMode == 19) sc = vec3(gAdvectionSpeed * 0.6, gAdvectionSpeed * 0.3, 0.0);
        else if (uCloudDebugMode == 20) sc = vec3(gLowCloudWeight, 0.0, gHighCloudWeight);

        float sa = 1.0 - exp(-d * stepLen * uAbsorption);
        float limbFade = 1.0 - limb * night * 0.55;
        totalColor    += transmittance * sa * sc * limbFade;
        transmittance *= 1.0 - sa * limbFade;
      }

      t += stepLen;
    }

    float alpha = 1.0 - transmittance;
    if (alpha < 0.003) discard;

    // Phase 10B Part 1 — temporal reprojection blend.
    // Reproject the current cloud-shell midpoint into the previous
    // frame's screen space, sample the history framebuffer, and blend
    // conservatively against the current radiance. Rejection gates:
    //   - history must be ready (first frame / post-resize skips)
    //   - reprojected UV must lie inside [0..1] with a small edge margin
    //   - the reprojected pixel must be close to the current pixel
    //     (screen-space motion rejection — prevents smearing during
    //     camera slews and orbit moves)
    //   - current cloud alpha must be non-trivial so we only blend
    //     history where the scene pixel is dominated by cloud (otherwise
    //     the earth surface under thin clouds smears instead of the
    //     cloud itself)
    // The history texture holds the prior composited frame (Earth +
    // atmosphere + clouds), so we un-premultiply the current cloud
    // radiance, blend against history RGB, and re-apply alpha. This
    // keeps the cloud silhouette crisp while averaging out step-crawl
    // and noise shimmer across frames.
    if (uTaaEnabled > 0.5 && uHistoryReady > 0.5 && alpha > 0.12) {
      vec3 midWorld = ro + rd * (tStart + pathLen * 0.5);
      vec4 prevClip = uPrevViewProjection * vec4(midWorld, 1.0);
      if (prevClip.w > 0.0001) {
        vec3 prevNdc = prevClip.xyz / prevClip.w;
        vec2 prevUv = prevNdc.xy * 0.5 + 0.5;
        vec2 edgeDist = min(prevUv, vec2(1.0) - prevUv);
        float edgeGate = smoothstep(0.005, 0.040, min(edgeDist.x, edgeDist.y));
        vec2 curUv = gl_FragCoord.xy * uHistoryInvResolution;
        vec2 motion = prevUv - curUv;
        float motionMag = length(motion);
        float motionGate = 1.0 - smoothstep(0.006, 0.040, motionMag);
        float alphaGate = smoothstep(0.12, 0.45, alpha);
        float blendWeight = clamp(uTaaBlend * motionGate * alphaGate * edgeGate, 0.0, 0.92);
        if (blendWeight > 0.005) {
          vec3 histRgb = texture2D(uHistoryTex, prevUv).rgb;
          vec3 curRgb = totalColor / max(alpha, 0.001);
          vec3 blendedRgb = mix(curRgb, histRgb, blendWeight);
          totalColor = blendedRgb * alpha;
        }
      }
    }

    gl_FragColor = vec4(totalColor, alpha);
  }
`;

/* ------------------------------------------------------------------ */
/*  Uniform factory                                                    */
/* ------------------------------------------------------------------ */

export type CloudDebugMode =
  | "full"
  | "direct"
  | "wrap"
  | "transmitted"
  | "twilight-lift"
  | "shadow-tint"
  | "ambient"
  | "macro-coverage"
  | "swirl-field"
  | "storm-mask"
  | "climate-zones"
  | "density-only"
  | "storm-corridor"
  | "weather-regimes"
  | "regional-identity"
  | "ocean-continent"
  | "calm-mask"
  | "land-mask"
  | "wet-dry-bias"
  | "storm-advection"
  | "altitude-layers";

export function encodeCloudDebugMode(mode: CloudDebugMode): number {
  switch (mode) {
    case "direct":            return 1;
    case "wrap":              return 2;
    case "transmitted":       return 3;
    case "twilight-lift":     return 4;
    case "shadow-tint":       return 5;
    case "ambient":           return 6;
    case "macro-coverage":    return 7;
    case "swirl-field":       return 8;
    case "storm-mask":        return 9;
    case "climate-zones":     return 10;
    case "density-only":      return 11;
    case "storm-corridor":    return 12;
    case "weather-regimes":   return 13;
    case "regional-identity": return 14;
    case "ocean-continent":   return 15;
    case "calm-mask":         return 16;
    case "land-mask":         return 17;
    case "wet-dry-bias":      return 18;
    case "storm-advection":   return 19;
    case "altitude-layers":   return 20;
    default:                  return 0;
  }
}

export interface VolumetricCloudUniformParams {
  cloudTexture: Texture;
  /**
   * Phase 8A — real Earth land/ocean mask. The r-channel is sampled as
   * an ocean mask (bright = water, dark = land). The project already
   * loads a specular texture with that encoding, so pass it here to
   * anchor the weather system to real geography.
   */
  landMaskTexture: Texture;
  /**
   * Phase 8B — baked climatology texture. RGBA encodes:
   *   R — convective likelihood (warm-pool / tropical)
   *   G — mean cloud cover
   *   B — ITCZ latitude proxy
   *   A — storm corridor preference
   * Build with createClimatologyTexture() once at startup.
   */
  climatologyTexture: Texture;
  sunDirection?: Vector3;
  twilightLift?: number;
  wrapLight?: number;
  transmittedLight?: number;
  shadowTint?: number;
  nightFloor?: number;
  debugMode?: CloudDebugMode;
  /** Phase 7.9A — domain warp intensity for cyclonic swirl. 0 = off, 1 = default. */
  swirlStrength?: number;
  /** Phase 7.9A — procedural storm system density. 0 = off, 1 = default. */
  stormIntensity?: number;
  /** Phase 7.9A — latitude-based climate modulation. 0 = off, 1 = default. */
  climateStrength?: number;
  /** Phase 8A — land/ocean anchoring. 0 = off, 1 = default. */
  landMaskStrength?: number;
  /** Phase 8A — eastward storm advection. 0 freezes storms, 1 = default. */
  stormAdvection?: number;
  /** Phase 8A — altitude stratification. 0 = flat low layer, 1 = default (dual-band). */
  altitudeBlend?: number;
  /** Phase 8B — sampled climatology weight. 0 = off (heuristic only), 1 = default. */
  climatologyStrength?: number;
  /** Phase 8B — aerial perspective on distant clouds. 0 = off, 1 = default. */
  aerialPerspective?: number;
  /** Phase 8B — cirrus streak anisotropy in the high band. 0 = off, 1 = default. */
  cirrusStreakStrength?: number;
  /** Phase 8B — anvil-top loft under strong storm cores. 0 = off, 1 = default. */
  anvilStrength?: number;
  /** Phase 9A — storm-core density multiplier for body/readability. 0 = off, 1 = default. */
  stormMassBoost?: number;
  /** Phase 9A — low-band HG g value (default ~0.55, backscatter-heavy stratocumulus). */
  lowPhaseG?: number;
  /** Phase 9A — high-band HG g value (default ~0.88, strong forward-scatter cirrus). */
  highPhaseG?: number;
  /** Phase 9A — cloud-top vs underside brightness separation. 0 = flat, 1 = full. */
  cloudTopShadow?: number;
  /** Phase 9A — limb tint softness (0 = no limb halo, 1 = Phase 8B strength). */
  limbSoftness?: number;
  /**
   * Phase 9B — sky-captured ambient lighting. When provided, cloud
   * ambient blends toward the captured sky direction instead of the
   * fixed analytic Rayleigh term.
   */
  skyTexture?: Texture | null;
  /** Phase 9B — strength of the sky-capture ambient blend. Default 0.75. */
  skyAmbientStrength?: number;
  /** Phase 9B — Earth shadow on cloud light path. 0 disables, 1 = full. */
  earthShadowStrength?: number;
  /** Phase 10B — initial runtime cloud step count. Updated per-frame. */
  cloudStepCount?: number;
  /** Phase 10B — initial LOD bias (0 = near detail, 1 = wide simple). */
  lodBias?: number;
  /** Phase 10B — TAA master enable (mirrors quality tier taaEnabled). */
  taaEnabled?: boolean;
  /** Phase 10B — TAA blend ceiling (quality tier taaBlend). */
  taaBlend?: number;
}

export function createVolumetricCloudUniforms({
  cloudTexture,
  landMaskTexture,
  climatologyTexture,
  sunDirection = SUN_DIRECTION.clone(),
  twilightLift = 0.18,
  wrapLight = 0.44,
  transmittedLight = 0.24,
  shadowTint = 0.09,
  nightFloor = 0.12,
  debugMode = "full",
  swirlStrength = 1.0,
  stormIntensity = 1.0,
  climateStrength = 1.0,
  landMaskStrength = 1.0,
  stormAdvection = 1.0,
  altitudeBlend = 1.0,
  climatologyStrength = 1.0,
  aerialPerspective = 1.0,
  cirrusStreakStrength = 1.0,
  anvilStrength = 1.0,
  stormMassBoost = 1.0,
  lowPhaseG = 0.55,
  highPhaseG = 0.88,
  cloudTopShadow = 1.0,
  limbSoftness = 0.65,
  skyTexture = null,
  skyAmbientStrength = 0.75,
  earthShadowStrength = 1.0,
  cloudStepCount = 32,
  lodBias = 0.0,
  taaEnabled = false,
  taaBlend = 0.75,
}: VolumetricCloudUniformParams) {
  return {
    uCloudMap:               { value: cloudTexture },
    uLandMask:               { value: landMaskTexture },
    uClimatology:            { value: climatologyTexture },
    uCloudOffset:            { value: 0 },
    uSunDirection:           { value: sunDirection.normalize() },
    uTime:                   { value: 0 },
    uInnerRadius:            { value: VOLUMETRIC_CLOUD_INNER_RADIUS },
    uOuterRadius:            { value: VOLUMETRIC_CLOUD_OUTER_RADIUS },
    uDensityScale:           { value: VOLUMETRIC_CLOUD_DENSITY_SCALE },
    uAbsorption:             { value: VOLUMETRIC_CLOUD_ABSORPTION },
    uAtmosphereRayleighTint: { value: ATMOSPHERE_RAYLEIGH_TINT.clone() },
    uAtmosphereTwilightTint: { value: ATMOSPHERE_TWILIGHT_TINT.clone() },
    uAtmosphereMieTint:      { value: ATMOSPHERE_MIE_TINT.clone() },
    uTwilightLift:           { value: twilightLift },
    uWrapLight:              { value: wrapLight },
    uTransmittedLight:       { value: transmittedLight },
    uShadowTint:             { value: shadowTint },
    uNightFloor:             { value: nightFloor },
    uCloudDebugMode:         { value: encodeCloudDebugMode(debugMode) },
    uSwirlStrength:          { value: swirlStrength },
    uStormIntensity:         { value: stormIntensity },
    uClimateStrength:        { value: climateStrength },
    uLandMaskStrength:       { value: landMaskStrength },
    uStormAdvection:         { value: stormAdvection },
    uAltitudeBlend:          { value: altitudeBlend },
    uClimatologyStrength:    { value: climatologyStrength },
    uAerialPerspective:      { value: aerialPerspective },
    uCirrusStreakStrength:   { value: cirrusStreakStrength },
    uAnvilStrength:          { value: anvilStrength },
    uStormMassBoost:         { value: stormMassBoost },
    uLowPhaseG:              { value: lowPhaseG },
    uHighPhaseG:             { value: highPhaseG },
    uCloudTopShadow:         { value: cloudTopShadow },
    uLimbSoftness:           { value: limbSoftness },
    // Phase 9B — orbital light transport. Sampler falls back to the
    // cloudTexture so the shader always has a valid target; uUseSkyMap
    // gates whether it's consulted.
    uSkyMap:                 { value: skyTexture ?? cloudTexture },
    uUseSkyMap:              { value: skyTexture ? 1 : 0 },
    uSkyAmbientStrength:     { value: skyAmbientStrength },
    uEarthShadowStrength:    { value: earthShadowStrength },
    uFrameIndex:             { value: 0 },
    // Phase 10B — unified quality / temporal budget uniforms.
    uCloudStepCount:         { value: cloudStepCount },
    uLODBias:                { value: lodBias },
    uTaaEnabled:             { value: taaEnabled ? 1 : 0 },
    uTaaBlend:               { value: taaBlend },
    uHistoryReady:           { value: 0 },
    uHistoryInvResolution:   { value: new Vector2(1, 1) },
    uPrevViewProjection:     { value: new Matrix4() },
    // uHistoryTex defaults to the cloud map — valid sampler binding until
    // the first history capture swaps in the real framebuffer texture.
    uHistoryTex:             { value: cloudTexture },
  };
}
