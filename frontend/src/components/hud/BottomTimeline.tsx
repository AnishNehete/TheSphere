"use client";

import { useMemo } from "react";

import { GlassPanel } from "@/components/ui/GlassPanel";
import { useDataStore } from "@/store/useDataStore";
import { useGlobeStore } from "@/store/useGlobeStore";
import { useLayerStore } from "@/store/useLayerStore";

import { buildSignalRows, filterRowsByFocus, formatTimeStampCompact, LAYER_LABELS } from "./signalRows";

export function BottomTimeline() {
  const activeLayer = useLayerStore((state) => state.activeLayer);
  const setActiveLayer = useLayerStore((state) => state.setActiveLayer);
  const flights = useDataStore((state) => state.flights);
  const weather = useDataStore((state) => state.weather);
  const conflicts = useDataStore((state) => state.conflicts);
  const health = useDataStore((state) => state.health);
  const regions = useDataStore((state) => state.regions);

  const selectedCountry = useGlobeStore((state) => state.selectedCountry);
  const selectedRegionSlug = useGlobeStore((state) => state.selectedRegionSlug);
  const focusSignal = useGlobeStore((state) => state.focusSignal);

  const region = useMemo(
    () => regions.find((entry) => entry.slug === selectedRegionSlug) ?? null,
    [regions, selectedRegionSlug]
  );
  const rows = useMemo(() => {
    const events = buildSignalRows(
      {
        flights,
        weather,
        conflicts,
        health,
      },
      activeLayer,
      12
    );

    return filterRowsByFocus(events, selectedCountry, region).sort(
      (left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime()
    );
  }, [activeLayer, conflicts, flights, health, region, selectedCountry, weather]);

  const onEventSelect = (event: (typeof rows)[number]) => {
    setActiveLayer(event.layer);
    focusSignal(event.id, event.iso3Hint ?? null);
  };

  return (
    <GlassPanel as="section" className="bottom-timeline" aria-label="Activity Timeline">
      <div className="bottom-timeline__head">
        <span>{LAYER_LABELS[activeLayer]} Activity</span>
      </div>
      <div className="bottom-timeline__rail">
        {rows.slice(0, 4).map((row) => (
          <button type="button" key={row.id} className="bottom-timeline__event" onClick={() => onEventSelect(row)}>
            <span>{formatTimeStampCompact(row.timestamp)}Z</span>
            <strong>{row.title}</strong>
          </button>
        ))}
      </div>
    </GlassPanel>
  );
}
