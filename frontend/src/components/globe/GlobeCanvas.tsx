"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useRef, useState } from "react";
import { ACESFilmicToneMapping, SRGBColorSpace, Vector2 } from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";

import { GlobeScene } from "@/components/globe/GlobeScene";
import { GlobeIntelligenceDebug } from "@/components/globe/GlobeIntelligenceDebug";
import { useExposureAdaptation } from "@/lib/three/exposureAdapter";
import { GLOBE_RENDER_QUALITY, TONE_MAPPING_EXPOSURE } from "@/lib/three/globeSceneConfig";
import type { DiagnosticsView, GlobeQualityPreset } from "@/lib/types";
import { useAppStore } from "@/store/useAppStore";

// Phase 10C — final-frame envelope.
// -------------------------------------------------------------------
// The Phase 6A pass was a vignette + contrast + saturation + blue-leaning
// lift. Phase 10C adds four restrained captured-image cues on top of that
// base grade:
//   * Rim-only chromatic aberration (uRimChromaAmount) — atmosphere limb
//     gets a sub-pixel R/B offset. Never touches the planet interior. Off
//     on the low tier.
//   * Static lens dust (uLensDustStrength) — a deterministic UV-hash
//     threshold dusting the outermost edges. Never animates.
//   * Static film grain (uGrainStrength) — UV-hash grain weighted toward
//     mid-tones, so shadows and highlights stay clean.
//   * Neutralised lift (uLift) — the old blue-leaning lift is replaced by
//     a warm-neutral triplet so the final image avoids the teal/orange
//     colour-grading cliché.
// Every amplitude is tiny. If any effect becomes individually noticeable
// it has been pushed too far; the tier defaults keep these well below the
// visible threshold on their own but add together into a cohesive
// "photographed" feel.
const VIGNETTE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uVignetteStrength: { value: 0.13 },
    uContrast: { value: 1.05 },
    uLift: { value: 0.022 },
    uSaturation: { value: 1.04 },
    uRimChromaAmount: { value: 0 },
    uLensDustStrength: { value: 0 },
    uGrainStrength: { value: 0 },
    uInvResolution: { value: [1 / 1920, 1 / 1080] as [number, number] },
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
    uniform float uRimChromaAmount;
    uniform float uLensDustStrength;
    uniform float uGrainStrength;
    uniform vec2  uInvResolution;
    varying vec2 vUv;

    float hash12(vec2 p) {
      p = fract(p * vec2(123.34, 345.45));
      p += dot(p, p + 34.345);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 uvN = vUv * 2.0 - 1.0;
      float radial = length(uvN);

      // ----- Rim-only chromatic aberration (Phase 10C Part 5) -----
      // Confined to the outer frame via a rim mask; the radial direction
      // carries R inward and B outward by ~0.5 px at the tier maximum.
      // Inside the rim mask the sampled colour is the composited base
      // pixel — no offset — so the planet interior is untouched.
      vec2 radialDir = length(uvN) > 1e-5 ? uvN / length(uvN) : vec2(0.0);
      float rimMask = smoothstep(0.58, 0.94, radial);
      vec2 pxOffset = radialDir * uInvResolution * uRimChromaAmount;
      vec3 baseColor = texture2D(tDiffuse, vUv).rgb;
      vec3 caColor;
      caColor.r = texture2D(tDiffuse, vUv - pxOffset).r;
      caColor.g = baseColor.g;
      caColor.b = texture2D(tDiffuse, vUv + pxOffset).b;
      vec3 color = mix(baseColor, caColor, rimMask);

      // ----- Base grade (Phase 6A) -----
      vec3 graded = (color - 0.5) * uContrast + 0.5;
      float luminance = dot(graded, vec3(0.2126, 0.7152, 0.0722));
      graded = mix(vec3(luminance), graded, uSaturation);

      // Phase 10C Part 7 — neutral warm-leaning lift. The Phase 6A lift
      // pushed slightly cyan (0.03, 0.05, 0.09), which drifted the black
      // level toward teal. A near-neutral triplet preserves the premium
      // palette without introducing the teal/orange cliché.
      graded += uLift * vec3(0.055, 0.055, 0.060);

      // ----- Static lens dust (Phase 10C Part 6) -----
      // Deterministic UV-hash threshold, weighted to the outer frame so
      // the globe interior stays clean. The dust is additive and stays
      // below the visible threshold at tier defaults; its job is to give
      // edges a faint optical-surface texture, not a dirty-lens gimmick.
      float dustHash = hash12(vUv * vec2(1730.0, 1691.0));
      float dustSpark = smoothstep(0.986, 1.0, dustHash);
      float dustMask = smoothstep(0.62, 1.08, radial);
      graded += dustSpark * dustMask * uLensDustStrength;

      // ----- Static micro-grain (Phase 10C Part 8) -----
      // UV-hash grain with a mid-tone window. Shadows and highlights
      // receive ~0 amplitude so shadow detail and hot speculars stay
      // clean. The hash is purely spatial, so the grain is frozen
      // between frames — no perceived noise motion.
      float grainHash = hash12(vUv * vec2(511.0, 509.0)) - 0.5;
      float grainLuma = dot(graded, vec3(0.2126, 0.7152, 0.0722));
      float grainMask = smoothstep(0.04, 0.32, grainLuma) * (1.0 - smoothstep(0.72, 0.96, grainLuma));
      graded += grainHash * grainMask * uGrainStrength;

      // ----- Vignette (unchanged balance) -----
      float vignette = 1.0 - dot(uvN * vec2(0.85, 1.08), uvN) * uVignetteStrength;
      graded *= clamp(vignette, 0.0, 1.0);

      gl_FragColor = vec4(graded, 1.0);
    }
  `,
};

export function GlobeCanvas() {
  const [maxAnisotropy, setMaxAnisotropy] = useState(8);
  const diagnosticsEnabled = useAppStore((state) => state.diagnosticsEnabled);
  const diagnosticsView = useAppStore((state) => state.diagnosticsView);
  const geoAuditEnabled = useAppStore((state) => state.geoAuditEnabled);
  const geoAudit = useAppStore((state) => state.geoAudit);
  const qualityPreset = useAppStore((state) => state.qualityPreset);
  const qualitySettings = GLOBE_RENDER_QUALITY[qualityPreset];

  return (
    <div className="globe-canvas-shell" data-testid="globe-canvas">
      <GlobeIntelligenceDebug />
      <Canvas
        dpr={[1, qualitySettings.dprMax]}
        camera={{ fov: 30, near: 0.01, far: 120, position: [0, 0, 4] }}
        gl={{
          antialias: true,
          alpha: false,
          logarithmicDepthBuffer: true,
          powerPreference: "high-performance",
        }}
        onCreated={({ gl }) => {
          gl.outputColorSpace = SRGBColorSpace;
          gl.toneMapping = ACESFilmicToneMapping;
          gl.toneMappingExposure = TONE_MAPPING_EXPOSURE;
          setMaxAnisotropy(Math.max(4, gl.capabilities.getMaxAnisotropy()));
          useAppStore.getState().setEngineReady(true);
        }}
      >
        <color attach="background" args={["#020308"]} />
        <Suspense fallback={null}>
          <GlobeScene maxAnisotropy={maxAnisotropy} />
        </Suspense>
        <CinematicPostProcessing
          diagnosticsEnabled={diagnosticsEnabled}
          diagnosticsView={diagnosticsView}
          geoAuditEnabled={geoAuditEnabled}
          postprocessingEnabled={!geoAuditEnabled || geoAudit.postprocessing}
          qualityPreset={qualityPreset}
        />
      </Canvas>
    </div>
  );
}

interface CinematicPostProcessingProps {
  diagnosticsEnabled: boolean;
  diagnosticsView: DiagnosticsView;
  geoAuditEnabled: boolean;
  postprocessingEnabled: boolean;
  qualityPreset: GlobeQualityPreset;
}

function CinematicPostProcessing({
  diagnosticsEnabled,
  diagnosticsView,
  geoAuditEnabled,
  postprocessingEnabled,
  qualityPreset,
}: CinematicPostProcessingProps) {
  const { gl, scene, camera, size } = useThree();
  const composerRef = useRef<EffectComposer | null>(null);
  const vignetteRef = useRef<ShaderPass | null>(null);
  const qualitySettings = GLOBE_RENDER_QUALITY[qualityPreset];
  const postDisabled = geoAuditEnabled && !postprocessingEnabled;
  const bloomStrength = diagnosticsEnabled && diagnosticsView !== "full" ? 0 : qualitySettings.bloomStrength;
  const bloomRadius = diagnosticsEnabled && diagnosticsView !== "full" ? 0 : qualitySettings.bloomRadius;
  const bloomThreshold = diagnosticsEnabled && diagnosticsView !== "full" ? 1 : qualitySettings.bloomThreshold;

  // Phase 10C — soft exposure adaptation. Disabled when diagnostics are on
  // (diagnostics rely on a fixed exposure for stable colour-picking) and
  // on the low tier; otherwise the hook nudges gl.toneMappingExposure with
  // a slow IIR. Always called to keep hook order stable.
  useExposureAdaptation({
    enabled: qualitySettings.exposureAdaptationEnabled && !diagnosticsEnabled && !geoAuditEnabled,
  });

  useEffect(() => {
    if (postDisabled) {
      composerRef.current?.dispose();
      composerRef.current = null;
      vignetteRef.current = null;
      return;
    }

    const composer = new EffectComposer(gl);
    const renderPass = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(new Vector2(size.width, size.height), bloomStrength, bloomRadius, bloomThreshold);
    const vignette = new ShaderPass(VIGNETTE_SHADER);
    vignette.uniforms.uVignetteStrength.value = diagnosticsEnabled && diagnosticsView !== "full" ? 0.08 : qualitySettings.vignetteStrength;
    vignette.uniforms.uContrast.value = qualitySettings.contrast;
    vignette.uniforms.uSaturation.value = qualitySettings.saturation;
    // Phase 10C — pass the tier's envelope knobs. In diagnostics / geo-audit
    // modes the optical cues are all forced to zero so picking and audit
    // overlays read at their native colour.
    const diagnosticsBypass = diagnosticsEnabled || geoAuditEnabled;
    vignette.uniforms.uRimChromaAmount.value = diagnosticsBypass ? 0 : qualitySettings.rimChromaAmount;
    vignette.uniforms.uLensDustStrength.value = diagnosticsBypass ? 0 : qualitySettings.lensDustStrength;
    vignette.uniforms.uGrainStrength.value = diagnosticsBypass ? 0 : qualitySettings.grainStrength;
    (vignette.uniforms.uInvResolution.value as [number, number])[0] = 1 / Math.max(size.width, 1);
    (vignette.uniforms.uInvResolution.value as [number, number])[1] = 1 / Math.max(size.height, 1);
    vignetteRef.current = vignette;

    composer.addPass(renderPass);
    composer.addPass(bloomPass);

    // Phase 6A — FXAA spatial anti-aliasing. Inserted after bloom (which
    // can introduce aliased edges) and before the vignette/grade pass.
    // Reduces line crawl on borders, star shimmer, and cloud edge aliasing
    // without the ghosting risk of full temporal AA.
    if (qualitySettings.fxaaEnabled) {
      const pixelRatio = Math.min(window.devicePixelRatio ?? 1, qualitySettings.dprMax);
      const fxaaPass = new ShaderPass(FXAAShader);
      fxaaPass.uniforms["resolution"].value.set(
        1 / (size.width * pixelRatio),
        1 / (size.height * pixelRatio)
      );
      composer.addPass(fxaaPass);
    }

    composer.addPass(vignette);
    composer.setSize(size.width, size.height);
    composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, qualitySettings.dprMax));
    composerRef.current = composer;

    return () => {
      composer.dispose();
      composerRef.current = null;
    };
  }, [
    bloomRadius,
    bloomStrength,
    bloomThreshold,
    camera,
    diagnosticsEnabled,
    diagnosticsView,
    geoAuditEnabled,
    postDisabled,
    gl,
    qualitySettings.contrast,
    qualitySettings.dprMax,
    qualitySettings.grainStrength,
    qualitySettings.lensDustStrength,
    qualitySettings.rimChromaAmount,
    qualitySettings.saturation,
    qualitySettings.vignetteStrength,
    scene,
    size.height,
    size.width,
  ]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) {
      return;
    }
    composer.setSize(size.width, size.height);
    const vignette = vignetteRef.current;
    if (vignette) {
      const inv = vignette.uniforms.uInvResolution.value as [number, number];
      inv[0] = 1 / Math.max(size.width, 1);
      inv[1] = 1 / Math.max(size.height, 1);
    }
  }, [size.height, size.width]);

  useFrame((_, delta) => {
    if (postDisabled) {
      gl.render(scene, camera);
      return;
    }
    composerRef.current?.render(delta);
  }, 1);

  return null;
}
