"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  CanvasTexture,
  Color,
  LinearFilter,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";

import { latLonToVector3 } from "@/lib/three/coordinate";
import { frontFacingFactor } from "@/lib/three/frontFacing";
import { SCENE_RENDER_ORDER } from "@/lib/three/globeSceneConfig";

interface LabelEntry {
  id: string;
  text: string;
  lat: number;
  lon: number;
  severity: number;
}

interface LabelsLayerProps {
  entries: LabelEntry[];
  visible: boolean;
}

interface PreparedLabel {
  id: string;
  sprite: Sprite;
  texture: CanvasTexture;
  material: SpriteMaterial;
  /** Pre-computed unit normal for the front-facing test. */
  normal: Vector3;
  /** Static base opacity (sprite tone, before front-facing fade). */
  baseOpacity: number;
}

const BASE_OPACITY = 0.68;

export function LabelsLayer({ entries, visible }: LabelsLayerProps) {
  const sprites = useMemo<PreparedLabel[]>(() => {
    return entries.slice(0, 10).map((entry) => {
      const texture = createLabelTexture(entry.text, entry.severity);
      const material = new SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: true,
        depthWrite: false,
        opacity: BASE_OPACITY,
      });
      const sprite = new Sprite(material);
      sprite.scale.set(0.18, 0.046, 1);
      sprite.position.copy(latLonToVector3(entry.lat, entry.lon, 1.055));
      sprite.renderOrder = SCENE_RENDER_ORDER.labels;
      const normal = latLonToVector3(entry.lat, entry.lon, 1).normalize();
      return {
        id: entry.id,
        sprite,
        texture,
        material,
        normal,
        baseOpacity: BASE_OPACITY,
      };
    });
  }, [entries]);

  const cameraDir = useRef(new Vector3());

  // Phase 20A.3 — per-frame opacity fade so labels disappear smoothly at
  // the horizon instead of popping when depthTest flips. Sprite material
  // is per-instance here so direct opacity assignment is cheap.
  useFrame(({ camera }) => {
    cameraDir.current.copy(camera.position).normalize();
    for (const entry of sprites) {
      const factor = frontFacingFactor(entry.normal, cameraDir.current);
      entry.material.opacity = entry.baseOpacity * factor;
      // Also collapse scale on hidden side so the sprite contributes
      // nothing to picking and stops uploading vertices off-screen.
      const visibleScale = factor > 0;
      entry.sprite.visible = visibleScale;
    }
  });

  useEffect(() => {
    return () => {
      for (const sprite of sprites) {
        sprite.texture.dispose();
        sprite.material.dispose();
      }
    };
  }, [sprites]);

  if (!visible) {
    return null;
  }

  return (
    <group>
      {sprites.map((entry) => (
        <primitive key={entry.id} object={entry.sprite} />
      ))}
    </group>
  );
}

function createLabelTexture(text: string, severity: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (!context) {
    return new CanvasTexture(canvas);
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(7, 11, 17, 0.4)";
  context.strokeStyle = "rgba(158, 187, 204, 0.16)";
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
