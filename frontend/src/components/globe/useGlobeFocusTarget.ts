"use client";

import { useMemo } from "react";

import { resolveOrbitTarget } from "@/lib/three/camera";
import { centroidForIso3 } from "@/lib/three/geo";
import { useAppStore } from "@/store/useAppStore";
import { useDataStore } from "@/store/useDataStore";

export function useGlobeFocusTarget() {
  const selectedCountry = useAppStore((state) => state.selectedCountry);
  const selectedRegionSlug = useAppStore((state) => state.selectedRegionSlug);
  const selectedSignalId = useAppStore((state) => state.selectedSignalId);

  const flights = useDataStore((state) => state.flights);
  const weather = useDataStore((state) => state.weather);
  const conflicts = useDataStore((state) => state.conflicts);
  const health = useDataStore((state) => state.health);
  const regions = useDataStore((state) => state.regions);

  const selectedCountryCentroid = useMemo(
    () => (selectedCountry ? centroidForIso3(selectedCountry) : null),
    [selectedCountry]
  );
  const selectedRegion = useMemo(
    () => regions.find((entry) => entry.slug === selectedRegionSlug) ?? null,
    [regions, selectedRegionSlug]
  );
  const selectedSignalPoint = useMemo(() => {
    const rows = [...flights, ...weather, ...conflicts, ...health];
    const signal = rows.find((entry) => entry.id === selectedSignalId);
    if (!signal) {
      return null;
    }

    if ("position" in signal) {
      return signal.position;
    }

    return signal.center;
  }, [conflicts, flights, health, selectedSignalId, weather]);

  const orbitTarget = useMemo(
    () =>
      resolveOrbitTarget({
        countryLatLon: selectedCountryCentroid,
        signalLatLon: selectedSignalPoint,
        regionLatLon: selectedRegion?.centroid ?? null,
      }),
    [selectedCountryCentroid, selectedRegion?.centroid, selectedSignalPoint]
  );

  return {
    selectedCountry,
    selectedRegionSlug,
    selectedSignalId,
    selectedCountryCentroid,
    selectedRegion,
    selectedSignalPoint,
    orbitTarget,
  };
}
