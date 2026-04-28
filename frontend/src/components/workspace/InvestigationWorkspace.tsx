"use client";

import { GlobeCanvas } from "@/components/globe/GlobeCanvas";
import { GlassPanel } from "@/components/ui/GlassPanel";
import { useIntelligenceFeeds } from "@/lib/intelligence/useIntelligenceFeeds";
import { getBetaConfig } from "@/lib/runtime/betaConfig";
import { DEFAULT_GLOBE_QUALITY, getRuntimeRenderSettings } from "@/lib/runtime/renderSettings";
import { useFeedPolling } from "@/lib/data/polling/useFeedPolling";
import { REDUCE_MOTION_STORAGE_KEY } from "@/store/useAccessibilityStore";
import { useAppStore } from "@/store/useAppStore";
import { useOverlayStore } from "@/store/useOverlayStore";
import { useEffect, useMemo } from "react";

import { useWorkspaceModeStore } from "@/store/useWorkspaceModeStore";

import { ComparePanel } from "./ComparePanel";
import { CountryPanel } from "./CountryPanel";
import { EventPanel } from "./EventPanel";
import { GlobeSelectionBridge } from "./GlobeSelectionBridge";
import { HoverTooltip } from "./HoverTooltip";
import { MarketDock } from "./MarketDock";
import { PortfolioPanel } from "./PortfolioPanel";
import { QueryPanel } from "./QueryPanel";
import { SignalStrip } from "./SignalStrip";
import { StocksStrip } from "./StocksStrip";
import { TopCommandBar } from "./TopCommandBar";

export function InvestigationWorkspace() {
  // Preserve the existing boot + render settings wiring so the globe keeps
  // behaving exactly as before. Nothing below this hook is a new globe concern.
  const appState = useAppStore();
  const { ready: feedsReady, error: feedError } = useFeedPolling();
  useIntelligenceFeeds();

  const isOverlayOpen = useOverlayStore((s) => s.isOpen);
  const mode = useOverlayStore((s) => s.mode);
  const workspaceMode = useWorkspaceModeStore((s) => s.mode);
  const betaConfig = useMemo(() => getBetaConfig(), []);

  useEffect(() => {
    const runtime = getRuntimeRenderSettings();
    const reduceMotion =
      typeof window !== "undefined" &&
      window.localStorage.getItem(REDUCE_MOTION_STORAGE_KEY) === "true";
    useAppStore.getState().setRuntimeSettings({
      diagnosticsEnabled: runtime.diagnosticsEnabled,
      diagnosticsView: runtime.diagnosticsView,
      geoAuditEnabled: runtime.geoAuditEnabled,
      geoAudit: runtime.geoAudit,
      qualityPreset: runtime.qualityPreset ?? DEFAULT_GLOBE_QUALITY,
      reduceMotion,
    });
  }, []);

  useEffect(() => {
    useAppStore.getState().setFeedsStatus(feedsReady, feedError);
  }, [feedError, feedsReady]);

  const showBootGate = !appState.engineReady;

  return (
    <>
      <div
        className={`ws-shell${isOverlayOpen ? " ws-shell--overlay-open" : ""}`}
        data-overlay-mode={mode}
        data-workspace-mode={workspaceMode}
        data-testid="investigation-workspace"
      >
        <div className="ws-globe" aria-hidden={isOverlayOpen}>
          <GlobeCanvas />
          <div className="ws-globe__stage" aria-hidden />
          <div className="ws-globe__dim" aria-hidden />
        </div>

        <div className="ws-chrome">
          <TopCommandBar />

          {betaConfig.demoBannerCopy ? (
            <div
              className="ws-demo-banner"
              data-testid="beta-demo-banner"
              role="status"
            >
              <span>{betaConfig.demoBannerCopy}</span>
              <span className="ws-demo-banner__pill">Beta</span>
            </div>
          ) : null}

          <div className="ws-rail">
            <SignalStrip />
          </div>

          <div className="ws-footer">
            <StocksStrip />
          </div>
        </div>

        {mode === "country" ? <CountryPanel /> : null}
        {mode === "event" ? <EventPanel /> : null}
        {mode === "query" ? <QueryPanel /> : null}
        {mode === "compare" ? <ComparePanel /> : null}
        {mode === "portfolio" ? <PortfolioPanel /> : null}

        <MarketDock />

        <HoverTooltip />
        <GlobeSelectionBridge />
      </div>

      {showBootGate ? (
        <div className="boot-gate" data-testid="boot-gate">
          <GlassPanel className="boot-gate__panel">
            <div className="boot-gate__eyebrow">Sphere · System readiness</div>
            <h1 className="boot-gate__title">Preparing investigation workspace</h1>
            <p className="boot-gate__body">
              Loading spatial context and live intelligence feeds. The analyst overlay opens as soon
              as the globe is ready.
            </p>
            <div className="boot-gate__status">
              <span>{appState.engineError ? "Spatial context degraded" : "Spatial context loading"}</span>
              <span>{appState.feedError ? "Feed degraded" : feedsReady ? "Feeds live" : "Feeds hydrating"}</span>
            </div>
            {appState.engineError ? <p className="boot-gate__error">{appState.engineError}</p> : null}
            {!appState.engineError && appState.feedError ? (
              <p className="boot-gate__error">{appState.feedError}</p>
            ) : null}
          </GlassPanel>
        </div>
      ) : null}
    </>
  );
}
