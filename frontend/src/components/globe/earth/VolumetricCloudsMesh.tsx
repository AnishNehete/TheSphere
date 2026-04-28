/**
 * Phase 7A / 8A — Volumetric Cloud Mesh
 *
 * Renders raymarched volumetric clouds through a bounded spherical shell.
 * Replaces the two-layer alpha-shell CloudsMesh at medium+ quality tiers.
 *
 * The geometry is a sphere at the outer cloud radius. The fragment shader
 * computes ray-shell intersections and marches through the cloud volume,
 * accumulating density and lighting. Step counts are compile-time constants
 * injected via ShaderMaterial.defines, so quality tiers produce different
 * shader programs (recompile on tier change, which is rare).
 *
 * Phase 8A wires a land/ocean mask (the specular texture — r channel is
 * already a water mask) into the shader so cloud behaviour anchors to
 * real geography.
 *
 * Low quality tier falls back to the original CloudsMesh in GlobeScene.
 */

"use client";

import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Texture } from "three";

import {
  VOLUMETRIC_CLOUD_FRAGMENT,
  VOLUMETRIC_CLOUD_OUTER_RADIUS,
  VOLUMETRIC_CLOUD_VERTEX,
  createVolumetricCloudUniforms,
  type CloudDebugMode,
} from "@/lib/three/volumetricClouds";
import {
  CLOUD_ROTATION_SPEED,
  SCENE_RENDER_ORDER,
  SUN_DIRECTION,
} from "@/lib/three/globeSceneConfig";
import type { CloudHistoryHandle } from "@/lib/three/cloudHistoryRT";

interface VolumetricCloudsMeshProps {
  texture: Texture;
  /** Phase 8A — land/ocean mask texture (specular works here). */
  landMask: Texture;
  /** Phase 8B — baked climatology DataTexture (createClimatologyTexture). */
  climatology: Texture;
  /** Phase 9B — sky-capture render target for orbital ambient realism. */
  skyMap?: Texture | null;
  /**
   * Phase 10B Part 2 — compile-time ceiling for cloud raymarch steps.
   * The runtime count is chosen adaptively from camera distance and is
   * bounded by this ceiling. Tier-driven.
   */
  stepsMax?: number;
  /**
   * Phase 10B Part 2 — runtime floor for adaptive steps at wide orbital
   * framing. Keeps the cloud silhouette stable even in low-cost frames.
   */
  stepsMin?: number;
  /** Sun-direction light march steps. Injected as #define LIGHT_STEPS. */
  lightSteps?: number;
  /** Sphere geometry segment count. */
  segments?: number;
  /** Freeze cloud animation (diagnostics mode). */
  freezeMotion?: boolean;
  /** Cloud debug mode (exposes Phase 8A channels: land-mask, wet-dry-bias, storm-advection, altitude-layers). */
  debugMode?: CloudDebugMode;
  /** Phase 10B Part 1 — TAA master enable (mirrors quality tier taaEnabled). */
  taaEnabled?: boolean;
  /** Phase 10B Part 1 — TAA blend ceiling (quality tier taaBlend). */
  taaBlend?: number;
  /**
   * Phase 10B Part 1 — cloud history handle. When the tier enables TAA,
   * pass the handle returned by useCloudHistoryRT here. The mesh wires
   * its texture / prev VP / inv-resolution uniforms each frame.
   */
  historyHandle?: CloudHistoryHandle | null;
}

export function VolumetricCloudsMesh({
  texture,
  landMask,
  climatology,
  skyMap = null,
  stepsMax = 64,
  stepsMin = 18,
  lightSteps = 6,
  segments = 192,
  freezeMotion = false,
  debugMode = "full",
  taaEnabled = false,
  taaBlend = 0.75,
  historyHandle = null,
}: VolumetricCloudsMeshProps) {
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);

  const material = useMemo(() => {
    texture.colorSpace = THREE.NoColorSpace;
    landMask.colorSpace = THREE.NoColorSpace;
    climatology.colorSpace = THREE.NoColorSpace;

    // Phase 10B — MAX_CLOUD_STEPS is the compile-time ceiling; the shader
    // loops up to this count and breaks early at uCloudStepCount, which
    // is updated per-frame from camera distance below.
    const clampedMax = Math.max(8, Math.min(192, Math.round(stepsMax)));

    const mat = new THREE.ShaderMaterial({
      vertexShader: VOLUMETRIC_CLOUD_VERTEX,
      fragmentShader: VOLUMETRIC_CLOUD_FRAGMENT,
      defines: {
        MAX_CLOUD_STEPS: clampedMax,
        LIGHT_STEPS: lightSteps,
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.FrontSide,
      uniforms: createVolumetricCloudUniforms({
        cloudTexture: texture,
        landMaskTexture: landMask,
        climatologyTexture: climatology,
        skyTexture: skyMap,
        debugMode,
        cloudStepCount: clampedMax,
        lodBias: 0,
        taaEnabled,
        taaBlend,
      }),
    });

    materialRef.current = mat;
    return mat;
  }, [texture, landMask, climatology, skyMap, stepsMax, lightSteps, debugMode, taaBlend, taaEnabled]);

  // Phase 9B — keep the sky-capture uniform in sync without rebuilding
  // the material. The hook returns a stable RT texture, so this usually
  // runs once at mount; if the capture is disabled at runtime the gate
  // is handled by uUseSkyMap.
  useEffect(() => {
    if (!materialRef.current) return;
    const u = materialRef.current.uniforms;
    u.uSkyMap.value = skyMap ?? texture;
    u.uUseSkyMap.value = skyMap ? 1 : 0;
  }, [skyMap, texture]);

  useFrame((state, delta) => {
    if (!materialRef.current) return;
    const u = materialRef.current.uniforms;

    if (!freezeMotion) {
      const speed = CLOUD_ROTATION_SPEED * 0.16;
      u.uCloudOffset.value = ((u.uCloudOffset.value - delta * speed) % 1 + 1) % 1;
      u.uTime.value += delta;
    }

    u.uSunDirection.value.copy(SUN_DIRECTION).normalize();
    // Phase 9B — advance temporal jitter index. Wraps at 2^20 so the
    // float stays well below precision loss.
    u.uFrameIndex.value = (u.uFrameIndex.value + 1) % 1048576;

    // Phase 10B Part 2+3 — adaptive cloud step count and LOD bias.
    // Distance from the camera to the cloud shell drives both. Near the
    // surface we spend the full step budget and retain full detail; from
    // wide orbital framing we drop steps to the floor and suppress the
    // per-step noise taps to keep macro shape stable.
    const camDist = state.camera.position.length();
    const shellDist = Math.max(camDist - VOLUMETRIC_CLOUD_OUTER_RADIUS, 0);
    // Normalised distance — 0 at shell grazing, 1 at ~1.2 world units out
    // (about the orbital framing used by the default camera dolly).
    const distNorm = Math.min(Math.max(shellDist / 1.2, 0), 1);
    const maxSteps = (materialRef.current.defines?.MAX_CLOUD_STEPS as number | undefined) ?? stepsMax;
    const floor = Math.max(4, Math.min(maxSteps, Math.round(stepsMin)));
    const adaptiveSteps = Math.round(maxSteps - (maxSteps - floor) * distNorm);
    u.uCloudStepCount.value = adaptiveSteps;
    // LOD bias ramps in once the camera is past the close-range band so
    // zoom-ins keep full detail; wide framing progressively suppresses it.
    u.uLODBias.value = Math.min(1, Math.max(0, (distNorm - 0.15) / 0.65));

    // Phase 10B Part 1 — temporal reprojection uniforms. Only consume the
    // handle when TAA is enabled; otherwise the shader gate (uTaaEnabled
    // = 0) skips the blend path entirely.
    if (taaEnabled && historyHandle) {
      u.uHistoryTex.value = historyHandle.texture;
      u.uHistoryReady.value = historyHandle.ready.value;
      u.uHistoryInvResolution.value.copy(historyHandle.invResolution);
      u.uPrevViewProjection.value.copy(historyHandle.prevViewProjection);
      u.uTaaEnabled.value = 1;
    } else {
      u.uTaaEnabled.value = 0;
      u.uHistoryReady.value = 0;
    }
  });

  useEffect(() => {
    return () => {
      material.dispose();
      materialRef.current = null;
    };
  }, [material]);

  const r = VOLUMETRIC_CLOUD_OUTER_RADIUS;

  return (
    <mesh scale={[r, r, r]} renderOrder={SCENE_RENDER_ORDER.clouds}>
      <sphereGeometry args={[1, segments, segments]} />
      <primitive attach="material" object={material} />
    </mesh>
  );
}
