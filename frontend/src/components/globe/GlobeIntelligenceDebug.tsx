// GlobeIntelligenceDebug
// ----------------------
// Lightweight diagnostics overlay showing the globe intelligence state.
// Only renders when diagnosticsEnabled is true — production-safe.

"use client";

import { useGlobeIntelligence } from "@/components/globe/useGlobeIntelligence";
import { subsolarLatLon } from "@/lib/three/sunDirection";
import { useAppStore } from "@/store/useAppStore";

// Phase 19C.3 — diagnostics overlay also surfaces visual layer toggles
// (clouds/atmosphere/stars/sun/markers/night) and the live subsolar
// point so a reviewer can confirm at a glance which environment systems
// actually rendered. Hidden in production unless ?diagnostics=1.
export function GlobeIntelligenceDebug() {
  const diagnosticsEnabled = useAppStore((state) => state.diagnosticsEnabled);
  const cameraMode = useAppStore((state) => state.cameraMode);
  const selectedCountry = useAppStore((state) => state.selectedCountry);
  const selectedSignalId = useAppStore((state) => state.selectedSignalId);
  const selectedRegionSlug = useAppStore((state) => state.selectedRegionSlug);
  const showClouds = useAppStore((state) => state.showClouds);
  const showBorders = useAppStore((state) => state.showBorders);
  const showLabels = useAppStore((state) => state.showLabels);
  const showHeatmap = useAppStore((state) => state.showHeatmap);
  const geoAudit = useAppStore((state) => state.geoAudit);
  const geoAuditEnabled = useAppStore((state) => state.geoAuditEnabled);

  const intelligence = useGlobeIntelligence();

  if (!diagnosticsEnabled) {
    return null;
  }

  const focusEntity = selectedSignalId ?? selectedCountry ?? selectedRegionSlug ?? "none";
  const sun = subsolarLatLon();
  const auditFlag = (label: string, enabled: boolean) =>
    `${label}:${enabled ? "on" : "off"}`;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 12,
        left: 12,
        zIndex: 9999,
        background: "rgba(7, 11, 17, 0.82)",
        border: "1px solid rgba(158, 187, 204, 0.18)",
        borderRadius: 8,
        padding: "10px 14px",
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: 11,
        lineHeight: 1.6,
        color: "rgba(200, 218, 230, 0.85)",
        pointerEvents: "none",
        maxWidth: 280,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4, color: "rgba(155, 196, 255, 0.9)" }}>
        Globe Intelligence
      </div>
      <div>cameraMode: {cameraMode}</div>
      <div>storyType: {intelligence.storyType}</div>
      <div>activeLayer: {intelligence.activeLayer}</div>
      <div>focusEntity: {focusEntity}</div>
      <div>focusIntensity: {intelligence.focusIntensity.toFixed(2)}</div>
      <div>labelCap: {intelligence.labelCap}</div>
      <div>borderOpacity: {intelligence.borderOpacityScale.toFixed(2)}</div>
      <div>cloudsDimmed: {intelligence.cloudsDimmed ? "yes" : "no"}</div>
      <div style={{ marginTop: 6, color: "rgba(155, 196, 255, 0.85)" }}>layers</div>
      <div>
        {auditFlag("clouds", showClouds)} · {auditFlag("borders", showBorders)} ·{" "}
        {auditFlag("labels", showLabels)} · {auditFlag("heatmap", showHeatmap)}
      </div>
      {geoAuditEnabled ? (
        <div>
          {auditFlag("audit.atm", geoAudit.atmosphere)} · {auditFlag("audit.stars", geoAudit.stars)} ·{" "}
          {auditFlag("audit.sun", geoAudit.sun)} · {auditFlag("audit.night", geoAudit.night)} ·{" "}
          {auditFlag("audit.mk", geoAudit.markers)}
        </div>
      ) : null}
      <div style={{ marginTop: 6, color: "rgba(155, 196, 255, 0.85)" }}>sun</div>
      <div>
        subsolar: {sun.lat.toFixed(2)}°, {sun.lon.toFixed(2)}°
      </div>
    </div>
  );
}
