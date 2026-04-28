"use client";

import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";

import {
  configureEarthSurfaceTextures,
  createEarthShaderUniforms,
  type EarthDebugView,
  EARTH_FRAGMENT_SHADER,
  EARTH_VERTEX_SHADER,
} from "@/lib/three/earthShader";
import { CLOUD_SHADOW_UV_SPEED, SUN_DIRECTION } from "@/lib/three/globeSceneConfig";

interface EarthMaterialProps {
  dayMap: THREE.Texture;
  nightMap: THREE.Texture;
  normalMap: THREE.Texture;
  specularMap: THREE.Texture;
  cloudShadowMap?: THREE.Texture | null;
  /** Phase 8B — shared climatology DataTexture (createClimatologyTexture). */
  climatologyMap?: THREE.Texture | null;
  /** Phase 9A — live volumetric cloud-coverage render target for true shadow parity. */
  cloudCoverageRT?: THREE.Texture | null;
  sunDirection?: THREE.Vector3;
  debugView?: EarthDebugView;
  skyMap?: THREE.Texture | null;
  /** Phase 10B — atmosphere single-scatter sample count (compile-time). */
  atmosphereSamples?: number;
}

export function EarthMaterial({
  dayMap,
  nightMap,
  normalMap,
  specularMap,
  cloudShadowMap = null,
  climatologyMap = null,
  cloudCoverageRT = null,
  sunDirection = SUN_DIRECTION.clone(),
  debugView = "default",
  skyMap = null,
  atmosphereSamples = 6,
}: EarthMaterialProps) {
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);

  const material = useMemo(() => {
    configureEarthSurfaceTextures({
      dayMap,
      nightMap,
      normalMap,
      specularMap,
      cloudShadowMap,
      climatologyMap,
      cloudCoverageRT,
    });

    // Phase 10B Part 4 — atmosphere sample budget compiled into the
    // shader via defines so the for-loop bound stays a constant (WebGL
    // requirement) but still scales with the active quality tier.
    const clampedAtmSamples = Math.max(2, Math.min(16, Math.round(atmosphereSamples)));

    const shaderMaterial = new THREE.ShaderMaterial({
      vertexShader: EARTH_VERTEX_SHADER,
      fragmentShader: EARTH_FRAGMENT_SHADER,
      side: THREE.FrontSide,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      defines: {
        ATM_SAMPLES: clampedAtmSamples,
      },
      uniforms: createEarthShaderUniforms({
        dayMap,
        nightMap,
        normalMap,
        specularMap,
        cloudShadowMap,
        climatologyMap,
        cloudCoverageRT,
        sunDirection,
        debugView,
        skyMap,
        cloudShadow: cloudShadowMap
          ? {
              // Phase 4 Part 2 — two-layer shadow stack matching the two
              // CloudsMesh instances mounted in GlobeScene (inner + outer).
              // Using both layers breaks the shadow mask into the same
              // visual frequency as the clouds casting it, so shadows read
              // as soft mottled patches rather than a single uniform sheet.
              strength: 0.82,
              darken: 0.26,
              layers: [
                { offset: 0, seed: 0.18, weight: 0.58 },
                { offset: 0.137, seed: 0.63, weight: 0.34 },
              ],
            }
          : {
              enabled: false,
            },
      }),
    });

    materialRef.current = shaderMaterial;
    return shaderMaterial;
  }, [atmosphereSamples, climatologyMap, cloudCoverageRT, cloudShadowMap, dayMap, debugView, nightMap, normalMap, skyMap, specularMap, sunDirection]);

  useFrame((_, delta) => {
    if (!materialRef.current) {
      return;
    }

    materialRef.current.uniforms.uSunDirection.value.copy(sunDirection).normalize();
    if (cloudShadowMap) {
      const nextOffset = materialRef.current.uniforms.uCloudOffset0.value - delta * CLOUD_SHADOW_UV_SPEED;
      const normalizedOffset = ((nextOffset % 1) + 1) % 1;
      materialRef.current.uniforms.uCloudOffset0.value = normalizedOffset;
      materialRef.current.uniforms.uCloudOffset1.value = ((normalizedOffset + 0.137) % 1 + 1) % 1;
      materialRef.current.uniforms.uTime.value += delta;
    }
    // Phase 10B Part 5 — per-frame counter for ocean highlight sub-pixel
    // jitter. Always incremented, even when cloud shadows are off, so the
    // ocean glint stays temporally stable on the lowest tier too.
    const frameUniform = materialRef.current.uniforms.uFrameIndex;
    if (frameUniform) {
      frameUniform.value = (frameUniform.value + 1) % 1024;
    }
  });

  useEffect(() => {
    return () => {
      material.dispose();
      materialRef.current = null;
    };
  }, [material]);

  return <primitive attach="material" object={material} />;
}
