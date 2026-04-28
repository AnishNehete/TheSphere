import { AdditiveBlending, BackSide, Color, ShaderMaterial, Vector3 } from "three";

import {
  ATMOSPHERE_MIE_TINT,
  ATMOSPHERE_RAYLEIGH_TINT,
  ATMOSPHERE_TWILIGHT_TINT,
  GLOBE_RADIUS,
} from "@/lib/three/globeSceneConfig";

const ATMOSPHERE_VERTEX_SHADER = `
  varying vec3 vWorldNormal;
  varying vec3 vViewDirection;
  varying vec3 vWorldPosition;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vViewDirection = normalize(cameraPosition - worldPosition.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const ATMOSPHERE_FRAGMENT_SHADER = `
  precision highp float;

  uniform vec3 uSunDirection;
  uniform vec3 uRayleighColor;
  uniform vec3 uMieColor;
  uniform vec3 uTwilightColor;
  uniform vec3 uPurpleColor;
  uniform vec3 uNightColor;
  uniform float uRayleighIntensity;
  uniform float uMieIntensity;
  uniform float uMieG;
  uniform float uHorizonFalloff;
  uniform float uEdgeSharpness;
  uniform float uDarkSideSuppression;
  uniform float uTwilightSharpness;
  uniform float uSunBoost;
  uniform float uAlphaScale;
  uniform float uIntensity;
  uniform float uPlanetRadius;

  varying vec3 vWorldNormal;
  varying vec3 vViewDirection;
  varying vec3 vWorldPosition;

  const float PI = 3.141592653589793;
  const float HR = 0.08;
  const float HM = 0.012;

  float clamp01(float v) { return clamp(v, 0.0, 1.0); }

  // Rayleigh phase: symmetric blue-sky scattering
  float phaseRayleigh(float mu) {
    return 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  }

  // Henyey-Greenstein Mie phase: forward-peaked sun glare
  float phaseMie(float mu, float g) {
    float g2 = g * g;
    float denom = pow(1.0 + g2 - 2.0 * g * mu, 1.5);
    return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * max(denom, 1e-4));
  }

  // Cheap transmittance: longer optical path at grazing angles absorbs more
  vec3 transmittance(float NdV, float h) {
    float opticalDepth = (1.0 - NdV) * 4.2 + h * 12.0;
    vec3 betaR = vec3(5.8e-3, 1.35e-2, 3.31e-2);
    return exp(-betaR * opticalDepth);
  }

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 viewDir = normalize(vViewDirection);
    vec3 sunDir = normalize(uSunDirection);

    float h = max(length(vWorldPosition) - uPlanetRadius, 0.0);
    float rhoR = exp(-h / HR);
    float rhoM = exp(-h / HM);

    float NdV = clamp01(dot(normal, viewDir));
    float NdL = dot(normal, sunDir);
    float mu = dot(viewDir, sunDir);

    // Limb fresnel
    float fresnel = pow(1.0 - NdV, uHorizonFalloff);

    // Transmittance tints long optical paths warm (removes blue at horizon edges)
    vec3 T = transmittance(NdV, h);

    // Sun illumination bands
    float daylight = smoothstep(-0.25, 0.15, NdL);
    float nightside = smoothstep(-0.35, -0.05, NdL);

    // --- Rayleigh ---
    float rayleighPhase = phaseRayleigh(mu);
    vec3 rayleigh = uRayleighColor * fresnel * rayleighPhase * daylight * rhoR * uRayleighIntensity;
    rayleigh *= T;

    // Fake multi-scattering: isotropic low-frequency fill on the day side
    // Real multi-scattering wraps light around the terminator; this approximates
    // that by adding a broad, un-phased Rayleigh fill at reduced intensity.
    vec3 multiScatter = uRayleighColor * fresnel * daylight * rhoR * 0.12;
    multiScatter *= mix(vec3(1.0), T, 0.5);

    // --- Mie ---
    float miePhase = phaseMie(mu, uMieG);
    float mieDayMask = smoothstep(-0.15, 0.05, NdL);
    vec3 mie = uMieColor * fresnel * miePhase * rhoM * mieDayMask * uMieIntensity;

    // --- Phase 3.7 — smooth spectral twilight band ---
    // Replaces the Phase 2.5 multi-band orange+purple twilight with a single
    // smoothstep-based transition. The terminator arc now blends Rayleigh blue
    // into the warm twilight tint as NdL crosses zero, producing a continuous
    // spectral sweep rather than a hard crimson ring at the limb.
    //
    // The band is strongest only where the sun is actually near the horizon
    // (|NdL| ≲ 0.2). Outside that window the value is zero, so day pixels are
    // unaffected and night pixels don't pick up a false sunrise color.
    float twilight = smoothstep(-0.2, 0.05, NdL) * (1.0 - smoothstep(0.05, 0.2, NdL));
    vec3 twilightSpectrum = mix(uRayleighColor, uTwilightColor, twilight);
    vec3 warmTerminator = twilightSpectrum * fresnel * twilight * 0.34;

    // The old astronomical-twilight purple band is deliberately retired in
    // Phase 3.7 — it was stacking onto the warm band as a second hard arc,
    // which read as a crimson halo once bloom and additive blending compounded
    // it. A very faint residual is kept on deep dusk only, but this is small
    // enough that it never reads as a colored band of its own.
    float twilightPurple = pow(
      clamp01(smoothstep(-0.05, -0.24, NdL) * smoothstep(-0.34, -0.09, NdL)),
      uTwilightSharpness * 0.55
    );
    vec3 coolTerminator = uPurpleColor * fresnel * twilightPurple * 0.08;

    // --- Night rim ---
    vec3 nightRim = uNightColor * fresnel * nightside * 0.12;

    // --- Sun halo ---
    // Broad warm haze (pow 6) + tight hot core (pow 14)
    float haloBroad = pow(clamp01(mu), 6.0) * fresnel * uSunBoost;
    float haloCore = pow(clamp01(mu), 14.0) * fresnel * uSunBoost * 0.6;
    vec3 sunHalo = uMieColor * (haloBroad * 0.28 + haloCore * 0.18);

    // --- Combine ---
    vec3 color = rayleigh + multiScatter + mie + warmTerminator + coolTerminator + nightRim + sunHalo;

    // Dark-side suppression: smooth cubic falloff, not a hard cut
    float darkMask = nightside * uDarkSideSuppression;
    color *= 1.0 - darkMask * darkMask;

    // Alpha
    float edgeMask = pow(fresnel, 1.0 / max(uEdgeSharpness, 0.1));
    float twilightBand = (1.0 - daylight) * (1.0 - nightside);
    float alpha = edgeMask * uAlphaScale * uIntensity;
    alpha *= 0.18 + daylight * 0.58 + twilightBand * 0.24;
    alpha = clamp01(alpha);

    if (alpha < 0.001) {
      discard;
    }

    gl_FragColor = vec4(color, alpha);
  }
`;

export function createAtmosphereMaterial(sunDirection: Vector3): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: ATMOSPHERE_VERTEX_SHADER,
    fragmentShader: ATMOSPHERE_FRAGMENT_SHADER,
    transparent: true,
    side: BackSide,
    depthTest: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uSunDirection: { value: sunDirection.clone().normalize() },
      // Phase 3.5: Rayleigh/Mie/Twilight sourced from the shared scatter palette
      // so the atmosphere and earth shaders agree byte-for-byte. Purple/Night bands
      // are atmosphere-only and stay inline (not consumed by the earth surface pass).
      uRayleighColor: { value: ATMOSPHERE_RAYLEIGH_TINT.clone() },
      uMieColor: { value: ATMOSPHERE_MIE_TINT.clone() },
      uTwilightColor: { value: ATMOSPHERE_TWILIGHT_TINT.clone() },
      uPurpleColor: { value: new Color("#6e63d9") },
      uNightColor: { value: new Color("#17305f") },
      // Phase 3.7 — tuning pulled in slightly. The previous Rayleigh intensity
      // (2.35) was correct in isolation but compounded with the surface
      // coupling into a saturated blue/violet limb. A 15% drop preserves the
      // day-side sky color while letting the ocean Fresnel read cleanly.
      uRayleighIntensity: { value: 2.0 },
      uMieIntensity: { value: 1.1 },
      uMieG: { value: 0.82 },
      uHorizonFalloff: { value: 3.6 },
      uEdgeSharpness: { value: 1.45 },
      uDarkSideSuppression: { value: 0.9 },
      uTwilightSharpness: { value: 2.1 },
      uSunBoost: { value: 0.38 },
      uAlphaScale: { value: 0.30 },
      uIntensity: { value: 1.0 },
      uPlanetRadius: { value: GLOBE_RADIUS },
    },
  });
}
