import { Color, NoColorSpace, SRGBColorSpace, Texture, Vector3 } from "three";

import {
  ATMOSPHERE_MIE_TINT,
  ATMOSPHERE_RADIUS,
  ATMOSPHERE_RAYLEIGH_TINT,
  ATMOSPHERE_TWILIGHT_TINT,
  GLOBE_RADIUS,
} from "@/lib/three/globeSceneConfig";

export type EarthDebugView = "default" | "uv" | "day" | "normal" | "specular";

interface EarthShaderTextureInput {
  dayMap: Texture;
  nightMap: Texture;
  normalMap: Texture;
  specularMap: Texture;
  cloudShadowMap?: Texture | null;
  /**
   * Phase 8B — sampled climatology (createClimatologyTexture). Same
   * texture as the volumetric shader consumes; sharing it keeps the
   * shadow mask aligned with the visible cloud corridors rather than
   * drifting against the analytic heuristic alone.
   */
  climatologyMap?: Texture | null;
  /**
   * Phase 9A — live cloud-coverage RT produced by the volumetric
   * weather pipeline. When provided, shadow sampling routes through
   * this texture instead of the flat cloud alpha + analytic bias.
   */
  cloudCoverageRT?: Texture | null;
}

interface EarthShaderUniformInput extends EarthShaderTextureInput {
  sunDirection: Vector3;
  debugView?: EarthDebugView;
  // Phase 7B — sky-captured ocean reflection. When provided, the earth
  // shader samples this equirectangular RT at the reflected view direction
  // for the ocean's sky reflection term instead of the analytical scatter.
  skyMap?: Texture | null;
  cloudShadow?: {
    enabled?: boolean;
    time?: number;
    strength?: number;
    softness?: number;
    dayFade?: number;
    darken?: number;
    layers?: readonly {
      offset?: number;
      seed?: number;
      weight?: number;
    }[];
  };
}

export const EARTH_VERTEX_SHADER = `
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

export const EARTH_FRAGMENT_SHADER = `
  precision highp float;

  uniform sampler2D uDayMap;
  uniform sampler2D uNightMap;
  uniform sampler2D uNormalMap;
  uniform sampler2D uSpecularMap;
  uniform sampler2D uCloudShadowMap;
  // Phase 8B — shared climatology DataTexture (R convection, G cover,
  // B itcz, A corridor). Same texture as the volumetric cloud shader.
  uniform sampler2D uClimatology;
  uniform float uClimatologyStrength;
  uniform float uUseClimatology;
  // Phase 9A — true-parity cloud coverage render target. R = coverage
  // (0..1), G = storm-field mass, computed by the same weather pipeline
  // that drives the visible volumetric clouds. When uUseCoverageRT = 1
  // the earth shader samples this RT directly for shadows.
  uniform sampler2D uCloudCoverageRT;
  uniform float uUseCoverageRT;
  uniform vec3 uSunDirection;
  uniform float uCloudOffset0;
  uniform float uCloudOffset1;
  uniform float uCloudSeed0;
  uniform float uCloudSeed1;
  uniform float uCloudShadowWeight0;
  uniform float uCloudShadowWeight1;
  uniform float uCloudShadowStrength;
  uniform float uCloudShadowSoftness;
  uniform float uCloudShadowDayFade;
  uniform float uCloudShadowDarken;
  uniform float uTime;
  uniform float uNormalStrength;
  uniform float uTerminatorSoftness;
  uniform float uNightIntensity;
  uniform float uFresnelPower;
  uniform float uGlintPower;
  uniform float uTwilightIntensity;
  uniform float uUseCloudShadowMap;
  uniform float uDebugView;
  // Hyper-realism additions
  uniform float uLimbDarkenStrength;
  uniform float uHorizonHazeStrength;
  // Phase 3 — night lights refinement (ocean specular retired in Phase 3.7)
  uniform vec3 uNightLightColor;
  uniform float uNightTerminatorStart;
  uniform float uNightTerminatorEnd;
  // Phase 3.5 — atmospheric coupling (shared scatter palette + coupling knobs)
  uniform vec3 uAtmosphereRayleighTint;
  uniform vec3 uAtmosphereMieTint;
  uniform vec3 uAtmosphereTwilightTint;
  uniform float uNightAtmosphereCoupling;
  uniform float uHorizonSurfaceCoupling;
  uniform float uTwilightCouplingStrength;
  // Phase 3.7 — physical ocean material (three-term model: deep + Fresnel sky + sun spec)
  uniform vec3 uDeepOceanColor;
  uniform vec3 uSkyReflectionColor;
  uniform vec3 uSunColor;
  uniform vec3 uOceanLiftColor;
  uniform float uSpecularStrength;
  // Phase 7B — sky-captured ocean reflection
  uniform sampler2D uSkyMap;
  uniform float uUseSkyMap;
  // Phase 10A — atmospheric ray march + ozone absorption.
  // Scattering coefficients are wavelength-dependent (R, G, B in order
  // of decreasing wavelength). Rayleigh beta roughly follows 1/λ^4;
  // ozone absorbs a broad band centered on green-yellow which gives
  // the orbital terminator its characteristic blue-to-magenta-to-warm
  // transition instead of a flat pink band.
  uniform float uAtmosphereInnerRadius;
  uniform float uAtmosphereOuterRadius;
  uniform vec3  uRayleighBeta;
  uniform vec3  uOzoneBeta;
  uniform float uAtmosphereScaleHeight;
  uniform float uOzonePeakHeight;
  uniform float uOzoneWidth;
  uniform float uAtmosphereIntensity;
  // Phase 10A — spectral aerial perspective (surface-side). Applied to
  // the composited surface color only; the ray-march handles the limb.
  uniform vec3  uAerialBeta;
  uniform float uAerialStrength;
  // Phase 10A — finite sun-disk ocean highlight.
  uniform float uSunAngularRadius;
  uniform float uSunDiskSoftness;
  uniform float uSunDiskBrightness;
  uniform float uOceanGlareStrength;
  uniform float uOceanRoughness;
  // Phase 10B Part 5 — frame-index driver for sub-pixel ocean highlight
  // jitter. Shifts reflectDotView by ±(1 / ~glareExp / 4) per frame along
  // a golden-ratio sequence so successive frames sample slightly different
  // points on the same glare lobe. The eye integrates the sequence,
  // eliminating the "crawling pixels at the terminator of the glint"
  // without softening the 10A disk shape. Mirrors the cloud shader's
  // temporal jitter driver and uses the same per-frame number.
  uniform float uFrameIndex;

  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;

  const float PI = 3.141592653589793;

  float clamp01(float v) { return clamp(v, 0.0, 1.0); }
  float sq(float v) { return v * v; }

  // GGX Normal Distribution Function
  float D_GGX(float NoH, float a2) {
    float d = sq(NoH) * (a2 - 1.0) + 1.0;
    return a2 / max(PI * sq(d), 1e-6);
  }

  // Smith-GGX height-correlated visibility (includes 1/(4*NdotL*NdotV) denominator)
  float V_SmithGGX(float NoV, float NoL, float a2) {
    float ggxV = NoL * sqrt(sq(NoV) * (1.0 - a2) + a2);
    float ggxL = NoV * sqrt(sq(NoL) * (1.0 - a2) + a2);
    return 0.5 / max(ggxV + ggxL, 1e-6);
  }

  // Schlick Fresnel
  vec3 F_Schlick(float cosTheta, vec3 f0) {
    return f0 + (1.0 - f0) * pow(clamp01(1.0 - cosTheta), 5.0);
  }

  vec2 sphericalUv(vec3 direction) {
    vec3 n = normalize(direction);
    // Match Three's SphereGeometry UV winding so +90E lands left of lon=0.
    float lon = atan(-n.z, n.x);
    float lat = asin(clamp(n.y, -1.0, 1.0));
    return vec2(fract(lon / (2.0 * PI) + 0.5), lat / PI + 0.5);
  }

  vec3 applyNormalMap(vec3 baseNormal, vec2 uv) {
    vec3 tangentNormal = texture2D(uNormalMap, uv).xyz * 2.0 - 1.0;
    tangentNormal.xy *= uNormalStrength;
    // sphericalUv() matches Three's SphereGeometry UV winding, so this TBN stays in
    // the same east/west frame as the mesh, country geometry, and picking math.
    vec3 helper = abs(baseNormal.y) > 0.98 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    vec3 tangent = normalize(cross(baseNormal, helper));
    vec3 bitangent = normalize(cross(tangent, baseNormal));
    mat3 tbn = mat3(tangent, bitangent, baseNormal);
    return normalize(tbn * vec3(tangentNormal.x, tangentNormal.y, max(tangentNormal.z, 0.2)));
  }

  float sampleCloudShadow(vec2 uv) {
    float broad = texture2D(uCloudShadowMap, uv).a;
    float detail = texture2D(
      uCloudShadowMap,
      vec2(fract(uv.x * 1.012 + 0.0032), clamp(uv.y + 0.006, 0.0, 1.0))
    ).a;
    float veil = texture2D(
      uCloudShadowMap,
      vec2(fract(uv.x * 0.994 - 0.0026), clamp(uv.y * 0.998 + 0.0034, 0.0, 1.0))
    ).a;
    float coverage = mix(broad, detail, 0.34);
    coverage = mix(coverage, max(coverage, veil), 0.2);
    return clamp01(coverage);
  }

  vec2 scrollCloudUv(vec2 uv, float offset, float layerSeed, float timeValue) {
    float warp = sampleCloudShadow(uv * vec2(1.0 + layerSeed * 0.04, 1.0) + vec2(layerSeed, timeValue * 0.035)) - 0.5;
    float latFade = smoothstep(0.02, 0.18, uv.y) * (1.0 - smoothstep(0.82, 0.98, uv.y));
    return vec2(
      fract(uv.x + offset + warp * 0.012),
      clamp(uv.y + warp * 0.005 * latFade, 0.0, 1.0)
    );
  }

  // Phase 8A — climate-aware bias for cloud shadow sampling. This is a
  // light-weight port of the volumetric shader's weather context so the
  // shadow mask couples to the same ocean-wet / continent-dry / ITCZ /
  // mid-latitude-storm / subtropical-calm logic that drives the visible
  // clouds. No noise — all math + one water-mask read (uSpecularMap).
  float cloudShadowWeatherBias(vec2 uv) {
    float lat = (uv.y - 0.5) * PI;
    float absLat = abs(lat);
    float lon  = (uv.x - 0.5) * (2.0 * PI);

    float oceanicness = smoothstep(0.10, 0.72, texture2D(uSpecularMap, uv).r);

    float midLat = exp(-pow(absLat - 0.82, 2.0) / 0.040);
    float itcz   = exp(-absLat * absLat / 0.020)
                 * (0.55 + 0.30 * sin(lon * 3.0 + 0.4) + 0.15 * sin(lon * 1.0 - 1.2))
                 * 0.22
                 * mix(0.85, 1.15, oceanicness);
    float midStorm = midLat * 0.22
                   + midLat * oceanicness * 0.05;
    float subtropCalm = exp(-pow(absLat - 0.44, 2.0) / 0.022) * 0.10;

    float oceanLift = oceanicness
                    * (0.030 + midLat * 0.050);
    float landDryDip = (1.0 - oceanicness)
                     * smoothstep(0.12, 0.55, absLat)
                     * (1.0 - smoothstep(1.05, 1.30, absLat))
                     * 0.055;

    // Phase 8B — sampled climatology nudges shadow bias toward the
    // same Earth backbone the volumetric shader uses. Strength is
    // small and gated (+ uClimatologyStrength * uUseClimatology) so
    // the analytic bias still dominates and the shadow stays stable
    // if the texture ever fails to bind.
    float climBias = 0.0;
    if (uUseClimatology > 0.5) {
      vec4 clim = texture2D(uClimatology, uv);
      climBias = (clim.g - 0.45) * 0.07
               + (clim.b - 0.05) * 0.10
               + (clim.r - 0.30) * 0.05;
    }

    return (itcz + midStorm - subtropCalm + oceanLift - landDryDip
          + climBias * uClimatologyStrength);
  }

  float sampleLayerShadow(vec2 uv, float offset, float layerSeed, float weight) {
    float coverage;
    float bandMod = 1.0;
    float softnessMod = 1.0;
    if (uUseCoverageRT > 0.5) {
      // Phase 9A — read the actual volumetric coverage field. The RT
      // was rendered this frame from the same climate + storm + climatology
      // pipeline that the volumetric cloud shader uses, so the surface
      // shadow aligns with the visible systems. The layer offset is
      // still applied so the two-lobe stack retains a faint mottled
      // frequency, but most of the structure already lives in the RT.
      vec2 offsetUv = vec2(fract(uv.x + offset * 0.35), uv.y);
      vec4 rt = texture2D(uCloudCoverageRT, offsetUv);
      coverage = rt.r;
      // Phase 9B — decode band shares from RT channels. rt.b carries
      // low-mass = lowShare * cov; rt.a carries high-mass = highShare * cov.
      // Dividing by cov recovers the shares. High cirrus shadows are
      // softer/weaker; low dense shadows stay dark and full-strength.
      float covSafe = max(coverage, 0.01);
      float highShare = clamp(rt.a / covSafe, 0.0, 1.0);
      float lowShare  = clamp(rt.b / covSafe, 0.0, 1.0);
      bandMod     = mix(1.0, 0.50, highShare) * mix(1.0, 1.18, lowShare);
      softnessMod = mix(1.0, 1.60, highShare); // cirrus shadow edges diffuse
    } else {
      // Phase 8B fallback: flat cloud alpha + analytic bias.
      vec2 scrolledUv = scrollCloudUv(uv, offset, layerSeed, uTime);
      coverage = sampleCloudShadow(scrolledUv);
      float weatherBias = cloudShadowWeatherBias(uv);
      coverage = clamp(coverage + weatherBias, 0.0, 1.0);
    }
    float thresholdMin = mix(0.14, 0.18, step(0.5, layerSeed));
    float thresholdMax = mix(0.52, 0.58, step(0.5, layerSeed));
    float softness = uCloudShadowSoftness * softnessMod;
    return pow(smoothstep(thresholdMin, thresholdMax, coverage), softness) * weight * bandMod;
  }

  /* ── Phase 10A: atmospheric ray-march helpers ────────────────────── */

  float sphereExitT(vec3 ro, vec3 rd, float rad) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - rad * rad;
    float disc = b * b - c;
    if (disc < 0.0) return -1.0;
    return -b + sqrt(disc);
  }

  float atmosphereOcclusion(vec3 p, vec3 sd) {
    float b = dot(p, sd);
    if (b >= 0.0) return 1.0;
    float t = -b;
    vec3 closest = p + sd * t;
    float r = length(closest);
    return smoothstep(uAtmosphereInnerRadius - 0.006,
                      uAtmosphereInnerRadius + 0.018, r);
  }

  /* Short (6-sample) single-scatter integration of Rayleigh + ozone
     along the view column between the surface and the camera. Each
     sample does one light-path midpoint tap toward the sun — still O(N)
     in samples, no precomputed LUT. Returns per-channel transmittance
     and accumulated in-scatter so the caller can composite:
          finalColor = surfaceColor * transmittance + inScatter */
  void atmospherePath(vec3 surfacePos, vec3 viewDir, vec3 sunDir,
                      out vec3 transmittance, out vec3 inScatter) {
    transmittance = vec3(1.0);
    inScatter     = vec3(0.0);
    if (uAtmosphereIntensity < 0.001) return;

    float tAtm = sphereExitT(surfacePos, viewDir, uAtmosphereOuterRadius);
    if (tAtm <= 1e-4) return;
    float tCam = length(cameraPosition - surfacePos);
    float tMax = min(tCam, tAtm);
    if (tMax < 1e-4) return;

    // Phase 10B Part 4 — atmosphere sample budget is now a compile-time
    // define injected via EarthMaterial.defines, so it scales with the
    // active quality tier (low=4, medium=6, high=8). Fall back to 6 if
    // the define is missing so the shader still compiles standalone.
    #ifndef ATM_SAMPLES
    #define ATM_SAMPLES 6
    #endif
    float step = tMax / float(ATM_SAMPLES);

    float mu = dot(viewDir, sunDir);
    float phaseR = (3.0 / (16.0 * PI)) * (1.0 + mu * mu);

    vec3 tr = vec3(1.0);
    vec3 acc = vec3(0.0);
    float invScale = 1.0 / max(uAtmosphereScaleHeight, 1e-4);
    float invOzoneW = 1.0 / max(uOzoneWidth, 1e-4);

    for (int i = 0; i < ATM_SAMPLES; i++) {
      float ti = step * (float(i) + 0.5);
      vec3 p = surfacePos + viewDir * ti;
      float h = max(length(p) - uAtmosphereInnerRadius, 0.0);

      float rhoR = exp(-h * invScale);
      float oz = (h - uOzonePeakHeight) * invOzoneW;
      float rhoO = exp(-oz * oz);

      // Light path: single-sample midpoint + earth occlusion.
      float tLight = sphereExitT(p, sunDir, uAtmosphereOuterRadius);
      float earthClear = atmosphereOcclusion(p, sunDir);
      vec3 lightTr = vec3(0.0);
      if (tLight > 0.0 && earthClear > 0.0) {
        vec3 lp = p + sunDir * (tLight * 0.5);
        float lh = max(length(lp) - uAtmosphereInnerRadius, 0.0);
        float lRhoR = exp(-lh * invScale);
        float lOz = (lh - uOzonePeakHeight) * invOzoneW;
        float lRhoO = exp(-lOz * lOz);
        vec3 lightExt = (uRayleighBeta * lRhoR + uOzoneBeta * lRhoO) * tLight;
        lightTr = exp(-lightExt) * earthClear;
      }

      vec3 segInScatter = uRayleighBeta * rhoR * phaseR * lightTr * step;
      acc += tr * segInScatter * uSunColor;

      vec3 segExt = (uRayleighBeta * rhoR + uOzoneBeta * rhoO) * step;
      tr *= exp(-segExt);
    }

    transmittance = tr;
    inScatter     = acc * uAtmosphereIntensity;
  }

  void main() {
    vec3 baseNormal = normalize(vWorldNormal);
    vec2 uv = sphericalUv(baseNormal);

    if (uDebugView > 3.5) {
      gl_FragColor = vec4(texture2D(uSpecularMap, uv).rgb, 1.0);
      return;
    }

    if (uDebugView > 2.5) {
      gl_FragColor = vec4(texture2D(uNormalMap, uv).rgb, 1.0);
      return;
    }

    if (uDebugView > 1.5) {
      gl_FragColor = vec4(texture2D(uDayMap, uv).rgb, 1.0);
      return;
    }

    if (uDebugView > 0.5) {
      gl_FragColor = vec4(uv, 0.0, 1.0);
      return;
    }

    vec3 normal = applyNormalMap(baseNormal, uv);
    vec3 L = normalize(uSunDirection);
    vec3 V = normalize(cameraPosition - vWorldPosition);
    vec3 H = normalize(L + V);

    float NdotL = dot(normal, L);
    float NdotV = max(dot(normal, V), 0.001);
    float NdotH = clamp01(dot(normal, H));
    float LdotH = clamp01(dot(L, H));
    float sunFacing = clamp01(NdotL);
    float dayFactor = smoothstep(-uTerminatorSoftness, uTerminatorSoftness, NdotL);

    // Textures
    vec3 dayColor = pow(texture2D(uDayMap, uv).rgb, vec3(1.04));
    vec3 nightColor = pow(texture2D(uNightMap, uv).rgb, vec3(1.1));
    float waterSample = texture2D(uSpecularMap, uv).r;
    float waterMask = smoothstep(0.14, 0.82, waterSample);
    float landMask = 1.0 - waterMask;

    // Cloud shadow (Phase 9B — crepuscular bleed + sky-chromaticity tint).
    float shadowAmount = 0.0;
    if (uUseCloudShadowMap > 0.5) {
      float cloudShadow0 = sampleLayerShadow(uv, uCloudOffset0, uCloudSeed0, uCloudShadowWeight0);
      float cloudShadow1 = sampleLayerShadow(uv, uCloudOffset1, uCloudSeed1, uCloudShadowWeight1);
      float combinedShadowCoverage = 1.0 - (1.0 - cloudShadow0) * (1.0 - cloudShadow1);

      // Phase 9B Part 7 — subtle crepuscular bleed. A second shadow tap
      // offset toward the anti-sun direction, max-blended, creates the
      // faint streak of darker ground reaching away from a cloud bank at
      // low sun angles. Kept small (0.008 UV, ~2.9 deg longitude) so it
      // never reads as a hard banding artifact; gated by solar grazing
      // angle so mid-day surfaces stay clean.
      vec3 sunTangent = normalize(L - baseNormal * dot(L, baseNormal));
      float cosLat = max(cos((uv.y - 0.5) * PI), 0.35);
      vec2 sunUv = normalize(vec2(-sunTangent.z / cosLat, sunTangent.y));
      float grazing = smoothstep(0.02, 0.28, NdotL) * (1.0 - smoothstep(0.28, 0.62, NdotL));
      float crepOffset = 0.008 * grazing;
      vec2 crepUv = vec2(fract(uv.x - sunUv.x * crepOffset),
                         clamp(uv.y - sunUv.y * crepOffset, 0.0, 1.0));
      float crep0 = sampleLayerShadow(crepUv, uCloudOffset0, uCloudSeed0, uCloudShadowWeight0 * 0.55);
      float crep1 = sampleLayerShadow(crepUv, uCloudOffset1, uCloudSeed1, uCloudShadowWeight1 * 0.55);
      float crepCoverage = 1.0 - (1.0 - crep0) * (1.0 - crep1);
      combinedShadowCoverage = max(combinedShadowCoverage, crepCoverage * 0.65);

      float solarShadowWeight = smoothstep(0.02, uCloudShadowDayFade, NdotL);
      shadowAmount = combinedShadowCoverage * solarShadowWeight * uCloudShadowStrength;
    }
    float directLightOcclusion = 1.0 - shadowAmount * uCloudShadowDarken;

    // Phase 9B Part 3 — shadow color rigor. Instead of a fixed Rayleigh-
    // blue tint, sample the live sky-capture at the surface zenith and
    // use its chromaticity (color / luminance) so shadows reflect today's
    // atmosphere: bluer on the day side, warmer near the terminator,
    // desaturated under a stormy overcast. The analytic tint stays as the
    // fallback when the sky RT is not bound.
    vec3 shadowSkyColor = vec3(0.82, 0.88, 1.08);
    if (uUseSkyMap > 0.5) {
      vec2 zenithUv = sphericalUv(baseNormal);
      vec3 zenithSky = texture2D(uSkyMap, zenithUv).rgb * 2.0;
      float zenithLuma = max(dot(zenithSky, vec3(0.299, 0.587, 0.114)), 0.001);
      vec3 skyChroma = zenithSky / zenithLuma;
      // Normalized chromaticity pushed 72% of the way from neutral — keeps
      // shadows believable without letting a saturated twilight sky paint
      // the whole day side magenta.
      shadowSkyColor = mix(vec3(1.0), skyChroma, 0.72);
    }
    vec3 cloudShadowTint = mix(vec3(1.0), shadowSkyColor, shadowAmount * 0.45);

    // Limb darkening: grazing angles appear darker on the day side
    // (longer optical path through atmosphere for near-limb rays)
    float limbDarken = pow(NdotV, uLimbDarkenStrength);
    float limbFactor = mix(1.0, limbDarken, 0.55 * dayFactor);

    // Day-side diffuse
    // Phase 19C.4 verification — analyst-product legibility floor.
    // The 19C.2 floor (diffuse 0.30, dayLift 0.50) was photographically
    // accurate but crushed continents at the terminator and on the
    // shadow hemisphere — reviewers reported "half the countries are
    // not visible". This is an *intelligence* surface where geography
    // must remain legible at night, not a documentary still. Floors
    // raised modestly: shadow-side continents now read as dim-but-
    // identifiable dimensional shapes rather than flat black, while
    // the day-side full-light value is unchanged so the terminator
    // still exists as a real photographic gradient.
    float diffuse = mix(0.48, 1.0, sunFacing);
    float dayLift = mix(0.68, 1.0, smoothstep(-0.4, 0.2, NdotL));
    vec3 litDay = dayColor * diffuse * directLightOcclusion * dayLift * limbFactor * cloudShadowTint;

    // --- Phase 5 Part 2 + Part 5: physical ocean with dynamic sky reflection ---
    // Three-term model:
    //   1. Deep base color (uDeepOceanColor)
    //   2. Two-lobe Schlick Fresnel sky reflection — DYNAMIC per Phase 5:
    //      computes the reflected sky color analytically from the atmosphere
    //      palette. Cool blue on the day side (Rayleigh), warm near the
    //      terminator (Twilight), Mie glow near the sun direction.
    //   3. Sun highlight with specular AA (Phase 5 Part 5) — broadens the
    //      lobe via fwidth(normal) to eliminate sub-pixel ocean flicker.

    // Two-lobe Fresnel (Phase 4: sharp limb + broad pre-limb)
    float cosView = max(dot(V, normal), 0.0);
    float oneMinusView = 1.0 - cosView;
    float fresnelSharp = pow(oneMinusView, 5.0);
    float fresnelBroad = pow(oneMinusView, 2.5);
    float oceanFresnel = fresnelSharp * 0.70 + fresnelBroad * 0.30;

    // Dynamic sky color at the reflected view direction.
    vec3 reflectedView = reflect(-V, normal);
    float reflSun = dot(reflectedView, L);
    float reflHorizon = 1.0 - abs(dot(reflectedView, normal));
    float oceanTwilightBand = smoothstep(-0.2, 0.05, NdotL)
                              * (1.0 - smoothstep(0.05, 0.2, NdotL));
    vec3 skyReflection = uAtmosphereRayleighTint * (0.28 + reflHorizon * 0.52) * dayFactor
                       + uAtmosphereMieTint * pow(max(reflSun, 0.0), 8.0) * 0.38
                       + uAtmosphereTwilightTint * oceanTwilightBand * reflHorizon * 0.35;
    // uSkyReflectionColor stays as an artistic tint multiplier. When the
    // sky-capture RT is available we pull the analytical term back so the
    // captured sky actually wins the mix instead of fighting a 2.8x tint.
    float analyticalGain = mix(2.8, 1.7, uUseSkyMap);
    skyReflection *= uSkyReflectionColor * analyticalGain;

    // Phase 7B — sample the captured sky map at the reflected view
    // direction. The sky RT integrates actual atmosphere + cloud state
    // so the ocean inherits today's sky instead of the analytical model.
    // Mix raised to ~0.82 on the day side so the RT is the dominant
    // reflection term; the analytical piece survives as a warm twilight
    // floor where the RT falls to zero.
    if (uUseSkyMap > 0.5) {
      vec3 skyDir = normalize(reflectedView);
      float lonR = atan(-skyDir.z, skyDir.x);
      float latR = asin(clamp(skyDir.y, -1.0, 1.0));
      vec2 skyUv = vec2(fract(lonR / (2.0 * PI) + 0.5), latR / PI + 0.5);
      vec3 capturedSky = texture2D(uSkyMap, skyUv).rgb * 2.2;
      float skyMix = 0.82 * clamp01(dayFactor + 0.30);
      skyReflection = mix(skyReflection, capturedSky, skyMix);
    }

    // Phase 10A — finite sun-disk ocean highlight.
    // Replace pow(reflectDotView, N) core+skirt with a physically-motivated
    // two-lobe model:
    //   (1) Sun disk: smoothstep plateau around cos(sunAngularRadius); the
    //       glint is a flat bright disk, not a sharp spike. Reduces the
    //       clipped "white pin" artifact and reads as reflected sunlight.
    //   (2) Broad atmospheric glare: Phong-style lobe whose tightness is
    //       driven by uOceanRoughness. Lets the highlight taper realistically
    //       into the surrounding sea instead of a discontinuous edge.
    // Specular AA still broadens the glare when the surface alias-flickers.
    float normalVariance = length(fwidth(normal));
    float specularAA = clamp(normalVariance * 12.0, 0.0, 1.0);

    vec3 reflectedSun = reflect(-L, normal);
    float reflectDotView = max(dot(reflectedSun, V), 0.0);

    // Phase 10B Part 5 — sub-pixel temporal jitter on the specular angle.
    // The jitter magnitude is scaled by (1 - reflectDotView) so it is
    // largest at the glare *edge* (where shimmer lives) and near-zero
    // at the disk center (preserving the 10A plateau). The golden-ratio
    // sequence decorrelates successive frames; the eye then integrates
    // a stable highlight instead of a crawling border. Bounded to
    // 0.0015 so it cannot widen the disk geometry visibly.
    float oceanJitter = fract(uFrameIndex * 0.61803398875 + 0.3710) - 0.5;
    float jitterAmp = 0.0030 * (1.0 - reflectDotView);
    reflectDotView = clamp(reflectDotView + oceanJitter * jitterAmp, 0.0, 1.0);

    float cosSunRad  = cos(uSunAngularRadius);
    float cosSunSoft = cos(uSunAngularRadius + uSunDiskSoftness);
    float sunDisk = smoothstep(cosSunSoft, cosSunRad, reflectDotView);

    float effectiveRough = clamp01(uOceanRoughness + specularAA * 0.25);
    float glareExp = mix(80.0, 8.0, effectiveRough);
    float glare = pow(reflectDotView, glareExp);

    float microBreakup = 0.72 + waterSample * 0.46;
    float oceanHighlight =
        (sunDisk * uSunDiskBrightness + glare * uOceanGlareStrength) * microBreakup;

    vec3 oceanColor = uDeepOceanColor
                      + oceanFresnel * skyReflection
                      + oceanHighlight * uSunColor * uSpecularStrength
                        * sunFacing * directLightOcclusion;
    // Day-side visibility lift.
    float oceanLift = smoothstep(0.0, 0.2, NdotL);
    oceanColor += uOceanLiftColor * oceanLift * 0.1;
    // Twilight influence on ocean.
    oceanColor = mix(oceanColor, oceanColor * uAtmosphereTwilightTint, oceanTwilightBand * 0.25);
    // Splice the physical ocean into litDay.
    litDay = mix(litDay, oceanColor * directLightOcclusion * limbFactor, waterMask * dayFactor);

    // Horizon atmospheric scatter: day-side limb picks up scattered sky blue
    float horizonScatter = pow(1.0 - NdotV, 4.5) * dayFactor * uHorizonHazeStrength;
    litDay += vec3(0.05, 0.14, 0.36) * horizonScatter * (1.0 - shadowAmount * 0.4);

    // Deep ocean subsurface tint (kept from Phase 3; blends under the new deep base)
    litDay += vec3(0.02, 0.08, 0.16) * waterMask * (0.22 + sunFacing * 0.4) * (1.0 - shadowAmount * 0.18);

    // Ocean specular is now integrated into litDay via the three-term model above.
    // The Phase 3.6 GGX Cook-Torrance hero composition is retired in Phase 3.7: the
    // combination of additive hot-core + broad Fresnel sheen + grazing limb + warm
    // bleed compounded through additive atmosphere blending into a crimson halo at
    // the limb. The new model keeps the physically-plausible pieces (Schlick Fresnel,
    // Phong-style sun spec) while dropping the terms that were fighting each other.

    // Phase 5 Part 3 — material-based land sheen.
    // Derive pseudo-roughness from day texture chromaticity so deserts,
    // forests, and ice respond differently to direct light. Smoother
    // surfaces (sand, ice) get a tighter, brighter specular lobe; rough
    // surfaces (forest, tundra) stay matte.
    float dayLuma = dot(dayColor, vec3(0.299, 0.587, 0.114));
    float desertness = smoothstep(0.10, 0.32, (dayColor.r + dayColor.g) * 0.5 - dayColor.b * 1.2) * landMask;
    float iceness = smoothstep(0.68, 0.92, min(min(dayColor.r, dayColor.g), dayColor.b)) * landMask;
    float greenness = smoothstep(0.08, 0.28, dayColor.g - dayColor.r * 0.8) * landMask;
    float landRoughness = 0.82;
    landRoughness = mix(landRoughness, 0.48, desertness);
    landRoughness = mix(landRoughness, 0.30, iceness);
    landRoughness = mix(landRoughness, 0.90, greenness);
    float landGlintPower = mix(24.0, 160.0, 1.0 - landRoughness);
    float landGlintStrength = mix(0.018, 0.075, 1.0 - landRoughness);
    vec3 reflectedLight = reflect(-L, normal);
    float sunGlint = pow(clamp01(dot(reflectedLight, V)), landGlintPower) * sunFacing;
    vec3 landSheen = vec3(sunGlint * landGlintStrength) * landMask * dayFactor * (1.0 - shadowAmount * 0.24);

    // Night lights — warm cinematic city glow (Phase 3)
    // An explicit asymmetric terminator fade (uNightTerminatorStart .. uNightTerminatorEnd)
    // controls exactly where lights appear, independent of uTerminatorSoftness which drives
    // the base day/night blend. As NdotL rises through [Start, End], nightShadow fades to 0,
    // killing lights before the atmosphere twilight belt begins glowing on the day limb.
    float nightFactor = 1.0 - dayFactor;
    float nightShadow = 1.0 - smoothstep(uNightTerminatorStart, uNightTerminatorEnd, NdotL);
    float cityMask = smoothstep(0.08, 0.92, landMask + 0.08);
    // Subtle warm/cool split: port/industrial areas retain a cool bias instead of
    // reading as uniform sodium. Cool contribution is deliberately tame so the overall
    // tint stays in the warm amber family set by uNightLightColor.
    float coolBias = clamp01((nightColor.b - nightColor.r * 0.6) * 2.8);
    vec3 warmLights = nightColor * uNightLightColor;
    vec3 coolLights = nightColor * vec3(0.78, 0.88, 1.0);
    vec3 coloredNightLights = mix(warmLights, coolLights, coolBias * 0.32);
    vec3 nightLights = coloredNightLights * nightShadow * cityMask * uNightIntensity;
    vec3 nightOcean = vec3(0.012, 0.028, 0.07) * waterMask * nightFactor * 0.56;
    // Phase 19C.4 verification — analyst-product land ambient on the night
    // hemisphere. Pure photographic Earth at night is ~95% black (city
    // lights only); reviewers reported "half the countries are not
    // visible … just full black". Pull a small fraction of the day
    // texture through on land so continent shapes stay identifiable
    // even where there are no city lights, then a slightly cool tint
    // so it reads as moonlit rather than dim daylight.
    vec3 nightLandAmbient = dayColor * landMask * nightFactor * 0.22;
    nightLandAmbient *= vec3(0.78, 0.86, 1.05);

    // Phase 3.5 Part 1 — city lights scatter through atmosphere near the limb.
    // NdotV is already the surface/view cosine; raise to a steep power so the mask
    // only switches on in the last ~30 deg before the limb, then smoothstep adds a
    // soft knee. The effect is a gentle fade (mix to 55%) plus a very faint warm
    // Mie tint that implies light scattering through the atmosphere column, not blur.
    float nightLimb = smoothstep(0.2, 0.85, pow(1.0 - NdotV, 2.5));
    float nightCouplingAmount = nightLimb * uNightAtmosphereCoupling;
    nightLights *= mix(1.0, 0.55, nightCouplingAmount);
    nightLights = mix(nightLights, nightLights * uAtmosphereMieTint, 0.12 * nightCouplingAmount);

    // Phase 3.7 Part 1 — smooth spectral twilight band on the surface.
    // Single smoothstep-based transition mirrors the atmosphere shader so the
    // terminator reads as a single coherent arc rather than two slightly-offset
    // warm bands. The Phase 2.5 earthTwilightWarm + twilightPurple double band
    // is retired: it was the surface partner of the atmosphere's red halo and
    // compounded the same way under additive blending.
    float fresnel = pow(1.0 - clamp01(dot(normal, V)), uFresnelPower);
    float surfaceTwilight = smoothstep(-0.2, 0.05, NdotL) * (1.0 - smoothstep(0.05, 0.2, NdotL));
    vec3 twilightSpectrum = mix(uAtmosphereRayleighTint, uAtmosphereTwilightTint, surfaceTwilight);
    vec3 twilightTint = twilightSpectrum * surfaceTwilight
                        * (0.08 + fresnel * 0.22)
                        * uTwilightIntensity
                        * uTwilightCouplingStrength;

    // Final composite — Phase 19C.4 verification adds nightLandAmbient
    // so country shapes remain readable on the night hemisphere.
    vec3 baseColor = mix(nightLights + nightOcean + nightLandAmbient, litDay, dayFactor);

    // Phase 10A — ray-marched atmosphere + spectral aerial perspective.
    // The analytic horizon Rayleigh bleed + luma aerial knobs from Phases
    // 3.7 / 4.3 are retired. Instead we integrate Rayleigh + ozone along
    // the view path to produce wavelength-correct limb tint, ozone-driven
    // terminator blue→magenta→warm separation, and photographic haze in
    // a single physically-grounded pass. A short (3-channel) spectral
    // aerial term then softens the composited surface based on view
    // distance through the lower atmosphere; no luma squash needed.
    vec3 atmTransmittance;
    vec3 atmInScatter;
    atmospherePath(vWorldPosition, V, L, atmTransmittance, atmInScatter);
    float horizonGate = pow(1.0 - NdotV, 2.6);
    float atmGate = mix(0.45, 1.0, horizonGate) * uHorizonSurfaceCoupling;
    vec3 atmMixedTr = mix(vec3(1.0), atmTransmittance, atmGate);
    baseColor = baseColor * atmMixedTr + atmInScatter * atmGate;

    // Spectral aerial perspective: per-channel exponential extinction
    // gated by the same horizon factor. uAerialBeta follows the same
    // 1/λ^4-ish tendency as Rayleigh so blue survives best in the haze.
    float aerialAmount = horizonGate * dayFactor * uAerialStrength;
    vec3 aerialTr = exp(-uAerialBeta * aerialAmount);
    vec3 aerialAdd = uAtmosphereRayleighTint * aerialAmount * 0.18;
    baseColor = baseColor * aerialTr + aerialAdd;

    baseColor += landSheen;
    baseColor += twilightTint;

    gl_FragColor = vec4(baseColor, 1.0);
  }
`;

export function configureEarthSurfaceTextures({
  dayMap,
  nightMap,
  normalMap,
  specularMap,
  cloudShadowMap = null,
  climatologyMap = null,
  cloudCoverageRT = null,
}: EarthShaderTextureInput) {
  dayMap.colorSpace = SRGBColorSpace;
  nightMap.colorSpace = SRGBColorSpace;
  normalMap.colorSpace = NoColorSpace;
  specularMap.colorSpace = NoColorSpace;
  if (cloudShadowMap) {
    cloudShadowMap.colorSpace = NoColorSpace;
  }
  if (climatologyMap) {
    climatologyMap.colorSpace = NoColorSpace;
  }
  if (cloudCoverageRT) {
    cloudCoverageRT.colorSpace = NoColorSpace;
  }
}

export function createEarthShaderUniforms({
  dayMap,
  nightMap,
  normalMap,
  specularMap,
  cloudShadowMap = null,
  climatologyMap = null,
  cloudCoverageRT = null,
  sunDirection,
  debugView = "default",
  cloudShadow,
  skyMap = null,
}: EarthShaderUniformInput) {
  const enabled = Boolean(cloudShadowMap) && (cloudShadow?.enabled ?? true);
  const primaryLayer = cloudShadow?.layers?.[0];
  const secondaryLayer = cloudShadow?.layers?.[1];
  const debugMode =
    debugView === "uv" ? 1
    : debugView === "day" ? 2
    : debugView === "normal" ? 3
    : debugView === "specular" ? 4
    : 0;

  return {
    uDayMap: { value: dayMap },
    uNightMap: { value: nightMap },
    uNormalMap: { value: normalMap },
    uSpecularMap: { value: specularMap },
    uCloudShadowMap: { value: cloudShadowMap ?? normalMap },
    // Phase 8B — climatology (shared with volumetric cloud shader).
    // Fallback to normalMap so the sampler always has a valid target.
    uClimatology: { value: climatologyMap ?? normalMap },
    uClimatologyStrength: { value: climatologyMap ? 1.0 : 0.0 },
    uUseClimatology: { value: climatologyMap ? 1.0 : 0.0 },
    // Phase 9A — cloud coverage RT (true shadow parity). When provided,
    // shadow sampling reads the actual volumetric coverage field. Falls
    // back to normalMap + uUseCoverageRT=0 so the sampler always resolves.
    uCloudCoverageRT: { value: cloudCoverageRT ?? normalMap },
    uUseCoverageRT: { value: cloudCoverageRT ? 1.0 : 0.0 },
    uSunDirection: { value: sunDirection.clone().normalize() },
    uCloudOffset0: { value: primaryLayer?.offset ?? 0 },
    uCloudOffset1: { value: secondaryLayer?.offset ?? 0.137 },
    uCloudSeed0: { value: primaryLayer?.seed ?? 0.18 },
    uCloudSeed1: { value: secondaryLayer?.seed ?? 0.63 },
    uCloudShadowWeight0: { value: primaryLayer?.weight ?? (enabled ? 0.72 : 0) },
    uCloudShadowWeight1: { value: secondaryLayer?.weight ?? 0 },
    uCloudShadowStrength: { value: enabled ? (cloudShadow?.strength ?? 0.92) : 0 },
    uCloudShadowSoftness: { value: cloudShadow?.softness ?? 1.32 },
    uCloudShadowDayFade: { value: cloudShadow?.dayFade ?? 0.46 },
    uCloudShadowDarken: { value: cloudShadow?.darken ?? 0.40 },
    uTime: { value: cloudShadow?.time ?? 0 },
    uNormalStrength: { value: 1.05 },
    // Phase 19C.2 — softer terminator falloff so the lit→shadow transition
    // reads as a real atmospheric gradient rather than a crushed step.
    uTerminatorSoftness: { value: 0.30 },
    // Phase 19C.4 verification — city lights bumped from 0.88 → 1.55 so
    // the night hemisphere reads as a populated Earth-at-night surface
    // rather than a flat black silhouette. Combined with the new
    // nightLandAmbient term in the fragment shader, continents stay
    // identifiable AND city patterns (East Coast US, Europe corridor,
    // Tokyo–Seoul, Indo-Gangetic plain) carry analyst-grade clarity.
    uNightIntensity: { value: 1.55 },
    uFresnelPower: { value: 4.5 },
    uGlintPower: { value: 72.0 },
    uTwilightIntensity: { value: 0.88 },
    uUseCloudShadowMap: { value: enabled ? 1 : 0 },
    uDebugView: { value: debugMode },
    // Hyper-realism
    // Phase 19C.2 — slightly softer limb darkening and reduced horizon haze
    // so day-side continents retain dimension without the limb pinching to
    // black, and the horizon scatter doesn't compete with the rim glow.
    uLimbDarkenStrength: { value: 0.32 },
    uHorizonHazeStrength: { value: 0.40 },
    // Phase 3 — night lights tuning (ocean specular uniforms retired in Phase 3.7)
    uNightLightColor: { value: new Color("#ffd3a1") },
    uNightTerminatorStart: { value: -0.18 },
    uNightTerminatorEnd: { value: 0.08 },
    // Phase 3.5 — atmospheric coupling. Colors are cloned from the shared scatter
    // palette so mutating one material's uniform never bleeds into another.
    uAtmosphereRayleighTint: { value: ATMOSPHERE_RAYLEIGH_TINT.clone() },
    uAtmosphereMieTint: { value: ATMOSPHERE_MIE_TINT.clone() },
    uAtmosphereTwilightTint: { value: ATMOSPHERE_TWILIGHT_TINT.clone() },
    uNightAtmosphereCoupling: { value: 0.45 },
    uHorizonSurfaceCoupling: { value: 0.18 },
    uTwilightCouplingStrength: { value: 0.28 },
    // Phase 3.7 — physical ocean material (three-term model: deep + Fresnel sky + sun spec).
    // Phase 19C.2 — pulled the deep base further into navy/black-blue and
    // desaturated the sky reflection tint so the ocean stops reading as
    // saturated electric blue. The lift color is also de-saturated and the
    // specular strength reduced so the sun glint is visible but restrained.
    uDeepOceanColor: { value: new Color(0.012, 0.028, 0.058) },
    uSkyReflectionColor: { value: new Color(0.085, 0.155, 0.26) },
    uSunColor: { value: new Color(1, 1, 1) },
    uOceanLiftColor: { value: new Color(0.035, 0.072, 0.13) },
    uSpecularStrength: { value: 0.68 },
    // Phase 7B — sky-captured ocean reflection. Fallback to normalMap so the
    // sampler always points at a valid texture even when the feature is off.
    uSkyMap: { value: skyMap ?? normalMap },
    uUseSkyMap: { value: skyMap ? 1 : 0 },
    // Phase 10A — atmospheric ray march + ozone absorption.
    // Radii are in Earth-unit scale (planet radius = 1). Scale height,
    // ozone peak, and ozone width are tuned artistically so the ray
    // march produces visible spectral separation at this renderer's
    // near-field camera distances rather than physical (km) values.
    uAtmosphereInnerRadius: { value: GLOBE_RADIUS },
    uAtmosphereOuterRadius: { value: ATMOSPHERE_RADIUS },
    // Rayleigh beta: roughly (1/λ^4) ratios pinned to a blue-biased
    // triple. Larger values on B give the classic orbital blue limb.
    uRayleighBeta: { value: new Vector3(0.20, 0.48, 1.15) },
    // Ozone Chappuis band: peaks in green-yellow, which removes the
    // "all pink" terminator and reveals the magenta→blue transition.
    uOzoneBeta: { value: new Vector3(0.08, 0.30, 0.10) },
    uAtmosphereScaleHeight: { value: 0.008 },
    uOzonePeakHeight: { value: 0.018 },
    uOzoneWidth: { value: 0.006 },
    // Phase 19C.2 — restrained ray-marched atmosphere on the surface so the
    // limb scatter no longer washes the day side with neon blue.
    uAtmosphereIntensity: { value: 0.95 },
    // Spectral aerial perspective. Same 1/λ^4-ish proportions as Rayleigh
    // but tuned weaker and scaled by uAerialStrength so documentation
    // captures can dial photographic haze separately from limb scatter.
    uAerialBeta: { value: new Vector3(0.10, 0.28, 0.82) },
    uAerialStrength: { value: 0.42 },
    // Finite sun disk: real sun subtends ~0.27° from Earth's surface.
    // We expose radians so the disk can be dialed tighter for "noon on
    // open water" captures (value ~0.0047) or broadened for cinematic
    // softness without reintroducing the pow() spike.
    uSunAngularRadius: { value: 0.0095 },
    uSunDiskSoftness: { value: 0.0040 },
    // Phase 19C.2 — restrained sun-disk + glare on the ocean. The glint
    // should read as cinematic reflected sunlight rather than a neon spike.
    uSunDiskBrightness: { value: 0.95 },
    uOceanGlareStrength: { value: 0.20 },
    uOceanRoughness: { value: 0.36 },
    // Phase 10B Part 5 — per-frame driver for sub-pixel highlight jitter.
    // Updated once per frame from the renderer (same counter as the cloud
    // shader's uFrameIndex so the golden-ratio sequences stay in phase).
    uFrameIndex: { value: 0 },
  };
}
