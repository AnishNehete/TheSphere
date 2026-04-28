import { ACESFilmicToneMapping, Camera, Scene, SRGBColorSpace, Vector2, WebGLRenderer } from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

import {
  BLOOM_RADIUS,
  BLOOM_STRENGTH,
  BLOOM_THRESHOLD,
  GLOBE_RENDER_QUALITY,
  TONE_MAPPING_EXPOSURE,
} from "@/lib/three/globeSceneConfig";
import type { DiagnosticsView, GlobeQualityPreset } from "@/lib/types";

const VIGNETTE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uVignetteStrength: { value: 0.13 },
    uContrast: { value: 1.05 },
    uLift: { value: 0.018 },
    uSaturation: { value: 1.03 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uVignetteStrength;
    uniform float uContrast;
    uniform float uLift;
    uniform float uSaturation;
    varying vec2 vUv;

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      vec2 uv = vUv * 2.0 - 1.0;
      float vignette = 1.0 - dot(uv * vec2(0.85, 1.08), uv) * uVignetteStrength;
      vec3 graded = (color.rgb - 0.5) * uContrast + 0.5;
      float luminance = dot(graded, vec3(0.2126, 0.7152, 0.0722));
      graded = mix(vec3(luminance), graded, uSaturation);
      graded += uLift * vec3(0.03, 0.05, 0.09);
      graded *= clamp(vignette, 0.0, 1.0);
      gl_FragColor = vec4(graded, color.a);
    }
  `,
};

export class RendererLayer {
  readonly renderer: WebGLRenderer;

  readonly composer: EffectComposer;

  private readonly bloomPass: UnrealBloomPass;

  private readonly vignettePass: ShaderPass;

  private readonly renderPass: RenderPass;

  constructor() {
    this.renderer = new WebGLRenderer({
      antialias: true,
      alpha: false,
      logarithmicDepthBuffer: true,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(null as never, null as never);
    this.bloomPass = new UnrealBloomPass(new Vector2(1, 1), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    this.vignettePass = new ShaderPass(VIGNETTE_SHADER);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.vignettePass);
  }

  get domElement() {
    return this.renderer.domElement;
  }

  get maxAnisotropy() {
    return Math.max(4, this.renderer.capabilities.getMaxAnisotropy());
  }

  attach(container: HTMLElement) {
    if (this.renderer.domElement.parentElement !== container) {
      container.appendChild(this.renderer.domElement);
    }
  }

  setSceneCamera(scene: Scene, camera: Camera) {
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
  }

  applySettings(qualityPreset: GlobeQualityPreset, diagnosticsEnabled: boolean, diagnosticsView: DiagnosticsView) {
    const quality = GLOBE_RENDER_QUALITY[qualityPreset];
    this.renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;
    this.bloomPass.strength = diagnosticsEnabled && diagnosticsView !== "full" ? 0 : quality.bloomStrength;
    this.bloomPass.radius = diagnosticsEnabled && diagnosticsView !== "full" ? 0 : quality.bloomRadius;
    this.bloomPass.threshold = diagnosticsEnabled && diagnosticsView !== "full" ? 1 : quality.bloomThreshold;
    this.vignettePass.uniforms.uVignetteStrength.value = diagnosticsEnabled && diagnosticsView !== "full" ? 0.06 : quality.vignetteStrength;
    this.vignettePass.uniforms.uContrast.value = quality.contrast;
    this.vignettePass.uniforms.uSaturation.value = quality.saturation;
  }

  resize(width: number, height: number, dpr: number, qualityPreset: GlobeQualityPreset) {
    const quality = GLOBE_RENDER_QUALITY[qualityPreset];
    const pixelRatio = Math.min(dpr, quality.dprMax);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(useComposer: boolean) {
    if (useComposer) {
      this.composer.render();
      return;
    }

    this.renderer.render(this.renderPass.scene, this.renderPass.camera);
  }

  dispose() {
    this.composer.dispose();
    this.renderer.dispose();
  }
}
