import {
  CanvasTexture,
  Color,
  FrontSide,
  LinearFilter,
  NormalBlending,
  ShaderMaterial,
  Texture,
} from "three";

import {
  configureEarthSurfaceTextures,
  createEarthShaderUniforms,
  EARTH_FRAGMENT_SHADER,
  EARTH_VERTEX_SHADER,
} from "@/lib/three/earthShader";
import {
  CLOUD_LAYER_DEFINITIONS,
  CLOUD_SHADOW_DARKEN,
  CLOUD_SHADOW_DAY_FADE,
  CLOUD_SHADOW_SOFTNESS,
  CLOUD_SHADOW_STRENGTH,
  SUN_DIRECTION,
  type GlobeCloudLayerDefinition,
} from "@/lib/three/globeSceneConfig";
import type { GlobeTextureSet } from "@/lib/three/textureManager";

// The visible cloud shells share a single coverage function and only differ by
// offset, seed, and tuning. The Earth shader consumes the matching offsets via
// createEarthShaderUniforms so projected shadows stay aligned with what is visible.
const CLOUD_SHARED_GLSL = `
  float clamp01(float value) {
    return clamp(value, 0.0, 1.0);
  }

  float cloudNoise(vec2 point) {
    return fract(sin(dot(point, vec2(91.7, 237.5))) * 43758.5453123);
  }

  vec2 scrollCloudUv(vec2 uv, float offset, float layerSeed, float timeValue) {
    float warp = cloudNoise(uv * vec2(18.0, 12.0) + vec2(layerSeed * 17.0, timeValue * 0.035 + layerSeed * 9.0)) - 0.5;
    float latFade = smoothstep(0.02, 0.18, uv.y) * (1.0 - smoothstep(0.82, 0.98, uv.y));
    return vec2(
      fract(uv.x + offset + warp * 0.012),
      clamp(uv.y + warp * 0.005 * latFade, 0.0, 1.0)
    );
  }

  float sampleCloudCoverage(vec2 uv, float offset, float layerSeed, float timeValue) {
    vec2 scrolledUv = scrollCloudUv(uv, offset, layerSeed, timeValue);
    vec2 detailUv = vec2(
      fract(scrolledUv.x * (1.012 + layerSeed * 0.024) + 0.027 * layerSeed),
      clamp(scrolledUv.y + 0.008 * layerSeed, 0.0, 1.0)
    );
    vec2 veilUv = vec2(
      fract(scrolledUv.x * (0.992 - layerSeed * 0.014) - 0.021 * layerSeed),
      clamp(scrolledUv.y * 0.997 + 0.004 * layerSeed, 0.0, 1.0)
    );
    float broad = texture2D(uCloudMap, scrolledUv).a;
    float detail = texture2D(uCloudMap, detailUv).a;
    float veil = texture2D(uCloudMap, veilUv).a;
    float coverage = mix(broad, detail, 0.22);
    coverage = mix(coverage, max(coverage, veil), 0.1);
    return clamp01(coverage);
  }
`;

const CLOUD_VERTEX_SHADER = `
  varying vec3 vWorldNormal;
  varying vec3 vViewDirection;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vViewDirection = normalize(cameraPosition - worldPosition.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const CLOUD_FRAGMENT_SHADER = `
  uniform sampler2D uCloudMap;
  uniform vec3 uSunDirection;
  uniform float uCloudOffset;
  uniform float uTime;
  uniform float uLayerSeed;
  uniform float uCloudAlpha;
  uniform float uCloudBrightness;
  uniform float uCloudShadowSideFade;
  uniform float uLimbBoost;
  uniform float uCloudContrast;

  varying vec3 vWorldNormal;
  varying vec3 vViewDirection;

  const float PI = 3.141592653589793;

  ${CLOUD_SHARED_GLSL}

  vec2 sphericalUv(vec3 direction) {
    vec3 normal = normalize(direction);
    float lon = atan(-normal.z, normal.x);
    float lat = asin(clamp(normal.y, -1.0, 1.0));
    return vec2(fract(lon / (2.0 * PI) + 0.5), lat / PI + 0.5);
  }

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 viewDirection = normalize(vViewDirection);
    vec3 sunDirection = normalize(uSunDirection);
    vec2 uv = sphericalUv(normal);

    float cloud = sampleCloudCoverage(uv, uCloudOffset, uLayerSeed, uTime);
    cloud = smoothstep(0.42, 0.9, cloud);
    cloud = pow(cloud, uCloudContrast);

    float NdotL = dot(normal, sunDirection);
    float lightMask = smoothstep(-0.22, uCloudShadowSideFade, NdotL);
    float rim = pow(1.0 - max(dot(normal, viewDirection), 0.0), 3.0);
    float limb = rim * uLimbBoost;
    float backScatter = pow(1.0 - clamp01(NdotL), 1.8);

    // Phase 17A.3 — cleaner-white base. The previous low-end leaned
    // bluish-grey (0.42, 0.47, 0.56), which made unlit-but-still-visible
    // cloud edges read as smoke instead of cloud. Lifting the low end
    // toward a near-neutral light grey, plus a slightly warmer baseline
    // mix factor, keeps the clouds visibly white wherever they are
    // rendered while still allowing terminator shading to fold in.
    vec3 color = mix(vec3(0.62, 0.64, 0.68), vec3(1.0, 1.0, 1.0), 0.55 + clamp01(NdotL) * 0.45);
    color += vec3(0.18, 0.32, 0.58) * limb * 0.22;
    color += vec3(0.06, 0.08, 0.11) * backScatter * 0.08;
    color *= uCloudBrightness;

    float alpha = cloud * uCloudAlpha;
    alpha *= mix(0.28, 1.0, lightMask);
    alpha += cloud * limb * 0.1;
    alpha = clamp(alpha, 0.0, 0.72);
    if (alpha < 0.015) {
      discard;
    }

    gl_FragColor = vec4(color, alpha);
  }
`;

const HEATMAP_VERTEX_SHADER = `
  attribute float aSize;
  attribute float aIntensity;
  uniform float uViewportHeight;
  varying float vIntensity;

  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vIntensity = aIntensity;
    gl_PointSize = clamp(aSize * uViewportHeight / max(-mvPosition.z, 0.001), 10.0, 42.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const HEATMAP_FRAGMENT_SHADER = `
  uniform vec3 uBaseColor;
  uniform float uOpacity;
  varying float vIntensity;

  void main() {
    vec2 centered = gl_PointCoord * 2.0 - 1.0;
    float distanceSq = dot(centered, centered);
    if (distanceSq > 1.0) {
      discard;
    }

    float halo = pow(1.0 - distanceSq, 1.8);
    float alpha = halo * uOpacity * mix(0.52, 1.0, vIntensity);
    if (alpha < 0.02) {
      discard;
    }

    vec3 color = mix(uBaseColor * 0.72, vec3(0.84, 0.95, 1.0), vIntensity * 0.32);
    gl_FragColor = vec4(color, alpha);
  }
`;

export function createEarthMaterial(textures: GlobeTextureSet) {
  const [innerLayer, outerLayer] = CLOUD_LAYER_DEFINITIONS;

  configureEarthSurfaceTextures({
    dayMap: textures.day,
    nightMap: textures.night,
    normalMap: textures.normal,
    specularMap: textures.specular,
    cloudShadowMap: textures.clouds,
  });

  return new ShaderMaterial({
    vertexShader: EARTH_VERTEX_SHADER,
    fragmentShader: EARTH_FRAGMENT_SHADER,
    uniforms: createEarthShaderUniforms({
      dayMap: textures.day,
      nightMap: textures.night,
      normalMap: textures.normal,
      specularMap: textures.specular,
      cloudShadowMap: textures.clouds,
      sunDirection: SUN_DIRECTION,
      cloudShadow: {
        enabled: true,
        strength: CLOUD_SHADOW_STRENGTH,
        softness: CLOUD_SHADOW_SOFTNESS,
        dayFade: CLOUD_SHADOW_DAY_FADE,
        darken: CLOUD_SHADOW_DARKEN,
        layers: [
          {
            offset: innerLayer?.offsetBias ?? 0,
            seed: innerLayer?.seed ?? 0.18,
            weight: innerLayer?.shadowWeight ?? 0.72,
          },
          {
            offset: outerLayer?.offsetBias ?? 0.137,
            seed: outerLayer?.seed ?? 0.63,
            weight: outerLayer?.shadowWeight ?? 0.44,
          },
        ],
      },
    }),
    side: FrontSide,
    transparent: false,
    depthTest: true,
    depthWrite: true,
  });
}

export function createCloudMaterial(texture: Texture, layer: GlobeCloudLayerDefinition) {
  return new ShaderMaterial({
    vertexShader: CLOUD_VERTEX_SHADER,
    fragmentShader: CLOUD_FRAGMENT_SHADER,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    // Phase 17A.3 — drop the redundant alphaTest. The shader already
    // discards fragments below 0.015; layering an alphaTest on top
    // pruned a thin band (0.015..0.02) on each frame and produced the
    // intermittent shimmer the operator saw during swipe/orbit. The
    // shader-level discard is sufficient and stable.
    side: FrontSide,
    // Phase 17A.3 — keep the cloud layer out of the scene's tone map.
    // With tone mapping enabled the lit-side highlight clipped toward
    // a faintly bluish cream, which read as "not staying clean white";
    // bypassing tone mapping holds the highlight at neutral white.
    toneMapped: false,
    uniforms: {
      uCloudMap: { value: texture },
      uSunDirection: { value: SUN_DIRECTION.clone().normalize() },
      uCloudOffset: { value: layer.offsetBias },
      uTime: { value: 0 },
      uLayerSeed: { value: layer.seed },
      uCloudAlpha: { value: layer.alpha },
      uCloudBrightness: { value: layer.brightness },
      uCloudShadowSideFade: { value: layer.shadowSideFade },
      uLimbBoost: { value: layer.limbBoost },
      uCloudContrast: { value: layer.contrast },
    },
  });
}

export function createHeatmapMaterial(viewportHeight: number) {
  return new ShaderMaterial({
    vertexShader: HEATMAP_VERTEX_SHADER,
    fragmentShader: HEATMAP_FRAGMENT_SHADER,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: NormalBlending,
    toneMapped: false,
    uniforms: {
      uBaseColor: { value: new Color("#4fa8b8") },
      uOpacity: { value: 0.22 },
      uViewportHeight: { value: viewportHeight },
    },
  });
}

export function createLabelTexture(text: string, severity: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (!context) {
    return new CanvasTexture(canvas);
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(7, 11, 17, 0.5)";
  context.strokeStyle = "rgba(158, 187, 204, 0.18)";
  context.lineWidth = 1.25;
  context.beginPath();
  context.roundRect(6, 8, canvas.width - 12, canvas.height - 16, 16);
  context.fill();
  context.stroke();

  const accent = new Color().setHSL(0.54 - severity * 0.08, 0.28, 0.78);
  context.fillStyle = `#${accent.getHexString()}`;
  context.font = "600 24px Manrope, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text.slice(0, 20).toUpperCase(), canvas.width / 2, canvas.height / 2);

  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
