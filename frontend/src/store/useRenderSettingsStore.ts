import { create } from "zustand";

import { DEFAULT_DIAGNOSTICS_VIEW, DEFAULT_GLOBE_QUALITY } from "@/lib/runtime/renderSettings";
import type { DiagnosticsView, GlobeQualityPreset } from "@/lib/types";

interface RenderSettingsState {
  diagnosticsEnabled: boolean;
  diagnosticsView: DiagnosticsView;
  qualityPreset: GlobeQualityPreset;
  setDiagnosticsEnabled: (diagnosticsEnabled: boolean) => void;
  setDiagnosticsView: (diagnosticsView: DiagnosticsView) => void;
  setQualityPreset: (qualityPreset: GlobeQualityPreset) => void;
}

export const useRenderSettingsStore = create<RenderSettingsState>((set) => ({
  diagnosticsEnabled: false,
  diagnosticsView: DEFAULT_DIAGNOSTICS_VIEW,
  qualityPreset: DEFAULT_GLOBE_QUALITY,

  setDiagnosticsEnabled: (diagnosticsEnabled) =>
    set(() => ({
      diagnosticsEnabled,
    })),

  setDiagnosticsView: (diagnosticsView) =>
    set(() => ({
      diagnosticsView,
    })),

  setQualityPreset: (qualityPreset) =>
    set(() => ({
      qualityPreset,
    })),
}));
