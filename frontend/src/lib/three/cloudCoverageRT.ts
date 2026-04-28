/**
 * Phase 9A — True Shadow Parity
 *
 * Renders a 2D equirectangular coverage field driven by the *exact same*
 * weather/climate logic that drives the visible volumetric clouds. The
 * earth shader samples this texture for its cloud shadow mask, so the
 * systems the user sees on the surface are the same systems that darken
 * the ground beneath them.
 *
 * Before Phase 9A:
 *   Earth shader sampled the flat clouds.png alpha + an analytic bias
 *   that mimicked the volumetric shader's weather logic. The two tracks
 *   drifted because the analytic bias was a hand-tuned approximation.
 *
 * After Phase 9A:
 *   A 512×256 R-channel RenderTarget is populated every frame with
 *   coverage(n) for each lat/lon direction. The earth shader reads
 *   that texture directly — no bias, no duplicated formula.
 *
 * Performance:
 *   One full-screen pass at 512×256 (~130K fragments) per frame, no
 *   raymarching, just weather context + one coverage sample. ~10×
 *   cheaper than the main volumetric pass.
 *
 * The GLSL below duplicates the coverage-relevant helpers from
 * volumetricClouds.ts. It deliberately does NOT include the raymarch,
 * altitude profile, or lighting — we only need the 2D column coverage.
 */

import * as THREE from "three";
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { Texture } from "three";

import { CLOUD_ROTATION_SPEED } from "@/lib/three/globeSceneConfig";

const COVERAGE_RT_MACRO_WIDTH  = 512;
const COVERAGE_RT_MACRO_HEIGHT = 256;
const COVERAGE_RT_DETAIL_WIDTH  = 1024;
const COVERAGE_RT_DETAIL_HEIGHT = 512;

type CoverageResolution = "macro" | "detail";

const COVERAGE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const COVERAGE_FRAGMENT = /* glsl */ `
  precision highp float;
  const float PI = 3.141592653589793;

  uniform sampler2D uCloudMap;
  uniform sampler2D uLandMask;
  uniform sampler2D uClimatology;
  uniform float uCloudOffset;
  uniform float uTime;
  uniform float uSwirlStrength;
  uniform float uStormIntensity;
  uniform float uClimateStrength;
  uniform float uLandMaskStrength;
  uniform float uStormAdvection;
  uniform float uClimatologyStrength;

  varying vec2 vUv;

  /* ── Weather globals (only the ones we need for coverage) ─── */
  vec3  gSwirlWarp;
  float gClimateBias;
  float gStormField;
  // Phase 9B — band-share fields. gLowBandShare + gMidBandShare +
  // gHighBandShare sum to 1. Stored in .b / .a of the RT (mid is
  // implicit: 1 - low - high) so the earth shader can modulate shadow
  // strength and softness by cloud type.
  float gLowBandShare;
  float gHighBandShare;

  /* ── Noise (matches volumetricClouds.ts) ───────────────────── */
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

  vec2 sphericalUv(vec3 n) {
    float lon = atan(-n.z, n.x);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    return vec2(fract(lon / (2.0 * PI) + 0.5), lat / PI + 0.5);
  }

  float sampleOceanicness(vec3 n) {
    vec2 uv = sphericalUv(n);
    float water = texture2D(uLandMask, uv).r;
    return smoothstep(0.10, 0.72, water);
  }

  float advectionRate(float lat) {
    float absLat = abs(lat);
    float tradeBand = smoothstep(0.02, 0.26, absLat)
                    * (1.0 - smoothstep(0.34, 0.52, absLat));
    float midBand   = smoothstep(0.55, 0.85, absLat)
                    * (1.0 - smoothstep(1.05, 1.38, absLat));
    float polarBand = smoothstep(1.18, 1.42, absLat);
    return (midBand * 0.95) - (tradeBand * 0.55) - (polarBand * 0.35);
  }

  float regionalIdentitySample(vec3 n) {
    vec3 s1 = n * 0.90 + vec3(7.3, 11.1, 3.7);
    vec3 s2 = n * 1.55 + vec3(17.7, 5.3, 9.1);
    return (vnoise(s1) * 0.65 + vnoise(s2) * 0.35 - 0.5);
  }

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

  vec3 rotateEastward(vec3 n, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec3(
      n.x * c - n.z * s,
      n.y,
      n.x * s + n.z * c
    );
  }

  /* ── Weather context (trimmed: no altitude/anvil bookkeeping) ── */
  void setupWeatherContext(vec3 n) {
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float absLat = abs(lat);
    float lon = atan(-n.z, n.x);
    float hem = sign(n.y + 0.001);

    float oceanicness = sampleOceanicness(n);

    vec2 climUv = sphericalUv(n);
    vec4 clim = texture2D(uClimatology, climUv);
    float climConvection = clim.r;
    float climCover = clim.g;
    float climITCZ = clim.b;
    float climCorridor = clim.a;

    float coriolis = sign(n.y) * smoothstep(0.08, 0.42, abs(n.y));
    float ca = cos(coriolis * 0.85);
    float sa = sin(coriolis * 0.85);

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

    float midLatActivity = exp(-pow(absLat - 0.82, 2.0) / 0.040);
    float tropicalSteady = exp(-absLat * absLat / 0.028);

    float continentalFactor = continentalGeography(lon, hem, absLat);
    float g1Axis = sin(lon * 1.00 + mix(-1.3, 0.8, step(0.0, hem)));

    float continentalDry = max(continentalFactor, 0.0)
                         * smoothstep(0.12, 0.48, absLat)
                         * (1.0 - smoothstep(0.90, 1.20, absLat))
                         * 0.06;
    float oceanicWet = max(-continentalFactor, 0.0) * midLatActivity * 0.09;

    float regional = regionalIdentitySample(n);
    float regionalIdentity = regional * 0.16;

    float oceanWetLift = oceanicness
                       * (0.035 + midLatActivity * 0.065 + tropicalSteady * 0.030);
    float landDryDip   = (1.0 - oceanicness)
                       * smoothstep(0.12, 0.55, absLat)
                       * (1.0 - smoothstep(1.05, 1.30, absLat))
                       * 0.065;
    float wetDryBias = (oceanWetLift - landDryDip) * uLandMaskStrength;

    float itczBase = exp(-absLat * absLat / 0.020);
    float itczLonMask = 0.55
                     + 0.30 * sin(lon * 3.0 + 0.4)
                     + 0.15 * sin(lon * 1.0 - 1.2);
    itczLonMask = clamp(itczLonMask, 0.25, 1.05);
    float itczOceanBoost = mix(0.85, 1.15, oceanicness);
    float itcz = itczBase * 0.22 * itczLonMask * itczOceanBoost;

    float midStorm = exp(-pow(absLat - 0.82, 2.0) / 0.030) * 0.22
                   + oceanicWet
                   + midLatActivity * oceanicness * 0.04;

    float subtropCalmEnvelope = exp(-pow(absLat - 0.44, 2.0) / 0.022);
    float easternBasinDry = max(-g1Axis, 0.0) * subtropCalmEnvelope * 0.05;
    float subtropCalm = subtropCalmEnvelope * 0.10 + continentalDry + easternBasinDry;

    float polarFront = exp(-pow(absLat - 1.10, 2.0) / 0.045) * 0.14
                     * (1.0 + step(-0.1, -n.y) * 0.35);

    float climBias = (climCover - 0.45) * 0.08
                   + (climITCZ  - 0.05) * 0.12
                   + (climConvection - 0.30) * 0.06;

    gClimateBias = (itcz + midStorm + polarFront - subtropCalm
                  + regionalIdentity + wetDryBias
                  + climBias * uClimatologyStrength)
                 * uClimateStrength;

    float advectSignedRate = advectionRate(lat) * uStormAdvection;
    float advectAngle = uTime * 0.00018 * advectSignedRate;
    vec3 advectedN = rotateEastward(n, -advectAngle);

    vec3 stormPos = normalize(advectedN + w1 * 0.12);
    vec3 stormSeed = vec3(stormPos.x * 3.6, stormPos.y * 1.8, stormPos.z * 3.6);
    float stormNoise = vnoise(stormSeed) * 0.60
                     + vnoise(stormSeed * vec3(2.1, 1.4, 2.1)
                              + vec3(11.3, 7.7, 19.1)) * 0.40;

    float oceanStormBias = (oceanicness - 0.5) * 0.05 * uLandMaskStrength;
    float stormThresholdLo = 0.44 - regionalIdentity * 1.2 - oceanStormBias;
    float stormThresholdHi = 0.68 - regionalIdentity * 1.2 - oceanStormBias;
    float rawStorm = smoothstep(stormThresholdLo, stormThresholdHi, stormNoise);

    float corridorMask = midLatActivity * 0.70
                       + oceanicWet * 2.8
                       + oceanicness * midLatActivity * 0.25
                       + step(-0.1, -n.y) * smoothstep(0.65, 0.90, absLat) * 0.40;
    corridorMask = mix(corridorMask,
                       max(corridorMask, climCorridor * 0.9),
                       uClimatologyStrength * 0.6);
    corridorMask = clamp(corridorMask, 0.20, 1.0);

    float stormLatMod = smoothstep(0.10, 0.32, absLat)
                      * (1.0 - smoothstep(1.20, 1.45, absLat));
    gStormField = rawStorm * stormLatMod * corridorMask * uStormIntensity;

    // Phase 9B — band weights mirror the altitude-mass weights computed
    // in volumetricClouds.ts::bandWeights(). The RT cannot simulate an
    // altitude profile, but we can encode "how much of this column is
    // low/dense vs. high/thin" so the earth shader can vary shadow
    // strength and softness per band.
    float lowWeight  = clamp(0.55
                             + gStormField * 0.42
                             + oceanWetLift * 3.0
                             + itcz * 1.6
                             - subtropCalm * 1.2, 0.20, 1.05);
    float midWeight  = clamp(0.60
                             + midLatActivity * 0.35
                             + polarFront * 0.9
                             + gStormField * 0.25
                             - subtropCalm * 0.40, 0.22, 1.00);
    float highWeight = clamp(0.45
                             + subtropCalm * 0.85
                             + tropicalSteady * 0.30
                             + climITCZ * 0.55
                             - gStormField * 0.20, 0.18, 1.00);
    float bandSum = lowWeight + midWeight + highWeight + 1e-4;
    gLowBandShare  = lowWeight  / bandSum;
    gHighBandShare = highWeight / bandSum;

    float activityGate = clamp(
      midLatActivity * 0.55 + corridorMask * 0.40 + rawStorm * 0.35,
      0.18, 1.0
    );
    float swirlMod = mix(0.45, 1.0, midLatActivity) * (1.0 - tropicalSteady * 0.35);
    gSwirlWarp = (w1 * 0.075 + w2 * 0.045) * uSwirlStrength * swirlMod * activityGate;
  }

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

  void main() {
    float lon = (vUv.x - 0.5) * 2.0 * PI;
    float lat = (vUv.y - 0.5) * PI;
    vec3 n = normalize(vec3(
      cos(lat) * cos(lon),
      sin(lat),
      -cos(lat) * sin(lon)
    ));

    setupWeatherContext(n);
    float cov = coverageSample(n);

    // Phase 9B channel layout:
    //   R = total coverage
    //   G = storm-field strength  (preserved from 9A)
    //   B = low-band mass         = lowShare * coverage
    //   A = high-band mass        = highShare * coverage
    // Earth shader derives shares by dividing by R. Mid-share is implicit.
    gl_FragColor = vec4(cov, gStormField, gLowBandShare * cov, gHighBandShare * cov);
  }
`;

/* ------------------------------------------------------------------ */
/*  RT capture internals                                               */
/* ------------------------------------------------------------------ */

interface CoverageCaptureState {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  material: THREE.ShaderMaterial;
  target: THREE.WebGLRenderTarget;
  dispose: () => void;
}

function createCoverageCapture(resolution: CoverageResolution = "macro"): CoverageCaptureState {
  const width  = resolution === "detail" ? COVERAGE_RT_DETAIL_WIDTH  : COVERAGE_RT_MACRO_WIDTH;
  const height = resolution === "detail" ? COVERAGE_RT_DETAIL_HEIGHT : COVERAGE_RT_MACRO_HEIGHT;

  const target = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  });

  const material = new THREE.ShaderMaterial({
    vertexShader: COVERAGE_VERTEX,
    fragmentShader: COVERAGE_FRAGMENT,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uCloudMap:            { value: null as Texture | null },
      uLandMask:            { value: null as Texture | null },
      uClimatology:         { value: null as Texture | null },
      uCloudOffset:         { value: 0 },
      uTime:                { value: 0 },
      uSwirlStrength:       { value: 1.0 },
      uStormIntensity:      { value: 1.0 },
      uClimateStrength:     { value: 1.0 },
      uLandMaskStrength:    { value: 1.0 },
      uStormAdvection:      { value: 1.0 },
      uClimatologyStrength: { value: 1.0 },
    },
  });

  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  const scene = new THREE.Scene();
  scene.add(mesh);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  return {
    scene,
    camera,
    material,
    target,
    dispose() {
      target.dispose();
      material.dispose();
      geometry.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/*  React hook                                                         */
/* ------------------------------------------------------------------ */

interface UseCloudCoverageRTParams {
  cloudTexture: Texture | null;
  landMaskTexture: Texture | null;
  climatologyTexture: Texture | null;
  enabled: boolean;
  /**
   * Render cadence. 1 = every frame (true parity), 2 = every other
   * frame (fine for shadow — drift is a fraction of a cloud pixel).
   */
  updateEvery?: number;
  /**
   * Phase 9B — "macro" (512×256, default) drives the shadow pass every
   * frame. "detail" (1024×512) doubles the shadow resolution at ~4×
   * fragment cost; intended for "high" quality tier only.
   */
  resolution?: CoverageResolution;
}

/**
 * Maintains a live 512×256 cloud-coverage render target. The texture
 * reference is stable across enable toggles so consuming materials
 * never need to be recreated.
 *
 * Returns the target texture. Earth shader should sample `.r` for
 * the full coverage value (already includes climate bias + storm
 * field + climatology — the same logic the volumetric shader uses).
 */
export function useCloudCoverageRT({
  cloudTexture,
  landMaskTexture,
  climatologyTexture,
  enabled,
  updateEvery = 1,
  resolution = "macro",
}: UseCloudCoverageRTParams): Texture {
  const { gl } = useThree();
  const frameRef = useRef(0);
  const offsetRef = useRef(0);
  const timeRef = useRef(0);
  const hasRenderedRef = useRef(false);

  const capture = useMemo(() => createCoverageCapture(resolution), [resolution]);

  useEffect(() => {
    return () => capture.dispose();
  }, [capture]);

  useFrame((_, delta) => {
    // Match the volumetric cloud offset advancement exactly so the
    // coverage field stays aligned with the visible systems.
    const speed = CLOUD_ROTATION_SPEED * 0.16;
    offsetRef.current = ((offsetRef.current - delta * speed) % 1 + 1) % 1;
    timeRef.current += delta;

    if (!enabled || !cloudTexture || !landMaskTexture || !climatologyTexture) return;

    const cadence = Math.max(1, Math.floor(updateEvery));
    const isFirst = !hasRenderedRef.current;
    frameRef.current++;
    if (!isFirst && frameRef.current % cadence !== 0) return;
    hasRenderedRef.current = true;

    const u = capture.material.uniforms;
    u.uCloudMap.value    = cloudTexture;
    u.uLandMask.value    = landMaskTexture;
    u.uClimatology.value = climatologyTexture;
    u.uCloudOffset.value = offsetRef.current;
    u.uTime.value        = timeRef.current;

    const prevTarget = gl.getRenderTarget();
    gl.setRenderTarget(capture.target);
    gl.clear();
    gl.render(capture.scene, capture.camera);
    gl.setRenderTarget(prevTarget);
  }, -2); // Priority -2: render before sky capture (-1) and main scene (0)

  return capture.target.texture;
}
