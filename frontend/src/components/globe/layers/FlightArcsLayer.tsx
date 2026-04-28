"use client";

import { useEffect, useMemo } from "react";
import { AdditiveBlending, BufferGeometry, Color, Float32BufferAttribute, LineBasicMaterial } from "three";

import { createArcCurve } from "@/lib/three/curveFactory";
import { latLonToVector3 } from "@/lib/three/coordinate";
import { SCENE_RENDER_ORDER } from "@/lib/three/globeSceneConfig";
import type { FlightSignal } from "@/lib/types";

interface FlightArcsLayerProps {
  flights: FlightSignal[];
  visible: boolean;
}

export function FlightArcsLayer({ flights, visible }: FlightArcsLayerProps) {
  const geometry = useMemo(() => {
    const points: number[] = [];
    for (const flight of flights.slice(0, 120)) {
      const from = latLonToVector3(flight.originPoint.lat, flight.originPoint.lon, 1.012);
      const to = latLonToVector3(flight.destinationPoint.lat, flight.destinationPoint.lon, 1.012);
      const curve = createArcCurve(from, to, 0.09 + flight.severity * 0.05);
      const sampled = curve.getPoints(20);
      for (let index = 1; index < sampled.length; index += 1) {
        const prev = sampled[index - 1];
        const current = sampled[index];
        points.push(prev.x, prev.y, prev.z, current.x, current.y, current.z);
      }
    }

    const nextGeometry = new BufferGeometry();
    nextGeometry.setAttribute("position", new Float32BufferAttribute(points, 3));
    return nextGeometry;
  }, [flights]);

  // Phase 3.7 — flight arcs are signal content, not a cartographic shell, but
  // the additive linework still compounds with the calmed border layer at wide
  // framing. Drop the base opacity from 0.12 → 0.06 so the network reads as a
  // gentle hint of routing density rather than a glowing mesh on top of the
  // planet. The 50% cut matches the spirit of OVERLAY_OPACITY_MULT (0.72 → 0.25)
  // without coupling flight signal visibility to the border tuning knob.
  const material = useMemo(
    () =>
      new LineBasicMaterial({
        color: new Color("#7f9baa"),
        transparent: true,
        opacity: 0.06,
        blending: AdditiveBlending,
        depthTest: true,
        depthWrite: false,
      }),
    []
  );

  useEffect(() => {
    return () => {
      material.dispose();
    };
  }, [material]);

  useEffect(() => {
    return () => {
      geometry.dispose();
    };
  }, [geometry]);

  if (!visible) {
    return null;
  }

  return <lineSegments geometry={geometry} material={material} renderOrder={SCENE_RENDER_ORDER.flightArcs} />;
}
