import { create } from "zustand";

import type { GlobeLayerId, HudRailMode, SearchResolutionType } from "@/lib/types";

export interface HoverTooltipPayload {
  x: number;
  y: number;
  iso3: string;
  eyebrow: string;
  title: string;
  score: number | null;
  signalCount: number;
  summary: string;
  activeLayer: GlobeLayerId | null;
}

export interface QueryBrief {
  query: string;
  title: string;
  detail: string;
  summary: string;
  actionLabel: string;
  type: SearchResolutionType;
  layer: GlobeLayerId | null;
}

interface UIState {
  railMode: HudRailMode;
  showHud: boolean;
  showIntroOverlay: boolean;
  hoverTooltip: HoverTooltipPayload | null;
  queryBrief: QueryBrief | null;
  setRailMode: (mode: HudRailMode) => void;
  setShowHud: (show: boolean) => void;
  setShowIntroOverlay: (show: boolean) => void;
  setHoverTooltip: (payload: HoverTooltipPayload | null) => void;
  setQueryBrief: (queryBrief: QueryBrief | null) => void;
  clearQueryBrief: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  railMode: "global",
  showHud: false,
  showIntroOverlay: false,
  hoverTooltip: null,
  queryBrief: null,

  setRailMode: (railMode) =>
    set(() => ({
      railMode,
    })),

  setShowHud: (showHud) =>
    set(() => ({
      showHud,
    })),

  setShowIntroOverlay: (showIntroOverlay) =>
    set(() => ({
      showIntroOverlay,
    })),

  setHoverTooltip: (hoverTooltip) =>
    set(() => ({
      hoverTooltip,
    })),

  setQueryBrief: (queryBrief) =>
    set(() => ({
      queryBrief,
    })),

  clearQueryBrief: () =>
    set(() => ({
      queryBrief: null,
    })),
}));

