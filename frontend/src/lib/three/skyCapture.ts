/**
 * Phase 7B — Sky Capture for Ocean Reflection
 *
 * Renders the atmosphere + cloud influence into a low-resolution
 * equirectangular sky map. The earth shader samples this texture at the
 * reflected view direction for physically-grounded ocean reflections
 * that respond to the actual sky state instead of analytical approximations.
 *
 * Update strategy:
 *  - The sky map is 256 × 128 (32K fragments) — trivially cheap to render.
 *  - Updated every SKY_UPDATE_INTERVAL frames (~0.5 s at 60 fps).
 *  - Rendered in a useFrame callback at priority -1 (before scene render)
 *    so the texture is ready when the earth shader reads it.
 *  - Cloud offset tracked independently (drift over the update interval
 *    is imperceptible at cloud rotation speed).
 *
 * The sky shader evaluates:
 *  - Rayleigh scatter (cool blue, day hemisphere)
 *  - Mie forward scatter (warm white, near sun direction)
 *  - Twilight band (warm orange, terminator arc)
 *  - Cloud influence (dims/brightens sky where cloud coverage exists)
 *  - Night suppression
 *  - Horizon brightening
 */

import * as THREE from "three";
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { Texture } from "three";

import {
  ATMOSPHERE_MIE_TINT,
  ATMOSPHERE_RAYLEIGH_TINT,
  ATMOSPHERE_TWILIGHT_TINT,
  CLOUD_ROTATION_SPEED,
  SUN_DIRECTION,
} from "@/lib/three/globeSceneConfig";

const SKY_MAP_WIDTH = 256;
const SKY_MAP_HEIGHT = 128;
const SKY_UPDATE_INTERVAL = 30;

/* ------------------------------------------------------------------ */
/*  Sky evaluation shader                                              */
/* ------------------------------------------------------------------ */

const SKY_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  precision highp float;
  const float PI = 3.141592653589793;

  uniform vec3      uSunDirection;
  uniform vec3      uRayleighTint;
  uniform vec3      uMieTint;
  uniform vec3      uTwilightTint;
  uniform sampler2D uCloudMap;
  uniform float     uCloudOffset;
  uniform float     uCloudInfluence;

  varying vec2 vUv;

  void main() {
    // UV → world direction (inverse of sphericalUv from earth shader)
    float lon = (vUv.x - 0.5) * 2.0 * PI;
    float lat = (vUv.y - 0.5) * PI;
    vec3 dir = normalize(vec3(
      cos(lat) * cos(lon),
      sin(lat),
      -cos(lat) * sin(lon)
    ));

    vec3  sun   = normalize(uSunDirection);
    float NdotL = dot(dir, sun);

    // Masks matching the atmosphere shader
    float dayMask  = smoothstep(-0.15, 0.35, NdotL);
    float twilight = smoothstep(-0.22, 0.05, NdotL)
                   * (1.0 - smoothstep(0.05, 0.22, NdotL));
    float nightMask = 1.0 - smoothstep(-0.15, 0.10, NdotL);

    // Rayleigh scatter — blue day sky
    vec3 color = uRayleighTint * dayMask * 0.55;

    // Mie forward scatter — warm glow near sun
    float sunAlign = max(dot(dir, sun), 0.0);
    color += uMieTint * pow(sunAlign, 6.0) * 0.42;

    // Twilight band — warm orange at terminator
    color += uTwilightTint * twilight * 0.48;

    // Horizon brightening (limb-like scatter at low elevations)
    float horizonBoost = pow(max(1.0 - abs(dir.y), 0.0), 3.0);
    color += uRayleighTint * horizonBoost * dayMask * 0.12;

    // Night suppression
    color *= mix(1.0, 0.02, nightMask);

    // Cloud influence on sky — dims clear sky, adds diffuse scatter
    if (uCloudInfluence > 0.01) {
      vec2 cloudUv = vec2(fract(vUv.x + uCloudOffset), vUv.y);
      float cloud     = texture2D(uCloudMap, cloudUv).a;
      float cloudMask = smoothstep(0.3, 0.7, cloud);
      vec3  cloudScatter = vec3(0.65, 0.68, 0.72) * dayMask * 0.25;
      color = mix(color, cloudScatter, cloudMask * uCloudInfluence * 0.4);
    }

    gl_FragColor = vec4(color, 1.0);
  }
`;

/* ------------------------------------------------------------------ */
/*  Sky capture internals                                              */
/* ------------------------------------------------------------------ */

interface SkyCaptureState {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  material: THREE.ShaderMaterial;
  target: THREE.WebGLRenderTarget;
  dispose: () => void;
}

function createSkyCapture(): SkyCaptureState {
  const target = new THREE.WebGLRenderTarget(SKY_MAP_WIDTH, SKY_MAP_HEIGHT, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
  });

  const material = new THREE.ShaderMaterial({
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uSunDirection:  { value: SUN_DIRECTION.clone().normalize() },
      uRayleighTint:  { value: ATMOSPHERE_RAYLEIGH_TINT.clone() },
      uMieTint:       { value: ATMOSPHERE_MIE_TINT.clone() },
      uTwilightTint:  { value: ATMOSPHERE_TWILIGHT_TINT.clone() },
      uCloudMap:      { value: null as Texture | null },
      uCloudOffset:   { value: 0 },
      uCloudInfluence: { value: 0 },
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

interface UseSkyCapturePrams {
  /** Cloud coverage texture (clouds.png). Null disables cloud influence. */
  cloudTexture: Texture | null;
  /** Whether to render to the sky map. False skips the render pass. */
  enabled: boolean;
}

/**
 * Creates and maintains a sky map render target. Always returns a valid
 * Texture (the render target texture) so the EarthMaterial reference
 * stays stable across enable/disable toggles — no material recreation.
 *
 * When `enabled` is false the render pass is skipped but the texture
 * object still exists (contains stale or black content). The earth
 * shader checks `uUseSkyMap` to decide whether to sample it.
 */
export function useSkyCapture({
  cloudTexture,
  enabled,
}: UseSkyCapturePrams): Texture {
  const { gl } = useThree();
  const frameRef = useRef(0);
  const offsetRef = useRef(0);
  const hasRenderedRef = useRef(false);

  const capture = useMemo(() => createSkyCapture(), []);

  useEffect(() => {
    return () => capture.dispose();
  }, [capture]);

  useFrame((_, delta) => {
    // Always advance cloud offset to stay in sync with the main clouds
    const speed = CLOUD_ROTATION_SPEED * 0.16;
    offsetRef.current = ((offsetRef.current - delta * speed) % 1 + 1) % 1;

    if (!enabled) return;

    // Phase 7B hardening: capture on the first enabled frame so the
    // earth shader never reads an uninitialized black RT. After that,
    // capture every SKY_UPDATE_INTERVAL frames.
    const isFirst = !hasRenderedRef.current;
    frameRef.current++;
    if (!isFirst && frameRef.current % SKY_UPDATE_INTERVAL !== 0) return;
    hasRenderedRef.current = true;

    // Update uniforms
    const u = capture.material.uniforms;
    u.uSunDirection.value.copy(SUN_DIRECTION).normalize();
    u.uCloudMap.value = cloudTexture;
    u.uCloudOffset.value = offsetRef.current;
    u.uCloudInfluence.value = cloudTexture ? 0.6 : 0.0;

    // Render sky to offscreen target
    const prevTarget = gl.getRenderTarget();
    gl.setRenderTarget(capture.target);
    gl.clear();
    gl.render(capture.scene, capture.camera);
    gl.setRenderTarget(prevTarget);
  }, -1); // Priority -1: render sky before the main scene reads it

  return capture.target.texture;
}
