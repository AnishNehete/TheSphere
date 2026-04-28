"use client";

import clsx from "clsx";

import { GlassPanel } from "@/components/ui/GlassPanel";
import { SystemIcon } from "@/components/ui/SystemIcon";
import { useGlobeStore } from "@/store/useGlobeStore";
import { useLayerStore } from "@/store/useLayerStore";
import { useUIStore } from "@/store/useUIStore";

import { LAYER_LABELS } from "./signalRows";

const LAYER_ITEMS: { id: keyof typeof LAYER_LABELS; icon: "flights" | "weather" | "conflict" | "health" }[] = [
  { id: "flights", icon: "flights" },
  { id: "weather", icon: "weather" },
  { id: "conflict", icon: "conflict" },
  { id: "health", icon: "health" },
];

export function LeftRail() {
  const activeLayer = useLayerStore((state) => state.activeLayer);
  const setActiveLayer = useLayerStore((state) => state.setActiveLayer);
  const clearFocus = useGlobeStore((state) => state.clearFocus);
  const clearQueryBrief = useUIStore((state) => state.clearQueryBrief);

  const onLayerSelect = (layer: keyof typeof LAYER_LABELS) => {
    clearFocus();
    clearQueryBrief();
    setActiveLayer(layer);
  };

  return (
    <GlassPanel as="aside" className="left-rail" aria-label="Layer Rail">
      <div className="left-rail__eyebrow">Layers</div>
      <div className="left-rail__stack">
        {LAYER_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={clsx("left-rail__item", {
              "left-rail__item--active": activeLayer === item.id,
            })}
            onClick={() => onLayerSelect(item.id)}
            aria-label={LAYER_LABELS[item.id]}
          >
            <SystemIcon name={item.icon} />
            <span>{LAYER_LABELS[item.id]}</span>
          </button>
        ))}
      </div>
    </GlassPanel>
  );
}
