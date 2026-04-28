import {
  AdditiveBlending,
  AmbientLight,
  BackSide,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Texture,
  Vector3,
} from "three";

import { GlobeSystem } from "@/engine/globe";
import {
  GLOBE_RENDER_QUALITY,
  SCENE_RENDER_ORDER,
  STARFIELD_OPACITY,
  STARFIELD_ROTATION_SPEED,
  STARFIELD_TINT,
  SUN_DIRECTION,
  SUN_POSITION,
} from "@/lib/three/globeSceneConfig";
import type { AppState } from "@/store/useAppStore";
import { useDataStore } from "@/store/useDataStore";

// Keep the glare well below "hero lens flare" territory: it should only add a
// restrained sun cue on the lit rim, not read as a bright reflective hotspot.
const SOLAR_GLARE_LAYERS = [
  { color: "#fff2d6", opacity: 0.08, distance: 1.21, scale: 1.75 },
  { color: "#ffd39c", opacity: 0.032, distance: 1.17, scale: 3.05 },
  { color: "#8eb8ff", opacity: 0.014, distance: 1.13, scale: 4.35 },
] as const;

export class SceneGraph {
  readonly scene = new Scene();

  readonly globe = new GlobeSystem();

  readonly sunDirection = SUN_DIRECTION.clone();

  private readonly worldRoot = this.globe.group;

  private readonly cameraDirection = new Vector3();

  private readonly starfieldGeometry = new SphereGeometry(60, 64, 64);

  private readonly starfieldMaterial = new MeshBasicMaterial({
    color: STARFIELD_TINT.clone(),
    transparent: true,
    opacity: STARFIELD_OPACITY,
    side: BackSide,
    depthWrite: false,
  });

  private readonly starfield = new Mesh(this.starfieldGeometry, this.starfieldMaterial);

  private readonly solarGlareTexture = createSolarGlareTexture();

  private readonly solarGlare = new Group();

  private readonly solarGlareMaterials = SOLAR_GLARE_LAYERS.map(
    (layer) =>
      new SpriteMaterial({
        map: this.solarGlareTexture,
        color: new Color(layer.color),
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      })
  );

  private readonly solarGlareSprites = SOLAR_GLARE_LAYERS.map((layer, index) => {
    const sprite = new Sprite(this.solarGlareMaterials[index]);
    sprite.position.copy(this.sunDirection).multiplyScalar(layer.distance);
    sprite.scale.set(layer.scale, layer.scale, 1);
    sprite.renderOrder = SCENE_RENDER_ORDER.solarGlare;
    return sprite;
  });

  private solarGlareOpacityScale = 1;

  private readonly keyLight = new DirectionalLight(new Color("#ffffff"), 1.8);

  private readonly fillLight = new DirectionalLight(new Color("#89abc5"), 0.3);

  private readonly ambientLight = new AmbientLight(new Color("#d7e2ef"), 0.16);

  constructor() {
    this.scene.background = new Color("#02050a");
    this.starfield.renderOrder = SCENE_RENDER_ORDER.stars;
    this.solarGlare.name = "solar-glare";
    this.keyLight.position.copy(SUN_POSITION);
    this.fillLight.position.copy(SUN_POSITION.clone().multiplyScalar(-0.55).add(new Vector3(-1.2, 0.9, 0.6)));
    for (const sprite of this.solarGlareSprites) {
      this.solarGlare.add(sprite);
    }
    this.scene.add(this.starfield);
    this.scene.add(this.solarGlare);
    this.scene.add(this.ambientLight);
    this.scene.add(this.keyLight);
    this.scene.add(this.fillLight);
    this.scene.add(this.worldRoot);
  }

  setStarfieldTexture(texture: Texture) {
    this.starfieldMaterial.map = texture;
    this.starfieldMaterial.needsUpdate = true;
  }

  setViewportHeight(height: number) {
    this.globe.setViewportHeight(height);
  }

  syncState(state: AppState) {
    const quality = GLOBE_RENDER_QUALITY[state.qualityPreset];
    this.starfieldMaterial.opacity = state.diagnosticsEnabled && state.diagnosticsView !== "full" ? 0.02 : quality.starfieldOpacity;
    this.starfield.visible = !state.diagnosticsEnabled || state.diagnosticsView === "full" || state.diagnosticsView === "earth";
    this.solarGlareOpacityScale = quality.solarGlareOpacityScale;
    this.solarGlare.visible = !state.diagnosticsEnabled || state.diagnosticsView === "full";
    this.globe.syncState(state);
  }

  syncData(dataState: ReturnType<typeof useDataStore.getState>, state: AppState) {
    this.globe.syncData(dataState, state);
  }

  update(deltaSeconds: number, elapsedSeconds: number, state: AppState, cameraPosition: Vector3) {
    if (!state.diagnosticsEnabled) {
      this.starfield.rotation.y += deltaSeconds * STARFIELD_ROTATION_SPEED * (state.reduceMotion ? 0.2 : 1);
    }
    this.updateSolarGlare(cameraPosition, state);
    this.globe.update(deltaSeconds, elapsedSeconds, state, cameraPosition);
  }

  dispose() {
    this.globe.dispose();
    this.starfieldGeometry.dispose();
    this.starfieldMaterial.dispose();
    this.solarGlareTexture.dispose();
    for (const material of this.solarGlareMaterials) {
      material.dispose();
    }
  }

  private updateSolarGlare(cameraPosition: Vector3, state: AppState) {
    if (!this.solarGlare.visible) {
      return;
    }

    this.cameraDirection.copy(cameraPosition);
    if (this.cameraDirection.lengthSq() < 1e-5) {
      return;
    }

    this.cameraDirection.normalize();
    const alignment = Math.max(this.cameraDirection.dot(this.sunDirection), 0);
    const alignmentWeight = Math.pow(smoothstep(0.3, 0.98, alignment), 2.1);
    const introBoost = state.interactionMode === "intro" ? 0.84 + state.introProgress * 0.08 : 0.94;
    const glareWeight = alignmentWeight * this.solarGlareOpacityScale * introBoost;

    for (let index = 0; index < this.solarGlareMaterials.length; index += 1) {
      this.solarGlareMaterials[index].opacity = SOLAR_GLARE_LAYERS[index].opacity * glareWeight;
    }
  }
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const normalized = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return normalized * normalized * (3 - 2 * normalized);
}

function createSolarGlareTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;

  const context = canvas.getContext("2d");
  if (!context) {
    return new CanvasTexture(canvas);
  }

  const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, "rgba(255,255,255,0.72)");
  gradient.addColorStop(0.12, "rgba(255,243,219,0.42)");
  gradient.addColorStop(0.3, "rgba(255,205,148,0.14)");
  gradient.addColorStop(0.58, "rgba(142,184,255,0.045)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");

  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
