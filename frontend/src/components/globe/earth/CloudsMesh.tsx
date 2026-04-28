"use client";

import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Texture } from "three";

import {
  ATMOSPHERE_RAYLEIGH_TINT,
  ATMOSPHERE_TWILIGHT_TINT,
  CLOUD_RADIUS,
  CLOUD_ROTATION_SPEED,
  SCENE_RENDER_ORDER,
  SUN_DIRECTION,
} from "@/lib/three/globeSceneConfig";

interface CloudsMeshProps {
  texture: Texture;
  /** Phase 8A — land/ocean mask texture (specular.r works as an ocean mask). */
  landMask: Texture;
  radius?: number;
  segments?: number;
  freezeMotion?: boolean;
  opacity?: number;
  uvSpeed?: number;
  offsetBias?: number;
}

const vertexShader = `
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

// Physically-inspired cloud shading:
//  - Mie forward scattering: brighter toward the sun
//  - Multiple-scatter approximation: darker shadowed underside
//  - Silver lining: bright rim on sun-facing edges of cloud mass
//  - Soft depth: thicker clouds block more, thin wispy edges are translucent
const fragmentShader = `
  uniform sampler2D uCloudMap;
  uniform sampler2D uLandMask;
  uniform float uOffset;
  uniform float uOpacity;
  uniform float uAdvectionTime;
  uniform vec3 uSunDirection;
  uniform vec3 uAtmosphereTwilightTint;
  uniform vec3 uAtmosphereRayleighTint;

  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  const float PI = 3.141592653589793;

  float saturate(float v) { return clamp(v, 0.0, 1.0); }

  float sampleMask(vec2 uv) {
    return texture2D(uCloudMap, uv).a;
  }

  vec2 sphericalUv(vec3 normal) {
    vec3 n = normalize(normal);
    float lon = atan(-n.z, n.x);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    return vec2(fract(lon / (2.0 * PI) + 0.5), lat / PI + 0.5);
  }

  float sampleCloudMask(vec2 uv) {
    float broad  = sampleMask(uv);
    float detail = sampleMask(vec2(fract(uv.x * 1.017 + 0.0032), clamp(uv.y + 0.0024, 0.0, 1.0)));
    float raw = mix(broad, detail, 0.32);
    float fw = fwidth(raw) * 1.5;
    return smoothstep(0.08 - fw, 0.52 + fw, raw);
  }

  void main() {
    vec3 n = normalize(vWorldPosition);
    vec2 uv = sphericalUv(n);
    vec2 scrolledUv = vec2(fract(uv.x + uOffset), uv.y);

    // Phase 7.9C / 8A — geographic climate modulation (low-quality path).
    // Pure math for most bands, plus a single texture read for the real
    // Earth land/ocean mask (Phase 8A parity with the volumetric shader).
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float absLat = abs(lat);
    float lon = atan(-n.z, n.x);

    // Phase 8A — land/ocean sample. specular.r is already an ocean mask.
    vec2 landUv = vec2(fract(lon / (2.0 * PI) + 0.5), lat / PI + 0.5);
    float oceanicness = smoothstep(0.10, 0.72, texture2D(uLandMask, landUv).r);

    // Phase 8A — latitude-dependent eastward advection for the scrolled
    // cloud UV. Mid-latitudes drift fastest (jet-stream effect).
    float advectRate = 0.22
                     + smoothstep(0.12, 0.70, absLat)
                       * (1.0 - smoothstep(1.05, 1.38, absLat)) * 0.85;
    vec2 advectedUv = vec2(
      fract(scrolledUv.x + uAdvectionTime * 0.00018 * advectRate / (2.0 * PI)),
      scrolledUv.y
    );

    float hemShift = sign(n.y + 0.001) * 0.4;
    float lonPhase = lon + hemShift;
    float continentalDry = max(sin(lonPhase * 1.5 + 0.8), 0.0)
                         * smoothstep(0.12, 0.48, absLat)
                         * (1.0 - smoothstep(0.90, 1.20, absLat)) * 0.04;
    float oceanicWet = max(sin(lonPhase * 1.5 + 0.8 + PI), 0.0)
                     * exp(-pow(absLat - 0.82, 2.0) / 0.040) * 0.05;

    float warmPoolLon = max(sin(lon * 1.0 - 1.2), 0.0);
    float itcz = exp(-absLat * absLat / 0.020) * 0.18 * (1.0 + warmPoolLon * 0.30)
               * mix(0.85, 1.15, oceanicness);
    float midStorm = exp(-pow(absLat - 0.82, 2.0) / 0.030) * 0.22
                   + oceanicWet
                   + oceanicness * exp(-pow(absLat - 0.82, 2.0) / 0.040) * 0.04;
    float subtropCalm = exp(-pow(absLat - 0.44, 2.0) / 0.022) * 0.08 + continentalDry;
    float polarFront = exp(-pow(absLat - 1.10, 2.0) / 0.045) * 0.10
                     * (1.0 + step(-0.1, -n.y) * 0.30);

    // Phase 8A — explicit ocean wet lift / land interior dry dip, matching
    // the volumetric shader so the low-quality tier keeps the same overall
    // weather character over land vs ocean.
    float oceanWetLift = oceanicness
                       * (0.030 + exp(-pow(absLat - 0.82, 2.0) / 0.040) * 0.050);
    float landDryDip   = (1.0 - oceanicness)
                       * smoothstep(0.12, 0.55, absLat)
                       * (1.0 - smoothstep(1.05, 1.30, absLat))
                       * 0.055;
    float climateBias = itcz + midStorm + polarFront - subtropCalm + oceanWetLift - landDryDip;

    float rawMask = sampleCloudMask(advectedUv);
    float cloudMask = clamp(rawMask + climateBias, 0.0, 1.0);
    if (cloudMask < 0.06) discard;

    vec3 worldNormal = normalize(vWorldNormal);
    vec3 sunDirection = normalize(uSunDirection);
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);

    // Phase 4 Part 1 — signed sun cosine drives the spectral twilight and
    // the night suppression. The saturated version is still used for the
    // bright-side math below so nothing else has to change.
    float sunFacingSigned = dot(worldNormal, sunDirection);
    float sunFacing  = saturate(sunFacingSigned);
    float backFacing = 1.0 - sunFacing;
    float NdotV      = saturate(dot(worldNormal, viewDir));

    // Spectral twilight arc — matches the earth shader exactly. Narrow
    // belt centered on the terminator, drives a warm tint on the cloud
    // tops in civil/nautical dusk.
    float cloudTwilight = smoothstep(-0.22, 0.05, sunFacingSigned)
                          * (1.0 - smoothstep(0.05, 0.22, sunFacingSigned));
    // Deep-night mask — used to suppress clouds on the unlit hemisphere.
    // Premium brief: the dark side should look calm and quiet, with only
    // a hint of clouds visible along the moonlit limb if at all.
    float cloudNight = 1.0 - smoothstep(-0.18, 0.02, sunFacingSigned);

    // Rim: how much we're looking through the edge of the cloud shell
    float rim = pow(1.0 - NdotV, 2.8);

    // Phase 5 Part 1 — pseudo-volumetric depth.
    // (a) Parallax: at grazing angles, sample cloud density at a
    //     view-shifted position. Merging with the original mask via max
    //     simulates looking through a thick cloud body at the limb.
    vec3 viewShiftedPos = normalize(vWorldPosition - viewDir * rim * 0.018);
    vec2 viewShiftedUv = sphericalUv(viewShiftedPos);
    viewShiftedUv.x = fract(viewShiftedUv.x + uOffset);
    float depthSample = smoothstep(0.26, 0.76, sampleMask(viewShiftedUv));
    cloudMask = mix(cloudMask, max(cloudMask, depthSample), rim * 0.60);
    // (b) Pseudo self-shadowing: sample along the sun direction to
    //     estimate how much cloud the light traversed before reaching
    //     this fragment. Gives the "dark core, bright edge" look.
    vec3 sunShiftedPos = normalize(vWorldPosition + sunDirection * 0.024);
    vec2 sunShiftedUv = sphericalUv(sunShiftedPos);
    sunShiftedUv.x = fract(sunShiftedUv.x + uOffset);
    float sunShadowDensity = smoothstep(0.30, 0.80, sampleMask(sunShiftedUv));
    float selfShadow = 1.0 - sunShadowDensity * 0.50 * sunFacing;

    // Mie forward-scatter: clouds glow brighter when sun is behind them
    float viewSunAlign = saturate(dot(-viewDir, sunDirection));
    float mieForward   = pow(viewSunAlign, 6.0) * sunFacing;

    // Silver lining: bright edge where sun rays graze thin cloud coverage.
    // Phase 5: uses a softer sun gate + a separate terminator lining term
    // so the "illuminated from within" feel activates at civil/nautical
    // dusk, not just on the bright day side.
    float silverSunGate = saturate(sunFacingSigned * 4.0 + 0.5);
    float silverBase = pow(rim, 3.0) * silverSunGate * smoothstep(0.08, 0.55, cloudMask) * (1.0 - cloudMask * 0.4);
    float terminatorLining = pow(rim, 2.5) * cloudTwilight * smoothstep(0.12, 0.50, cloudMask) * 0.45;
    float silverLine = silverBase + terminatorLining;

    // Phase 19C.3 — base alpha lifted so the cloud body reads as visible
    // cover at orbit framing rather than a smear. The day-side floor is
    // raised to 0.85 so even at a moderate sun-facing fraction the
    // clouds stay legible; rim and Mie forward-scatter still add
    // photographic punch on the limb.
    float alpha = cloudMask * uOpacity * (0.85 + sunFacing * 0.28 + rim * 0.22 + mieForward * 0.15);
    // Phase 4 Part 1 — suppress clouds on the night hemisphere. 0.90 is
    // intentionally aggressive: the unlit side should feel quiet, not
    // draped in ghostly gray clouds. A small residual (10%) keeps the
    // limb rim legible where moonlight would feasibly glance off tops.
    alpha *= mix(1.0, 0.10, cloudNight);
    if (alpha < 0.028) discard;

    // Phase 19C.2 — clouds read luminous and clean, not smoky.
    // Lifted shadow + belly tones so cloud bodies stay white-ish even on the
    // dim side; the deep sun-facing white is unchanged so the brightest
    // tops still pop. Shadow side is a slightly cool light gray rather than
    // a saturated blue-gray, which previously read as muddy at orbit.
    // Phase 19C.3 — sunlit tops sit at near-1.0 luminance so the day-side
    // cloud body reads as a clean luminous white in screenshots. Shadow
    // and belly tones stay bright enough that the unlit underside never
    // crushes to muddy gray.
    vec3 litColor    = vec3(1.00, 1.00, 1.00);                      // sun-facing: pure white
    vec3 shadowColor = vec3(0.72, 0.76, 0.82);                      // shadow-side: cool light gray
    vec3 bellyColor  = vec3(0.78, 0.78, 0.80);                      // underside: neutral light gray

    float shadowBlend  = pow(backFacing, 2.0);
    float bellyBlend   = pow(1.0 - abs(sunFacing - 0.5) * 2.0, 2.2) * backFacing;
    vec3  color = mix(mix(litColor, shadowColor, shadowBlend * 0.72), bellyColor, bellyBlend * 0.35);

    // Phase 5 Part 1 — apply pseudo self-shadow to the cloud body.
    // Silver lining is applied AFTER this so bright edges survive.
    color *= selfShadow;

    // Backscatter: thin warm tint when sun shines through
    color += vec3(0.18, 0.14, 0.06) * backFacing * cloudMask * 0.06;

    // Silver lining contribution
    color = mix(color, vec3(1.0, 0.98, 0.96), silverLine * 0.55);

    // Phase 4 Part 1 — shared-palette coupling so cloud tops agree with
    // the atmosphere and earth surface at the terminator. The warm
    // twilight tint lifts the sunset arc without introducing a new colour
    // band; the subtle Rayleigh cool on the shadow cheek breaks the
    // uniform "gray slab" look on the day-to-night shoulder.
    color = mix(color, color * uAtmosphereTwilightTint * 1.18, cloudTwilight * 0.42);
    color = mix(color, color * uAtmosphereRayleighTint * 1.05, shadowBlend * 0.08 * sunFacing);

    gl_FragColor = vec4(color, alpha);
  }
`;

export function CloudsMesh({
  texture,
  landMask,
  radius = CLOUD_RADIUS,
  segments = 160,
  freezeMotion = false,
  opacity = 0.55,
  uvSpeed = CLOUD_ROTATION_SPEED * 0.16,
  offsetBias = 0,
}: CloudsMeshProps) {
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const material = useMemo(() => {
    texture.colorSpace = THREE.NoColorSpace;
    landMask.colorSpace = THREE.NoColorSpace;

    const shaderMaterial = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      alphaTest: 0.06,
      side: THREE.FrontSide,
      uniforms: {
        uCloudMap:    { value: texture },
        uLandMask:    { value: landMask },
        uOffset:      { value: offsetBias },
        uOpacity:     { value: opacity },
        uAdvectionTime: { value: 0 },
        uSunDirection:{ value: SUN_DIRECTION.clone().normalize() },
        uAtmosphereTwilightTint: { value: ATMOSPHERE_TWILIGHT_TINT.clone() },
        uAtmosphereRayleighTint: { value: ATMOSPHERE_RAYLEIGH_TINT.clone() },
      },
    });

    materialRef.current = shaderMaterial;
    return shaderMaterial;
  }, [texture, landMask, opacity, offsetBias]);

  useFrame((_, delta) => {
    if (!materialRef.current) return;
    if (!freezeMotion) {
      materialRef.current.uniforms.uOffset.value =
        ((materialRef.current.uniforms.uOffset.value - delta * uvSpeed) % 1 + 1) % 1;
      materialRef.current.uniforms.uAdvectionTime.value += delta;
    }
    materialRef.current.uniforms.uSunDirection.value.copy(SUN_DIRECTION).normalize();
  });

  useEffect(() => {
    return () => {
      material.dispose();
      materialRef.current = null;
    };
  }, [material]);

  return (
    <mesh scale={[radius, radius, radius]} renderOrder={SCENE_RENDER_ORDER.clouds}>
      <sphereGeometry args={[1, segments, segments]} />
      <primitive attach="material" object={material} />
    </mesh>
  );
}
