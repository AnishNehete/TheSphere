"use client";

import * as THREE from "three";
import { useEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";

import {
  ATMOSPHERE_DAY_COLOR,
  ATMOSPHERE_NIGHT_COLOR,
  ATMOSPHERE_RADIUS,
  SCENE_RENDER_ORDER,
  SUN_DIRECTION,
} from "@/lib/three/globeSceneConfig";

/**
 * AerialPerspective — front-facing atmosphere shell.
 *
 * Complements the existing BackSide rim glow (AtmosphereMesh) by adding
 * a thin Rayleigh-like haze across the entire visible hemisphere.  The
 * effect is strongest at the limb (grazing angles) and vanishes at the
 * sub-camera point, giving the globe a sense of atmospheric depth and
 * thickness rather than a flat texture with an edge glow.
 *
 * Physically inspired by:
 *  - Rayleigh scattering: blue haze on day side, deeper blue at the limb
 *  - Optical depth: longer path through atmosphere at grazing angles
 *  - Day/night transition: haze fades on the night side
 */

const vertexShader = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec3 vViewDir;
  varying vec3 vWorldPosition;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform vec3 uSunDirection;
  uniform vec3 uDayColor;
  uniform vec3 uNightColor;
  uniform float uIntensity;
  uniform float uFalloff;
  uniform float uDayBoost;

  varying vec3 vWorldNormal;
  varying vec3 vViewDir;
  varying vec3 vWorldPosition;

  void main() {
    vec3 normal  = normalize(vWorldNormal);
    vec3 viewDir = normalize(vViewDir);
    vec3 sunDir  = normalize(uSunDirection);

    // How much this fragment faces away from the camera (limb factor)
    float NdotV = max(dot(normal, viewDir), 0.0);

    // Optical depth proxy: longer path through atmosphere at grazing angles
    // Uses a physically-motivated power curve for the falloff
    float opticalDepth = pow(1.0 - NdotV, uFalloff);

    // Day/night blend — haze is visible mainly on the sunlit hemisphere
    float sunFacing = dot(normal, sunDir);
    float dayMask   = smoothstep(-0.15, 0.4, sunFacing);
    float nightMask = smoothstep(0.1, -0.3, sunFacing);

    // Color: blue Rayleigh scatter on day side, deep navy on night side
    vec3 hazeColor = mix(uNightColor * 0.3, uDayColor, dayMask);

    // Add subtle warm terminator tint
    float terminatorBand = pow(
      clamp(1.0 - abs(sunFacing) * 1.6, 0.0, 1.0),
      3.0
    );
    hazeColor += vec3(0.12, 0.06, 0.02) * terminatorBand * 0.4;

    // Forward scatter: subtle brightening when looking toward the sun
    float viewSunAlign = clamp(dot(-viewDir, sunDir), 0.0, 1.0);
    float forwardScatter = pow(viewSunAlign, 8.0) * dayMask * 0.15;

    // Final alpha: optical depth * intensity, boosted on day side
    float alpha = opticalDepth * uIntensity;
    alpha *= mix(0.3, 1.0, dayMask * uDayBoost);
    alpha += forwardScatter;

    // Suppress the very center of the visible disk to avoid washing out detail
    float centerSuppression = smoothstep(0.92, 0.65, NdotV);
    alpha *= centerSuppression;

    // Clamp to keep the effect subtle
    alpha = clamp(alpha, 0.0, 0.18);

    gl_FragColor = vec4(hazeColor, alpha);
  }
`;

interface AerialPerspectiveProps {
  segments?: number;
  intensity?: number;
}

export function AerialPerspective({
  segments = 128,
  intensity = 0.12,
}: AerialPerspectiveProps) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        side: THREE.FrontSide,
        blending: THREE.NormalBlending,
        depthTest: true,
        depthWrite: false,
        uniforms: {
          uSunDirection: { value: SUN_DIRECTION.clone().normalize() },
          uDayColor:     { value: ATMOSPHERE_DAY_COLOR.clone() },
          uNightColor:   { value: ATMOSPHERE_NIGHT_COLOR.clone() },
          uIntensity:    { value: intensity },
          uFalloff:      { value: 3.2 },
          uDayBoost:     { value: 1.0 },
        },
      }),
    [intensity]
  );

  useFrame(({ camera }) => {
    material.uniforms.uSunDirection.value.copy(SUN_DIRECTION).normalize();
  });

  useEffect(() => {
    return () => {
      material.dispose();
    };
  }, [material]);

  // Slightly above the globe surface but below the clouds
  const shellRadius = ATMOSPHERE_RADIUS * 0.995;

  return (
    <mesh scale={shellRadius} renderOrder={SCENE_RENDER_ORDER.atmosphere + 1}>
      <sphereGeometry args={[1, segments, segments]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}
