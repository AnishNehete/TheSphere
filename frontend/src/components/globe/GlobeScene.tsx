"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AdditiveBlending, CanvasTexture, Color, MathUtils, SpriteMaterial, type Mesh, type Sprite } from "three";
import { useFrame } from "@react-three/fiber";

import { GlobeCameraRig } from "@/components/globe/GlobeCameraRig";
import { GlobeControls } from "@/components/globe/GlobeControls";
import { GeoAuditLayer } from "@/components/globe/GeoAuditLayer";
import { GeoAuditPickLayer } from "@/components/globe/GeoAuditPickLayer";
import { GlobeLighting } from "@/components/globe/GlobeLighting";
import { SunDirectionDriver } from "@/components/globe/SunDirectionDriver";
import { CameraPresetsController } from "@/components/globe/CameraPresetsController";
import { AerialPerspective } from "@/components/globe/earth/AerialPerspective";
import { AtmosphereMesh } from "@/components/globe/earth/AtmosphereMesh";
import { CloudsMesh } from "@/components/globe/earth/CloudsMesh";
import { VolumetricCloudsMesh } from "@/components/globe/earth/VolumetricCloudsMesh";
import { EarthMesh } from "@/components/globe/earth/EarthMesh";
import { StarfieldLayer } from "@/components/globe/space/StarfieldLayer";
import { GlobeFocusController } from "@/components/globe/interaction/GlobeFocusController";
import { GlobeRaycaster } from "@/components/globe/interaction/GlobeRaycaster";
import { CountryBordersLayer } from "@/components/globe/layers/CountryBordersLayer";
import { CountryFillLayer } from "@/components/globe/layers/CountryFillLayer";
import { FlightArcsLayer } from "@/components/globe/layers/FlightArcsLayer";
import { HeatmapLayer } from "@/components/globe/layers/HeatmapLayer";
import { LabelsLayer } from "@/components/globe/layers/LabelsLayer";
import { IntelligenceMarkersLayer } from "@/components/globe/layers/IntelligenceMarkersLayer";
import { MarkersLayer } from "@/components/globe/layers/MarkersLayer";
import { PulsesLayer } from "@/components/globe/layers/PulsesLayer";
import { RegionFocusLayer } from "@/components/globe/layers/RegionFocusLayer";
import { LAYER_MODULES } from "@/components/globe/layers/layerModules";
import { CLOUD_LAYER_DEFINITIONS, GLOBE_RENDER_QUALITY, SCENE_RENDER_ORDER, SUN_DIRECTION } from "@/lib/three/globeSceneConfig";
import { loadGlobeTextures, setTextureAnisotropy, type GlobeTextureSet } from "@/lib/three/textureManager";
import type { EarthDebugView } from "@/lib/three/earthShader";
import { createClimatologyTexture } from "@/lib/three/climatology";
import { useCloudCoverageRT } from "@/lib/three/cloudCoverageRT";
import { useCloudHistoryRT } from "@/lib/three/cloudHistoryRT";
import { useSkyCapture } from "@/lib/three/skyCapture";
import { useAppStore } from "@/store/useAppStore";
import { useDataStore } from "@/store/useDataStore";
import { useGlobeIntelligence } from "@/components/globe/useGlobeIntelligence";

interface GlobeSceneProps {
  maxAnisotropy: number;
}

export function GlobeScene({ maxAnisotropy }: GlobeSceneProps) {
  const [textures, setTextures] = useState<GlobeTextureSet | null>(null);
  const earthRef = useRef<Mesh>(null);

  const activeLayer = useAppStore((state) => state.activeLayer);
  const showBorders = useAppStore((state) => state.showBorders);
  const showClouds = useAppStore((state) => state.showClouds);
  const showLabels = useAppStore((state) => state.showLabels);
  const showHeatmap = useAppStore((state) => state.showHeatmap);
  const diagnosticsEnabled = useAppStore((state) => state.diagnosticsEnabled);
  const diagnosticsView = useAppStore((state) => state.diagnosticsView);
  const geoAuditEnabled = useAppStore((state) => state.geoAuditEnabled);
  const geoAudit = useAppStore((state) => state.geoAudit);
  const qualityPreset = useAppStore((state) => state.qualityPreset);

  const flights = useDataStore((state) => state.flights);
  const weather = useDataStore((state) => state.weather);
  const conflicts = useDataStore((state) => state.conflicts);
  const health = useDataStore((state) => state.health);
  const qualitySettings = GLOBE_RENDER_QUALITY[qualityPreset];

  const intelligence = useGlobeIntelligence();

  // Phase 8B — bake the climatology texture once at mount. 256x128 RGBA8
  // (~128 kB) carries the Earth-system backbone (convection, mean cover,
  // ITCZ, storm corridor). Stable across the session, so useMemo with
  // an empty dep array is safe; disposal is scoped to scene teardown.
  const climatologyTexture = useMemo(() => createClimatologyTexture(), []);
  useEffect(() => {
    return () => {
      climatologyTexture.dispose();
    };
  }, [climatologyTexture]);

  // Phase 7B — sky capture must run before the texture early-return so hook
  // order stays stable. The hook tolerates a null cloud texture on the first
  // frame; the only gate is the quality-tier opt-in. Intentionally NOT gated
  // on showClouds/cloudsDimmed/diagnostics: the sky RT is still meaningful
  // without clouds (atmosphere only), and over-gating leaves the EarthMesh
  // sampling a stale RT — producing visible ocean darkening on toggles.
  const skyMapTexture = useSkyCapture({
    cloudTexture: textures?.clouds ?? null,
    enabled: qualitySettings.skyCaptureEnabled,
  });

  // Phase 9A — live cloud-coverage RT. Renders the same weather pipeline
  // the volumetric shader uses into a 512x256 texture the earth shader
  // samples for shadows. Gated on the volumetric tier; low tier still
  // uses the Phase 8B analytic bias fallback inside the earth shader.
  const cloudCoverageRT = useCloudCoverageRT({
    cloudTexture: textures?.clouds ?? null,
    landMaskTexture: textures?.specular ?? null,
    climatologyTexture: climatologyTexture,
    enabled: qualitySettings.volumetricCloudSteps > 0,
    resolution: qualitySettings.coverageRTResolution,
  });

  // Phase 10B Part 1 — framebuffer-history RT for cloud TAA. The hook is
  // always called (hook-order stability), but only captures when the tier
  // enables TAA. When disabled, it returns an inert handle the shader
  // ignores via uTaaEnabled=0.
  const cloudHistory = useCloudHistoryRT({
    enabled: qualitySettings.taaEnabled,
  });

  useEffect(() => {
    let active = true;
    void loadGlobeTextures({
      maxAnisotropy,
    })
      .then((value) => {
        if (!active) {
          return;
        }
        setTextureAnisotropy(value, maxAnisotropy);
        setTextures(value);
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setTextures(null);
      });

    return () => {
      active = false;
    };
  }, [maxAnisotropy]);

  const labelEntries = useMemo(() => {
    const cap = intelligence.labelCap;
    if (activeLayer === "flights") {
      return flights.slice(0, cap).map((signal) => ({
        id: signal.id,
        text: signal.callsign,
        lat: signal.position.lat,
        lon: signal.position.lon,
        severity: signal.severity,
      }));
    }
    if (activeLayer === "weather") {
      return weather.slice(0, cap).map((signal) => ({
        id: signal.id,
        text: signal.label,
        lat: signal.center.lat,
        lon: signal.center.lon,
        severity: signal.severity,
      }));
    }
    if (activeLayer === "conflict") {
      return conflicts.slice(0, cap).map((signal) => ({
        id: signal.id,
        text: signal.label,
        lat: signal.center.lat,
        lon: signal.center.lon,
        severity: signal.severity,
      }));
    }
    return health.slice(0, cap).map((signal) => ({
      id: signal.id,
      text: signal.label,
      lat: signal.center.lat,
      lon: signal.center.lon,
      severity: signal.severity,
    }));
  }, [activeLayer, conflicts, flights, health, intelligence.labelCap, weather]);

  const visibilityContext = useMemo(
    () => ({
      activeLayer,
      showHeatmap,
      showLabels,
    }),
    [activeLayer, showHeatmap, showLabels]
  );

  if (!textures) {
    return null;
  }

  const showDiagnosticsShell = diagnosticsEnabled;
  const showAllDiagnosticsLayers = diagnosticsEnabled && diagnosticsView === "full";
  const showDiagnosticsDots = diagnosticsEnabled && diagnosticsView === "dots";
  const earthDebugView: EarthDebugView =
    diagnosticsEnabled &&
    (diagnosticsView === "uv" || diagnosticsView === "day" || diagnosticsView === "normal" || diagnosticsView === "specular")
      ? diagnosticsView
      : "default";
  const showAtmosphere = geoAuditEnabled ? geoAudit.atmosphere : !diagnosticsEnabled || diagnosticsView === "full" || diagnosticsView === "earth";
  const showCloudLayer = geoAuditEnabled
    ? geoAudit.clouds
    : showClouds && !intelligence.cloudsDimmed && (!diagnosticsEnabled || diagnosticsView === "full" || diagnosticsView === "earth");
  const showSolarGlare = geoAuditEnabled ? false : !diagnosticsEnabled || diagnosticsView === "full";
  const showStars = geoAuditEnabled ? false : !diagnosticsEnabled || diagnosticsView === "full";
  const showBordersLayer = geoAuditEnabled ? geoAudit.borders : showBorders && (!diagnosticsEnabled || diagnosticsView === "full" || diagnosticsView === "borders");
  const showDataLayers = geoAuditEnabled ? false : !diagnosticsEnabled || diagnosticsView === "full" || diagnosticsView === "dots";
  const showFlightArcs = showDataLayers && (showAllDiagnosticsLayers || (!diagnosticsEnabled && LAYER_MODULES.flightArcs.isVisible(visibilityContext)));
  const showHeatmapLayer =
    showDataLayers && (showAllDiagnosticsLayers || showDiagnosticsDots || (!diagnosticsEnabled && LAYER_MODULES.heatmap.isVisible(visibilityContext)));
  const showMarkersLayer =
    showDataLayers && (showAllDiagnosticsLayers || showDiagnosticsDots || (!diagnosticsEnabled && LAYER_MODULES.markers.isVisible(visibilityContext)));
  const showPulseLayer =
    showDataLayers && (showAllDiagnosticsLayers || showDiagnosticsDots || (!diagnosticsEnabled && LAYER_MODULES.pulses.isVisible(visibilityContext)));
  const showLabelsLayer = geoAuditEnabled ? false : diagnosticsEnabled ? diagnosticsView === "full" : showDataLayers && LAYER_MODULES.labels.isVisible(visibilityContext);

  return (
    <>
      <SunDirectionDriver />
      <GlobeCameraRig />
      <GlobeLighting />
      {showSolarGlare ? <SolarGlare opacityScale={qualitySettings.solarGlareOpacityScale} /> : null}
      {showStars ? (
        <StarfieldLayer
          qualityPreset={qualityPreset}
          densityMultiplier={qualitySettings.starDensityMultiplier}
          intensity={qualitySettings.starfieldOpacity}
        />
      ) : null}

      <group>
        <EarthMesh
          ref={earthRef}
          textures={textures}
          cloudShadowMap={showCloudLayer ? textures.clouds : null}
          climatologyMap={climatologyTexture}
          cloudCoverageRT={
            showCloudLayer && qualitySettings.volumetricCloudSteps > 0 ? cloudCoverageRT : null
          }
          segments={qualitySettings.earthSegments}
          debugView={earthDebugView}
          skyMap={qualitySettings.skyCaptureEnabled ? skyMapTexture : null}
          atmosphereSamples={qualitySettings.atmosphereSamples}
        />
        {showAtmosphere ? <AtmosphereMesh segments={qualitySettings.atmosphereSegments} /> : null}
        {showCloudLayer
          ? qualitySettings.volumetricCloudSteps > 0
            ? (
                <VolumetricCloudsMesh
                  texture={textures.clouds}
                  landMask={textures.specular}
                  climatology={climatologyTexture}
                  skyMap={qualitySettings.skyCaptureEnabled ? skyMapTexture : null}
                  stepsMax={qualitySettings.cloudStepsMax}
                  stepsMin={qualitySettings.cloudStepsMin}
                  lightSteps={qualitySettings.volumetricCloudLightSteps}
                  segments={qualitySettings.cloudSegments}
                  freezeMotion={diagnosticsEnabled}
                  taaEnabled={qualitySettings.taaEnabled}
                  taaBlend={qualitySettings.taaBlend}
                  historyHandle={cloudHistory}
                />
              )
            : CLOUD_LAYER_DEFINITIONS.map((layer) => (
                <CloudsMesh
                  key={layer.key}
                  texture={textures.clouds}
                  landMask={textures.specular}
                  radius={layer.radius}
                  segments={qualitySettings.cloudSegments}
                  freezeMotion={diagnosticsEnabled}
                  opacity={layer.alpha}
                  uvSpeed={layer.uvSpeed}
                  offsetBias={layer.offsetBias}
                />
              ))
          : null}
        {showDiagnosticsShell ? <GeoAuditLayer /> : null}
        {geoAuditEnabled ? <GeoAuditLayer /> : null}
        {geoAuditEnabled ? <GeoAuditPickLayer earthRef={earthRef} enabled={geoAudit.pickHits} /> : null}
        <CountryBordersLayer visible={showBordersLayer} opacityScale={intelligence.borderOpacityScale} />
        {geoAuditEnabled ? null : <CountryFillLayer />}
        {geoAuditEnabled ? null : <RegionFocusLayer />}
        <FlightArcsLayer flights={flights} visible={showFlightArcs} />
        <HeatmapLayer weather={weather} health={health} visible={showHeatmapLayer} />
        <MarkersLayer markers={conflicts} visible={showMarkersLayer} />
        <IntelligenceMarkersLayer />
        <PulsesLayer conflicts={conflicts} health={health} visible={showPulseLayer} freezeMotion={diagnosticsEnabled} />
        <LabelsLayer entries={labelEntries} visible={showLabelsLayer} />
      </group>

      {!diagnosticsEnabled && !geoAuditEnabled ? <GlobeRaycaster earthRef={earthRef} /> : null}
      <GlobeFocusController />
      <CameraPresetsController />
      <GlobeControls />
    </>
  );
}

interface SolarGlareProps {
  opacityScale: number;
}

// Phase 10C Part 2 — replaces the Phase 7 three-sprite additive stack with a
// single elegant glare disc whose brightness is driven by the angle between
// the camera-to-origin view direction and the sun direction. Past ~90° from
// the sun the gate falls to zero, so on the far night side the sprite
// contributes nothing. The goal is a photographic "sun at the edge of frame"
// cue, not a cinematic flare chain.
function SolarGlare({ opacityScale }: SolarGlareProps) {
  const texture = useMemo(() => createGlareTexture(), []);
  const spriteRef = useRef<Sprite>(null);
  // Phase 19C.4 — glare strength dialed back from 0.22 → 0.14 so it
  // reads as restrained reflected sunlight at the limb rather than as
  // the dominant visual element. The hotspot bug from Phase 19C.3
  // (white blob over Atlantic) was caused by depthTest: false rendering
  // the sprite ON the day side; depthTest is now enabled so the globe
  // geometry occludes the sprite whenever the sun is on the far side
  // of the planet from the camera.
  const baseOpacity = 0.14 * opacityScale;
  const material = useMemo(
    () =>
      new SpriteMaterial({
        map: texture,
        color: new Color("#ffe2bb"),
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      }),
    [texture]
  );

  useFrame(({ camera }) => {
    // Phase 19C.4 — track the live sun direction and gate by both
    // camera-sun alignment AND screen-space distance from the globe
    // disk. The alignment gate alone leaks a hotspot onto the day-lit
    // hemisphere because at typical orbit framings the sun direction
    // projects through the globe rather than past the limb.
    const sprite = spriteRef.current;
    if (sprite) {
      sprite.position.set(
        SUN_DIRECTION.x * 24,
        SUN_DIRECTION.y * 24,
        SUN_DIRECTION.z * 24
      );
    }
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const camLen = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
    const alignment = (cx * SUN_DIRECTION.x + cy * SUN_DIRECTION.y + cz * SUN_DIRECTION.z) / camLen;

    // Approximate angular distance from sun direction to the globe
    // center as seen from camera. The globe (radius 1) at distance
    // |camera| subtends asin(1/|cam|) — when the sun direction is well
    // outside this disk, the sprite belongs to the limb framing.
    const sunDotCam = alignment;
    const sunAngleFromCenter = Math.acos(MathUtils.clamp(sunDotCam, -1, 1));
    const globeAngularRadius = Math.asin(MathUtils.clamp(1 / camLen, 0, 1));
    const limbBuffer = 0.04;
    const limbGate = MathUtils.smoothstep(
      sunAngleFromCenter,
      globeAngularRadius - limbBuffer,
      globeAngularRadius + limbBuffer * 5
    );

    const hemisphereGate = MathUtils.clamp(alignment, 0, 1);
    material.opacity = baseOpacity * Math.pow(hemisphereGate, 1.1) * limbGate;
  });

  useEffect(() => {
    return () => {
      texture.dispose();
      material.dispose();
    };
  }, [material, texture]);

  return (
    <sprite
      ref={spriteRef}
      renderOrder={SCENE_RENDER_ORDER.solarGlare}
      position={[SUN_DIRECTION.x * 24, SUN_DIRECTION.y * 24, SUN_DIRECTION.z * 24]}
      scale={[9.6, 9.6, 1]}
      material={material}
    />
  );
}

// Phase 10C — tighter glare shape. The Phase 7 texture had hard colour-stop
// jumps and a blue midband that made the 3-sprite stack read as an additive
// cross rather than a soft sun haze. This version is one smooth Airy-like
// disc with a controlled warm body and a short clean fall-off; the halo band
// is intentionally absent so the sprite reads as optical honesty, not VFX.
function createGlareTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;

  const context = canvas.getContext("2d");
  if (!context) {
    return new CanvasTexture(canvas);
  }

  const gradient = context.createRadialGradient(256, 256, 0, 256, 256, 256);
  gradient.addColorStop(0.0, "rgba(255,248,232,0.92)");
  gradient.addColorStop(0.08, "rgba(255,240,212,0.70)");
  gradient.addColorStop(0.22, "rgba(236,206,164,0.28)");
  gradient.addColorStop(0.46, "rgba(168,152,128,0.08)");
  gradient.addColorStop(0.72, "rgba(92,86,76,0.02)");
  gradient.addColorStop(1.0, "rgba(0,0,0,0)");

  context.fillStyle = gradient;
  context.fillRect(0, 0, 512, 512);

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}
