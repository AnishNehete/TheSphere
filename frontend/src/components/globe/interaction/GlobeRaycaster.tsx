"use client";

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Raycaster, Vector2, type Mesh } from "three";

import { buildAnalystSummary, buildSignalRows } from "@/components/hud/signalRows";
import { vector3ToLatLon } from "@/lib/three/coordinate";
import { findCountryAtLatLon } from "@/lib/three/geo";
import { useAppStore } from "@/store/useAppStore";
import { useDataStore } from "@/store/useDataStore";

interface GlobeRaycasterProps {
  earthRef: { current: Mesh | null };
}

export function GlobeRaycaster({ earthRef }: GlobeRaycasterProps) {
  const { camera, gl } = useThree();
  const raycaster = useMemo(() => new Raycaster(), []);
  const pointer = useMemo(() => new Vector2(), []);

  const interactionMode = useAppStore((state) => state.interactionMode);
  const userInteracting = useAppStore((state) => state.userInteracting);
  const diagnosticsEnabled = useAppStore((state) => state.diagnosticsEnabled);
  const flights = useDataStore((state) => state.flights);
  const weather = useDataStore((state) => state.weather);
  const conflicts = useDataStore((state) => state.conflicts);
  const health = useDataStore((state) => state.health);
  const countryMetrics = useDataStore((state) => state.countryMetrics);

  const focusCountry = useAppStore((state) => state.focusCountry);
  const setHoveredCountry = useAppStore((state) => state.setHoveredCountry);
  const setHoverTooltip = useAppStore((state) => state.setHoverTooltip);
  const clearQueryBrief = useAppStore((state) => state.clearQueryBrief);

  const isLive = interactionMode !== "boot" && interactionMode !== "intro";

  const allRows = useMemo(
    () =>
      buildSignalRows(
        {
          flights,
          weather,
          conflicts,
          health,
        },
        "global",
        400
      ),
    [conflicts, flights, health, weather]
  );

  useEffect(() => {
    if (diagnosticsEnabled) {
      setHoveredCountry(null);
      setHoverTooltip(null);
      return;
    }

    const canvas = gl.domElement;
    canvas.style.cursor = "grab";

    const pickCountry = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(pointer, camera);
      if (!earthRef.current) {
        return null;
      }

      const intersections = raycaster.intersectObject(earthRef.current, false);
      if (intersections.length === 0) {
        return null;
      }

      const point = intersections[0].point;
      const latLon = vector3ToLatLon(point);
      const country = findCountryAtLatLon(latLon.lat, latLon.lon);
      return { country, latLon };
    };

    // Phase 19C — RAF-throttle hover. The pointermove event fires at native
    // input cadence (often 120-240 Hz on premium laptops), and each tick was
    // running a Three.js raycast + GeoJSON country lookup + analyst-summary
    // build. Coalescing to one pick per frame keeps interaction crisp at
    // 60 fps without tying hover work to input frequency.
    let pendingX = 0;
    let pendingY = 0;
    let rafId = 0;
    let hasPending = false;

    const runHover = () => {
      rafId = 0;
      if (!hasPending) {
        return;
      }
      hasPending = false;

      if (userInteracting) {
        setHoveredCountry(null);
        setHoverTooltip(null);
        canvas.style.cursor = "grabbing";
        return;
      }

      const hit = pickCountry(pendingX, pendingY);
      if (!hit?.country) {
        setHoveredCountry(null);
        setHoverTooltip(null);
        canvas.style.cursor = "grab";
        return;
      }

      setHoveredCountry(hit.country.iso3);
      canvas.style.cursor = "pointer";
      const countryRows = allRows.filter((row) => row.iso3Hint === hit.country?.iso3);
      const countryMetric = countryMetrics.find((entry) => entry.iso3 === hit.country?.iso3) ?? null;
      const brief = buildAnalystSummary({
        label: hit.country.name,
        rows: countryRows,
        countryMetric,
      });
      setHoverTooltip({
        x: pendingX + 18,
        y: pendingY - 18,
        iso3: hit.country.iso3,
        eyebrow: brief.signalCount > 0 ? `${brief.signalCount} live signals` : "Quiet watch posture",
        title: hit.country.name,
        score: brief.score,
        signalCount: brief.signalCount,
        summary: brief.summary,
        activeLayer: brief.dominantLayer,
      });
    };

    const onPointerMove = (event: PointerEvent) => {
      pendingX = event.clientX;
      pendingY = event.clientY;
      hasPending = true;
      if (rafId === 0) {
        rafId = window.requestAnimationFrame(runHover);
      }
    };

    const onPointerLeave = () => {
      hasPending = false;
      if (rafId !== 0) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      setHoveredCountry(null);
      setHoverTooltip(null);
      canvas.style.cursor = "grab";
    };

    const onClick = (event: PointerEvent) => {
      if (!isLive || userInteracting) {
        return;
      }

      const hit = pickCountry(event.clientX, event.clientY);
      if (!hit?.country) {
        return;
      }

      focusCountry(hit.country.iso3);
      clearQueryBrief();
    };

    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("click", onClick);

    return () => {
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("click", onClick);
      if (rafId !== 0) {
        window.cancelAnimationFrame(rafId);
      }
      canvas.style.cursor = "";
    };
  }, [
    camera,
    allRows,
    countryMetrics,
    diagnosticsEnabled,
    earthRef,
    focusCountry,
    gl.domElement,
    isLive,
    pointer,
    raycaster,
    clearQueryBrief,
    setHoverTooltip,
    setHoveredCountry,
    userInteracting,
  ]);

  return null;
}
