"use client";

import * as THREE from "three";
import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";

import {
  ATMOSPHERE_ALPHA_SCALE,
  ATMOSPHERE_EDGE_SHARPNESS,
  ATMOSPHERE_FALLOFF,
  ATMOSPHERE_INTENSITY,
  ATMOSPHERE_MIE_TINT,
  ATMOSPHERE_RADIUS,
  ATMOSPHERE_RAYLEIGH_TINT,
  ATMOSPHERE_SUN_BOOST,
  ATMOSPHERE_TWILIGHT_TINT,
  SCENE_RENDER_ORDER,
  SUN_DIRECTION,
} from "@/lib/three/globeSceneConfig";

const vertexShader = `
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;
  varying vec3 vSunDir;

  uniform vec3 uSunDirection;
  uniform vec3 uCameraPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(uCameraPosition - worldPosition.xyz);
    vSunDir = normalize(uSunDirection);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

// Phase 4 Part 5 — optical-depth atmosphere.
// ------------------------------------------------------------------
// The Phase 3 shell used hardcoded ORANGE/PURPLE bands computed from
// abs(NdotL)-style distance functions. That produced a graphic magenta/cyan
// twilight stripe: visually striking but not photographic. It also
// disagreed with the earth shader's smoothstep spectral twilight, so the
// surface and the atmosphere painted slightly different terminators.
//
// This rewrite switches to three shared-palette terms:
//   * Rayleigh (cool blue) — day-side scatter, thickens toward the limb
//   * Mie      (warm white) — tight forward-scatter lobe near the sun limb
//   * Twilight (warm orange) — a smoothstep spectral band that matches the
//                              earth shader exactly, so the terminator
//                              reads as a single coherent arc.
//
// Optical depth = pow(1 - NdotV, uEdgeSharpness). Each term is modulated
// by this depth so the center of the day disc is thin Rayleigh (no halo),
// the limb is thick Rayleigh + soft twilight, and the night side is a
// near-invisible cool haze only at the limb. No `abs()`-distance bands.
const fragmentShader = `
  precision highp float;

  uniform vec3 uAtmosphereRayleighTint;
  uniform vec3 uAtmosphereMieTint;
  uniform vec3 uAtmosphereTwilightTint;
  uniform float uIntensity;
  uniform float uFalloff;
  uniform float uSunBoost;
  uniform float uEdgeSharpness;
  uniform float uAlphaScale;

  varying vec3 vWorldNormal;
  varying vec3 vViewDir;
  varying vec3 vSunDir;

  float clamp01(float v) { return clamp(v, 0.0, 1.0); }

  void main() {
    vec3 normal  = normalize(vWorldNormal);
    vec3 viewDir = normalize(vViewDir);
    vec3 sunDir  = normalize(vSunDir);

    float NdotV = max(dot(normal, viewDir), 0.0);
    float NdotL = dot(normal, sunDir);

    // Phase 5 Part 4 — Chapman-inspired optical depth (main ring).
    float sinView      = sqrt(max(1.0 - NdotV * NdotV, 0.0));
    float chapmanDepth = 1.0 / max(NdotV + 0.15 * sinView, 0.02);
    float opticalDepth = 1.0 - exp(-uEdgeSharpness * 0.18 * (chapmanDepth - 1.0));

    // Phase 7.6 — layered optical regions.
    // The main opticalDepth term gives a single Chapman curve that only
    // really blooms in the last ~20 deg before the limb. Real atmosphere
    // photography from the ISS reads as three distinct optical bands:
    //   1. A dense low-air ring right at the surface (rich Rayleigh + mie
    //      forward-scatter) — the 8-12km troposphere stack.
    //   2. The main scatter limb (already modeled).
    //   3. A faint upper halo — a high-altitude thinness that extends past
    //      the main rim into black space.
    // Modeling this as three masks gives the atmosphere a photographic
    // layered thickness at side-view angles without over-brightening
    // front-facing shots (where all three bands peak together at low
    // optical depth, so the day center stays calm).
    float lowerAir = smoothstep(0.32, 0.88, opticalDepth) * smoothstep(1.0, 0.62, opticalDepth);
    float upperHalo = smoothstep(0.72, 0.98, opticalDepth);

    // Masks (spectral smoothstep, matches earth shader):
    float dayMask   = smoothstep(-0.15, 0.30, NdotL);
    float twilight  = smoothstep(-0.22, 0.05, NdotL) * (1.0 - smoothstep(0.05, 0.22, NdotL));
    float nightMask = 1.0 - smoothstep(-0.15, 0.12, NdotL);

    // Rayleigh (blue). Main ring term — unchanged balance.
    vec3 rayleigh = uAtmosphereRayleighTint * dayMask * (0.30 + opticalDepth * 0.82);

    // Phase 7.6 — lower-air band. A denser, slightly cooler Rayleigh with a
    // touch of Mie warmth, living right at the surface edge. This is what
    // gives ISS window shots their "kilometers of air below" feeling.
    vec3 lowerAirColor = (uAtmosphereRayleighTint * 0.62
                          + uAtmosphereMieTint * 0.18)
                         * dayMask * lowerAir * 0.38;

    // Phase 7.6 — upper halo. A faint final ring past the main limb. Very
    // weak so it reads as "air thinning into space" rather than as a
    // second halo. Gated by dayMask + soft twilight so it doesn't paint
    // the night limb.
    vec3 upperHaloColor = uAtmosphereRayleighTint * upperHalo
                          * clamp01(dayMask + twilight * 0.7) * 0.14;

    // Mie (warm white). Tight forward-scatter corona near the sun limb.
    // Boosted slightly in the lower-air band so the sunlit limb gets that
    // photographic warm crescent under the main blue.
    float sunAlign   = clamp01(dot(-viewDir, sunDir));
    float mieForward = pow(sunAlign, 5.5) * max(NdotL, 0.0);
    vec3  mie        = uAtmosphereMieTint * mieForward * uSunBoost
                       * (0.55 + lowerAir * 0.28);

    // Twilight (warm orange). Spectral band from the earth shader. Also
    // brightened slightly inside the lower-air band so the terminator has
    // thickness, not just a single thin arc.
    vec3 twilightColor = uAtmosphereTwilightTint
                         * twilight
                         * (0.45 + opticalDepth * 0.60 + lowerAir * 0.24)
                         * 1.20;

    // Night haze. Cool Rayleigh only, faint, limb-only.
    vec3 nightHaze = uAtmosphereRayleighTint * nightMask * opticalDepth * 0.06;

    vec3 color = rayleigh + lowerAirColor + upperHaloColor
               + mie + twilightColor + nightHaze;

    // Phase 10C Part 4 — horizon color anchor. The extreme-limb pixels are
    // where the atmosphere becomes most saturated, and in Phase 10B that
    // corner occasionally read as a graphic neon-blue band. A narrow
    // desaturation window at the very rim (top ~10% of optical depth)
    // pulls those pixels a small distance toward their own luminance,
    // which reads as "physically stable atmosphere" rather than "lifted
    // blue rim". The inner 90% of the atmosphere is untouched, so the
    // Phase 10A/10B scatter balance is preserved.
    float rimAnchor = smoothstep(0.90, 1.00, opticalDepth);
    float lumaApprox = dot(color, vec3(0.3333));
    color = mix(color, vec3(lumaApprox), rimAnchor * 0.22);

    // Alpha: rim-based with energy gating. totalEnergy is a soft "is there
    // something to scatter here?" mask so the dark hemisphere doesn't
    // accumulate alpha from the limb optical depth alone. The upper-halo
    // pass adds a tiny independent alpha so the thin outer band stays
    // visible even when totalEnergy is low (night-limb edge case).
    float totalEnergy = clamp01(dayMask + twilight * 0.85);
    float alpha = opticalDepth * uIntensity;
    alpha *= mix(0.22, 1.0, totalEnergy);
    alpha *= uAlphaScale;
    alpha *= pow(opticalDepth, uFalloff * 0.3 + 0.7);
    alpha += upperHalo * totalEnergy * 0.04 * uAlphaScale;

    gl_FragColor = vec4(color, alpha);
  }
`;

export function AtmosphereMesh({ segments = 192 }: AtmosphereMeshProps) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
        uniforms: {
          uSunDirection: { value: SUN_DIRECTION.clone().normalize() },
          uCameraPosition: { value: new THREE.Vector3() },
          uAtmosphereRayleighTint: { value: ATMOSPHERE_RAYLEIGH_TINT.clone() },
          uAtmosphereMieTint: { value: ATMOSPHERE_MIE_TINT.clone() },
          uAtmosphereTwilightTint: { value: ATMOSPHERE_TWILIGHT_TINT.clone() },
          uIntensity: { value: ATMOSPHERE_INTENSITY },
          uFalloff: { value: ATMOSPHERE_FALLOFF },
          uSunBoost: { value: ATMOSPHERE_SUN_BOOST },
          uEdgeSharpness: { value: ATMOSPHERE_EDGE_SHARPNESS },
          uAlphaScale: { value: ATMOSPHERE_ALPHA_SCALE },
        },
      }),
    []
  );

  useFrame(({ camera }) => {
    material.uniforms.uSunDirection.value.copy(SUN_DIRECTION).normalize();
    material.uniforms.uCameraPosition.value.copy(camera.position);
  });

  useEffect(() => {
    return () => {
      material.dispose();
    };
  }, [material]);

  return (
    <mesh scale={ATMOSPHERE_RADIUS} renderOrder={SCENE_RENDER_ORDER.atmosphere}>
      <sphereGeometry args={[1, segments, segments]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

interface AtmosphereMeshProps {
  segments?: number;
}
