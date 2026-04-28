"use client";

// borderLineMaterial
// ------------------
// Shared shader material factory used by both the default country borders
// and the hover/selected outlines.
//
// Why a custom shader instead of LineBasicMaterial:
//   1. Back-face culling for line segments. LineBasicMaterial has no
//      concept of "front-facing" for a line on a sphere, so borders on
//      the far side of the globe bleed through the planet and give the
//      scene a wireframe-shell feel. This shader kills segments whose
//      surface normal faces away from the camera (frontFadeStart/End).
//   2. Day/night awareness. The unlit hemisphere must look calm and
//      premium — hard white borders there break the illusion. The
//      nightFadeStrength uniform smoothly dims segments in shadow.
//   3. Tone-mapping opt-out (`toneMapped: false`). Post-processing
//      (ACES + bloom) would otherwise crush and exaggerate the linework,
//      making borders look either washed out or decoratively glowing,
//      both of which violate the premium brief.
//
// Contract for future agents: any change to these uniforms must be
// verified against both a wide-framing view and a closeup hover view.
// See docs/ui/globe-borders.md.

import { Color, ShaderMaterial, Vector3 } from "three";

import { SUN_DIRECTION } from "@/lib/three/globeSceneConfig";

interface BorderLineMaterialOptions {
  color: string;
  // Peak opacity at a fully front-facing, fully lit segment. The actual
  // rendered alpha is further modulated per-pixel by the fragment shader.
  opacity: number;
  // Dot(normal, viewDir) window used to fade back-facing segments.
  // frontFadeStart < frontFadeEnd. Values ~0.0–0.25 work well on a
  // unit sphere at typical camera distances.
  frontFadeStart: number;
  frontFadeEnd: number;
  // How aggressively segments in shadow are dimmed. 0 = no night fade,
  // 1 = borders invisible on the unlit side.
  nightFadeStrength: number;
}

const BORDER_VERTEX_SHADER = `
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * position);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const BORDER_FRAGMENT_SHADER = `
  uniform vec3 uColor;
  uniform vec3 uSunDirection;
  uniform float uOpacity;
  uniform float uFrontFadeStart;
  uniform float uFrontFadeEnd;
  uniform float uNightFadeStrength;

  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  float clamp01(float value) {
    return clamp(value, 0.0, 1.0);
  }

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    vec3 sunDirection = normalize(uSunDirection);

    float frontFacing = dot(normal, viewDirection);
    float frontFade = smoothstep(uFrontFadeStart, uFrontFadeEnd, frontFacing);
    float daylight = smoothstep(-0.12, 0.32, dot(normal, sunDirection));
    float lightFade = mix(1.0 - uNightFadeStrength, 1.0, daylight);
    // Phase 3.7 Part 5 + Phase 4 Part 6 — two-stage atmosphere fade.
    // (1) Sharp pow(3) term matches the earth shader's horizon coupling,
    //     dissolving borders inside the true atmosphere column.
    // (2) Broader pow(2) term starts the fade earlier so borders never
    //     read as a crisp wireframe rim against the lit globe — they
    //     lose density BEFORE the limb instead of only AT the limb.
    float horizonSharp = pow(1.0 - clamp01(frontFacing), 3.0);
    float horizonBroad = pow(1.0 - clamp01(frontFacing), 2.0);
    float atmosphereFade = 1.0 - horizonSharp * 0.60 - horizonBroad * 0.20;
    atmosphereFade = max(atmosphereFade, 0.0);
    // Phase 5 Part 7 — glint-zone fade. Where the sun would specularly
    // reflect off the ocean, fade borders out so they don't read as a
    // mesh stamped on top of a bright glint belt.
    vec3 reflectedSun = reflect(-sunDirection, normal);
    float glintProximity = pow(max(dot(reflectedSun, viewDirection), 0.0), 4.0);
    float glintFade = 1.0 - glintProximity * 0.40;
    float alpha = uOpacity * frontFade * lightFade * atmosphereFade * glintFade;

    if (alpha < 0.01) {
      discard;
    }

    gl_FragColor = vec4(uColor, alpha);
  }
`;

export function createBorderLineMaterial(options: BorderLineMaterialOptions) {
  return new ShaderMaterial({
    vertexShader: BORDER_VERTEX_SHADER,
    fragmentShader: BORDER_FRAGMENT_SHADER,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      uColor: { value: new Color(options.color) },
      uSunDirection: { value: SUN_DIRECTION.clone().normalize() as Vector3 },
      uOpacity: { value: options.opacity },
      uFrontFadeStart: { value: options.frontFadeStart },
      uFrontFadeEnd: { value: options.frontFadeEnd },
      uNightFadeStrength: { value: options.nightFadeStrength },
    },
  });
}
