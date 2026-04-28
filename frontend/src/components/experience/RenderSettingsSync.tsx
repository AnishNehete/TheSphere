"use client";

import { useEffect } from "react";

import { getRuntimeRenderSettings } from "@/lib/runtime/renderSettings";
import { useRenderSettingsStore } from "@/store/useRenderSettingsStore";

export function RenderSettingsSync() {
  const setDiagnosticsEnabled = useRenderSettingsStore((state) => state.setDiagnosticsEnabled);
  const setDiagnosticsView = useRenderSettingsStore((state) => state.setDiagnosticsView);
  const setQualityPreset = useRenderSettingsStore((state) => state.setQualityPreset);

  useEffect(() => {
    const syncFromLocation = () => {
      const settings = getRuntimeRenderSettings();
      setDiagnosticsEnabled(settings.diagnosticsEnabled);
      setDiagnosticsView(settings.diagnosticsView);
      setQualityPreset(settings.qualityPreset);
    };

    syncFromLocation();
    window.addEventListener("popstate", syncFromLocation);
    return () => {
      window.removeEventListener("popstate", syncFromLocation);
    };
  }, [setDiagnosticsEnabled, setDiagnosticsView, setQualityPreset]);

  return null;
}
