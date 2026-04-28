"use client";

import { useEffect, useMemo } from "react";
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  LineBasicMaterial,
  LinearFilter,
  Sprite,
  SpriteMaterial,
} from "three";

import { latLonToVector3 } from "@/lib/three/coordinate";
import { SCENE_RENDER_ORDER } from "@/lib/three/globeSceneConfig";

const LINE_RADIUS = 1.014;
const LABEL_RADIUS = 1.09;
const SAMPLES = 180;
const LABELS = [
  { id: "origin", text: "0,0", lat: 0, lon: 0 },
  { id: "east", text: "0,90E", lat: 0, lon: 90 },
  { id: "west", text: "0,90W", lat: 0, lon: -90 },
  { id: "north", text: "45N,0", lat: 45, lon: 0 },
] as const;

export function GlobeDiagnosticsLayer() {
  const geometry = useMemo(() => buildDiagnosticsGeometry(), []);
  const material = useMemo(
    () =>
      new LineBasicMaterial({
        color: new Color("#d6b889"),
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
        depthTest: true,
      }),
    []
  );
  const sprites = useMemo(
    () =>
      LABELS.map((label) => {
        const texture = createLabelTexture(label.text);
        const spriteMaterial = new SpriteMaterial({
          map: texture,
          transparent: true,
          depthWrite: false,
          depthTest: true,
          opacity: 0.92,
        });
        const sprite = new Sprite(spriteMaterial);
        sprite.position.copy(latLonToVector3(label.lat, label.lon, LABEL_RADIUS));
        sprite.scale.set(0.22, 0.06, 1);
        sprite.renderOrder = SCENE_RENDER_ORDER.diagnosticsLabels;
        return {
          id: label.id,
          texture,
          material: spriteMaterial,
          sprite,
        };
      }),
    []
  );

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
      for (const sprite of sprites) {
        sprite.texture.dispose();
        sprite.material.dispose();
      }
    };
  }, [geometry, material, sprites]);

  return (
    <>
      <lineSegments geometry={geometry} material={material} renderOrder={SCENE_RENDER_ORDER.diagnosticsLines} />
      <group>
        {sprites.map((entry) => (
          <primitive key={entry.id} object={entry.sprite} />
        ))}
      </group>
    </>
  );
}

function buildDiagnosticsGeometry() {
  const points: number[] = [];
  appendLatitudeLine(points, 0, -180, 180, LINE_RADIUS);
  appendLongitudeLine(points, 0, -89.5, 89.5, LINE_RADIUS);
  appendLongitudeLine(points, 180, -89.5, 89.5, LINE_RADIUS);

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(points, 3));
  return geometry;
}

function appendLatitudeLine(points: number[], latitude: number, startLon: number, endLon: number, radius: number) {
  let previous = latLonToVector3(latitude, startLon, radius);
  for (let index = 1; index <= SAMPLES; index += 1) {
    const lon = startLon + ((endLon - startLon) * index) / SAMPLES;
    const current = latLonToVector3(latitude, lon, radius);
    points.push(previous.x, previous.y, previous.z, current.x, current.y, current.z);
    previous = current;
  }
}

function appendLongitudeLine(points: number[], longitude: number, startLat: number, endLat: number, radius: number) {
  let previous = latLonToVector3(startLat, longitude, radius);
  for (let index = 1; index <= SAMPLES; index += 1) {
    const lat = startLat + ((endLat - startLat) * index) / SAMPLES;
    const current = latLonToVector3(lat, longitude, radius);
    points.push(previous.x, previous.y, previous.z, current.x, current.y, current.z);
    previous = current;
  }
}

function createLabelTexture(text: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 88;
  const context = canvas.getContext("2d");
  if (!context) {
    return new CanvasTexture(canvas);
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(5, 10, 15, 0.8)";
  context.strokeStyle = "rgba(214, 184, 137, 0.34)";
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(10, 10, canvas.width - 20, canvas.height - 20, 18);
  context.fill();
  context.stroke();

  context.fillStyle = "#f0e2c7";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = "600 26px IBM Plex Mono, monospace";
  context.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
