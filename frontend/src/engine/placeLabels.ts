// Phase 12.3 — Zoom-aware place label layer.
//
// Renders a small set of premium, restrained labels (capitals + financial
// hubs + chokepoints + ports) on top of the globe. Visibility is gated on
// camera distance so the wide "explore" view stays clean and labels only
// reveal as the user zooms in.
//
// Visual rules:
//   * tier 1 (capitals / megahubs)   → distance < 3.0
//   * tier 2 (secondary cities)      → distance < 2.0
//   * tier 3 (ports)                 → distance < 1.7
//   * back-face culling — labels on the far side of the globe fade out
//   * opacity ramps with how deep into the tier we are (no hard pop-in)
//   * tiny restraint dot per label so the eye reads anchor + label together
//
// Click-through:
//   * `pickPlaceLabel(clientX, clientY, camera, dom)` returns the topmost
//     visible PlaceLabel under the cursor. The engine wires that into the
//     existing pointer handler so clicks resolve via the agent.

import {
  CanvasTexture,
  Color,
  Group,
  LinearFilter,
  Raycaster,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Texture,
  Vector2,
  Vector3,
} from "three";

import { latLonToVector3 } from "@/lib/three/coordinate";
import { SCENE_RENDER_ORDER } from "@/lib/three/globeSceneConfig";
import {
  PLACE_LABELS,
  PlaceLabel,
  tierForDistance,
} from "@/lib/three/placeGazetteer";

const LABEL_RADIUS = 1.018;
const DOT_RADIUS = 1.013;
const FAR_FACE_FADE_START = 0.05;
const FAR_FACE_FADE_END = -0.18;

interface PlaceLabelEntry {
  place: PlaceLabel;
  position: Vector3;
  normal: Vector3;
  labelSprite: Sprite;
  dotSprite: Sprite;
  texture: Texture;
  baseOpacity: number;
}

function buildLabelTexture(text: string, accent: string): CanvasTexture {
  const dpr = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio ?? 1, 2);
  const canvas = document.createElement("canvas");
  const widthPx = 320;
  const heightPx = 64;
  canvas.width = Math.floor(widthPx * dpr);
  canvas.height = Math.floor(heightPx * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return new CanvasTexture(canvas);
  }
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, widthPx, heightPx);

  ctx.font = "500 14px 'IBM Plex Mono', ui-monospace, monospace";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  const padX = 12;
  const padY = 8;
  const metrics = ctx.measureText(text);
  const textWidth = Math.min(widthPx - padX * 2 - 14, metrics.width);
  const boxWidth = textWidth + padX * 2 + 14;
  const boxHeight = heightPx - padY * 2;
  const x = 0;
  const y = (heightPx - boxHeight) / 2;

  // backdrop pill — restrained, no glow
  ctx.fillStyle = "rgba(8, 12, 18, 0.78)";
  roundRect(ctx, x, y, boxWidth, boxHeight, 6);
  ctx.fill();
  ctx.strokeStyle = "rgba(132, 153, 171, 0.22)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // accent dot inside the pill
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(x + padX, y + boxHeight / 2, 2.4, 0, Math.PI * 2);
  ctx.fill();

  // label text
  ctx.fillStyle = "rgba(232, 240, 250, 0.94)";
  ctx.fillText(text, x + padX + 8, heightPx / 2);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function accentForType(type: PlaceLabel["type"]): string {
  switch (type) {
    case "chokepoint": return "rgba(240, 179, 106, 0.92)";
    case "port":       return "rgba(168, 210, 235, 0.92)";
    case "city":       return "rgba(168, 210, 235, 0.78)";
    case "region":     return "rgba(140, 168, 188, 0.78)";
    default:           return "rgba(168, 210, 235, 0.78)";
  }
}

export class PlaceLabelLayer {
  readonly group = new Group();

  private readonly entries: PlaceLabelEntry[] = [];

  private readonly raycaster = new Raycaster();

  private readonly pointer = new Vector2();

  private readonly cameraDir = new Vector3();

  private readonly entryNormal = new Vector3();

  private cameraDistance = 4.0;

  private enabled = true;

  constructor() {
    this.group.name = "place-labels";
    this.group.renderOrder = SCENE_RENDER_ORDER.labels;
    this.buildEntries();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.group.visible = enabled;
  }

  /**
   * Update label visibility based on camera distance + far-face fade.
   * Called from the engine render loop with the live camera.
   */
  syncToCamera(camera: { position: Vector3 }): void {
    if (!this.enabled) return;
    this.cameraDistance = camera.position.length();
    const visibleTier = tierForDistance(this.cameraDistance);
    this.cameraDir.copy(camera.position).normalize();

    for (const entry of this.entries) {
      const tierVisible = entry.place.tier <= visibleTier;
      if (!tierVisible) {
        entry.labelSprite.visible = false;
        entry.dotSprite.visible = false;
        continue;
      }
      // back-face cull — labels behind the globe fade out smoothly
      this.entryNormal.copy(entry.normal);
      const facing = this.entryNormal.dot(this.cameraDir);
      const faceFade = smoothStep(FAR_FACE_FADE_END, FAR_FACE_FADE_START, facing);
      // distance ramp — labels softly appear as the user zooms in past
      // the threshold instead of popping in.
      const tierThreshold = thresholdForTier(entry.place.tier);
      const innerThreshold = thresholdForTier(
        Math.min(3, entry.place.tier + 1) as 1 | 2 | 3,
      );
      const ramp = smoothStep(tierThreshold, innerThreshold, this.cameraDistance);
      // ramp returns 1 at the outer threshold, 0 closer in. Invert.
      const distanceFade = 1.0 - ramp;
      const alpha = entry.baseOpacity * faceFade * (0.45 + 0.55 * distanceFade);
      const visible = alpha > 0.04;
      entry.labelSprite.visible = visible;
      entry.dotSprite.visible = visible;
      if (visible) {
        const labelMat = entry.labelSprite.material;
        const dotMat = entry.dotSprite.material;
        labelMat.opacity = clamp01(alpha);
        dotMat.opacity = clamp01(alpha * 1.1);
      }
    }
  }

  /**
   * Pick the topmost visible label sprite under a screen-space point.
   * Returns the matching :class:`PlaceLabel`, or `null` when nothing was hit.
   */
  pick(
    clientX: number,
    clientY: number,
    camera: { position: Vector3 },
    domElement: HTMLCanvasElement | HTMLElement,
  ): PlaceLabel | null {
    if (!this.enabled) return null;
    const visibleSprites = this.entries
      .filter((e) => e.labelSprite.visible)
      .map((e) => e.labelSprite);
    if (visibleSprites.length === 0) return null;

    const rect = domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, camera as never);

    const hits = this.raycaster.intersectObjects(visibleSprites, false);
    if (hits.length === 0) return null;
    const sprite = hits[0].object as Sprite;
    const entry = this.entries.find((e) => e.labelSprite === sprite);
    return entry ? entry.place : null;
  }

  dispose(): void {
    for (const entry of this.entries) {
      entry.texture.dispose();
      entry.labelSprite.material.dispose();
      entry.dotSprite.material.dispose();
      this.group.remove(entry.labelSprite);
      this.group.remove(entry.dotSprite);
    }
    this.entries.length = 0;
  }

  private buildEntries(): void {
    for (const place of PLACE_LABELS) {
      const position = latLonToVector3(place.lat, place.lon, LABEL_RADIUS);
      const normal = latLonToVector3(place.lat, place.lon, 1).normalize();
      const accent = accentForType(place.type);
      const texture = buildLabelTexture(place.name, accent);
      const labelMaterial = new SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        opacity: 0,
      });
      const labelSprite = new Sprite(labelMaterial);
      labelSprite.scale.set(0.34, 0.07, 1);
      labelSprite.position.copy(position);
      labelSprite.renderOrder = SCENE_RENDER_ORDER.labels;
      labelSprite.userData.placeId = place.id;
      labelSprite.visible = false;

      const dotMaterial = new SpriteMaterial({
        color: new Color(accent),
        transparent: true,
        depthTest: false,
        depthWrite: false,
        opacity: 0,
      });
      const dotSprite = new Sprite(dotMaterial);
      const dotScale = place.tier === 1 ? 0.012 : place.tier === 2 ? 0.01 : 0.009;
      dotSprite.scale.set(dotScale, dotScale, 1);
      dotSprite.position.copy(latLonToVector3(place.lat, place.lon, DOT_RADIUS));
      dotSprite.renderOrder = SCENE_RENDER_ORDER.labels - 1;
      dotSprite.visible = false;

      this.group.add(dotSprite);
      this.group.add(labelSprite);
      this.entries.push({
        place,
        position,
        normal,
        labelSprite,
        dotSprite,
        texture,
        baseOpacity: place.tier === 1 ? 0.92 : place.tier === 2 ? 0.78 : 0.7,
      });
    }
  }
}

function thresholdForTier(tier: 1 | 2 | 3): number {
  if (tier === 1) return 3.0;
  if (tier === 2) return 2.0;
  return 1.7;
}

function smoothStep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
