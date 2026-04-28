"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";

import { GlobeCanvas } from "@/components/globe/GlobeCanvas";
import { LAYER_LABELS, formatRelativeTime, formatUtcTimestamp } from "@/components/hud/signalRows";
import { GlassPanel } from "@/components/ui/GlassPanel";
import { buildHomepageInvestigation } from "@/lib/investigation/buildHomepageInvestigation";
import { DEFAULT_GLOBE_QUALITY, getRuntimeRenderSettings, QUALITY_STORAGE_KEY } from "@/lib/runtime/renderSettings";
import { resolveSearchIntent } from "@/lib/search/resolveSearchIntent";
import { useFeedPolling } from "@/lib/data/polling/useFeedPolling";
import { REDUCE_MOTION_STORAGE_KEY } from "@/store/useAccessibilityStore";
import { useAppStore } from "@/store/useAppStore";
import { useDataStore } from "@/store/useDataStore";

const QUALITY_ORDER = ["low", "medium", "high"] as const;

export function InvestigationWorkspace() {
  const appState = useAppStore();
  const dataState = useDataStore();
  const { ready: feedsReady, error: feedError } = useFeedPolling();

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Resolve a country, region, route, or live signal.");
  const [isResolving, setIsResolving] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const runtime = getRuntimeRenderSettings();
    const reduceMotion = window.localStorage.getItem(REDUCE_MOTION_STORAGE_KEY) === "true";
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

  useEffect(() => {
    const onScroll = () => {
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const progress = maxScroll > 0 ? Math.min(1, Math.max(0, window.scrollY / maxScroll)) : 0;
      useAppStore.getState().setScrollProgress(progress);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const investigation = useMemo(() => buildHomepageInvestigation(appState, dataState), [appState, dataState]);
  const showBootGate = !appState.engineReady;
  const hasScopedFocus = Boolean(appState.selectedCountry || appState.selectedRegionSlug || appState.selectedSignalId);

  const focusEvidence = (signalId: string, layer: keyof typeof LAYER_LABELS, iso3Hint?: string) => {
    const store = useAppStore.getState();
    store.setActiveLayer(layer);
    store.focusSignal(signalId, iso3Hint ?? null);
    store.clearQueryBrief();
    setStatus(`Focused evidence: ${signalId}.`);
  };

  const setLayer = (layer: keyof typeof LAYER_LABELS) => {
    const store = useAppStore.getState();
    store.clearFocus();
    store.clearQueryBrief();
    store.setActiveLayer(layer);
    setStatus(`Switched to ${LAYER_LABELS[layer]}.`);
  };

  const cycleQuality = () => {
    const currentIndex = QUALITY_ORDER.indexOf(appState.qualityPreset);
    const next = QUALITY_ORDER[(currentIndex + 1) % QUALITY_ORDER.length];
    useAppStore.getState().setRuntimeSettings({
      diagnosticsEnabled: appState.diagnosticsEnabled,
      diagnosticsView: appState.diagnosticsView,
      geoAuditEnabled: appState.geoAuditEnabled,
      geoAudit: appState.geoAudit,
      qualityPreset: next,
      reduceMotion: appState.reduceMotion,
    });
    window.localStorage.setItem(QUALITY_STORAGE_KEY, next);
  };

  const toggleReduceMotion = () => {
    const next = !appState.reduceMotion;
    useAppStore.getState().setRuntimeSettings({
      diagnosticsEnabled: appState.diagnosticsEnabled,
      diagnosticsView: appState.diagnosticsView,
      geoAuditEnabled: appState.geoAuditEnabled,
      geoAudit: appState.geoAudit,
      qualityPreset: appState.qualityPreset,
      reduceMotion: next,
    });
    window.localStorage.setItem(REDUCE_MOTION_STORAGE_KEY, String(next));
  };

  const copySummary = async () => {
    if (!navigator.clipboard) {
      return;
    }

    await navigator.clipboard.writeText(investigation.exportSummary);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }

    setIsResolving(true);
    const resolution = await resolveSearchIntent({
      query: trimmed,
      flights: dataState.flights,
      weather: dataState.weather,
      conflicts: dataState.conflicts,
      health: dataState.health,
      regions: dataState.regions,
    });

    const store = useAppStore.getState();
    if (resolution.layer) {
      store.setActiveLayer(resolution.layer);
    }

    if (resolution.type === "country" && resolution.countryIso3) {
      store.focusCountry(resolution.countryIso3);
      store.clearQueryBrief();
      setStatus(`Resolved ${resolution.label}.`);
      setIsResolving(false);
      return;
    }

    if (resolution.type === "signal" && resolution.signalId) {
      store.focusSignal(resolution.signalId, resolution.countryIso3 ?? null);
      store.clearQueryBrief();
      setStatus(`Pinned ${resolution.label}.`);
      setIsResolving(false);
      return;
    }

    if (resolution.type === "region" && resolution.regionSlug) {
      store.focusRegion(resolution.regionSlug);
      store.clearQueryBrief();
      setStatus(`Resolved ${resolution.label}.`);
      setIsResolving(false);
      return;
    }

    if (resolution.type === "layer" && resolution.layer) {
      store.clearFocus();
      store.clearQueryBrief();
      store.setActiveLayer(resolution.layer);
      setStatus(`Switched to ${resolution.label}.`);
      setIsResolving(false);
      return;
    }

    setStatus(resolution.message ?? "No exact match. Try a country, region, layer, or live signal.");
    setIsResolving(false);
  };

  return (
    <>
      <div className="workspace-shell" data-testid="investigation-workspace">
        <section className="workspace-hero" data-testid="hero-section">
          <div className="workspace-hero__sticky">
            <div className="workspace-hero__globe" data-testid="hero-globe">
              <GlobeCanvas />
            </div>
            {/* Most of the hero surface stays open so the globe remains the visual anchor
                and country hover/focus can keep working above the fold. */}
            <div className="workspace-hero__overlay">
              <div className="workspace-hero__chrome">
                <div className="workspace-hero__brand">
                  <span>Sphere</span>
                  <strong>Global watch</strong>
                </div>
              </div>

              {/* Keep the hero command surface detached from the chrome so the globe stays visually
                  dominant and pointer access remains open across most of the fold. */}
              <div className="workspace-hero__search-dock" data-testid="hero-search-dock">
                <div className="workspace-search__context">
                  <span className="workspace-search__context-chip">{investigation.resolvedEntity}</span>
                </div>

                <form className="workspace-search" data-testid="intelligence-search" onSubmit={onSubmit}>
                  <div className="workspace-search__field">
                    <input
                      id="workspace-search-input"
                      aria-label="AI Search"
                      type="text"
                      value={query}
                      onChange={(event) => {
                        const next = event.target.value;
                        setQuery(next);
                        if (!next.trim()) {
                          setStatus("Resolve a country, region, route, or live signal.");
                        }
                      }}
                      placeholder="Search country, region, route, or signal"
                    />
                    <button type="submit" aria-label="Run Investigation" disabled={!query.trim() || isResolving}>
                      {isResolving ? "Working" : "Resolve"}
                    </button>
                  </div>
                </form>

                <div className="workspace-search__status-row">
                  <p className="workspace-search__status">{status}</p>
                  {hasScopedFocus ? (
                    <button
                      type="button"
                      className="workspace-search__clear"
                      onClick={() => {
                        const store = useAppStore.getState();
                        store.clearFocus();
                        store.clearQueryBrief();
                        setStatus("Global watch restored.");
                      }}
                    >
                      Clear focus
                    </button>
                  ) : (
                    <span className="workspace-search__hint">
                      {Math.round(investigation.confidence * 100)}% confidence
                    </span>
                  )}
                </div>

                <div className="workspace-hero__layer-row" data-testid="layer-switcher">
                  {(Object.keys(LAYER_LABELS) as Array<keyof typeof LAYER_LABELS>).map((layer) => (
                    <button
                      key={layer}
                      type="button"
                      className={appState.activeLayer === layer ? "is-active" : ""}
                      onClick={() => setLayer(layer)}
                    >
                      {LAYER_LABELS[layer]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <main className="workspace-main">
          <div className="workspace-sections">
            <GlassPanel as="section" className="workspace-section workspace-section--summary" data-testid="summary-section">
              <div className="workspace-section__head">
                <div>
                  <p className="workspace-eyebrow">{investigation.scopeLabel}</p>
                  <h2>Executive summary</h2>
                </div>
                <div className="workspace-score-chip" data-attention={investigation.statusLabel}>
                  <span>Score</span>
                  <strong>{investigation.score.value}</strong>
                </div>
              </div>
              <div className="workspace-summary-overview">
                <div className="workspace-summary-overview__body">
                  <p className="workspace-eyebrow">Current investigation</p>
                  <h3>{investigation.title}</h3>
                  <p className="workspace-section__body">{investigation.summary.body}</p>
                </div>
                <div className="workspace-summary-metrics">
                  <article>
                    <span>Resolved context</span>
                    <strong>{investigation.resolvedEntity}</strong>
                  </article>
                  <article>
                    <span>Layer</span>
                    <strong>{investigation.activeLayerLabel}</strong>
                  </article>
                  <article>
                    <span>Last updated</span>
                    <strong>{formatUtcTimestamp(investigation.updatedAt)}</strong>
                  </article>
                  <article>
                    <span>Confidence</span>
                    <strong>{Math.round(investigation.confidence * 100)}%</strong>
                  </article>
                </div>
              </div>
              <div className="workspace-summary-grid">
                <article>
                  <p className="workspace-eyebrow">{investigation.whyItMatters.title}</p>
                  <p>{investigation.whyItMatters.body}</p>
                </article>
                <article>
                  <p className="workspace-eyebrow">What changed</p>
                  <p>Delta {investigation.score.delta >= 0 ? "+" : ""}{investigation.score.delta.toFixed(2)} versus recent baseline.</p>
                </article>
              </div>
            </GlassPanel>

            <GlassPanel as="section" className="workspace-section" data-testid="evidence-section">
              <div className="workspace-section__head">
                <div>
                  <p className="workspace-eyebrow">Evidence</p>
                  <h2>Strongest evidence first</h2>
                </div>
                <strong>{investigation.score.evidenceCount} scoped items</strong>
              </div>
              <div className="workspace-evidence-list" data-testid="evidence-list">
                {investigation.evidence.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="workspace-evidence-card"
                    data-pinned={item.isPinned ? "true" : "false"}
                    onClick={() => focusEvidence(item.id, item.layer, item.iso3Hint)}
                  >
                    <div className="workspace-evidence-card__meta">
                      <span>{item.sourceLabel}</span>
                      <span>{formatRelativeTime(item.timestamp)}</span>
                    </div>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                    <div className="workspace-evidence-card__footer">
                      <span>{item.rationale}</span>
                      <span>{Math.round(item.confidence * 100)}% confidence</span>
                    </div>
                  </button>
                ))}
                {investigation.evidence.length === 0 ? (
                  <div className="workspace-empty">No elevated evidence is currently scoped to this investigation.</div>
                ) : null}
              </div>
            </GlassPanel>

            <GlassPanel as="section" className="workspace-section" data-testid="dependency-section">
              <div className="workspace-section__head">
                <div>
                  <p className="workspace-eyebrow">Dependency path</p>
                  <h2>Why the edges exist</h2>
                </div>
              </div>
              <div className="workspace-path-list">
                {investigation.dependencyPath.map((edge) => (
                  <article key={edge.id} className="workspace-path-edge">
                    <div className="workspace-path-edge__nodes">
                      <strong>{edge.from}</strong>
                      <span />
                      <strong>{edge.to}</strong>
                    </div>
                    <p>{edge.rationale}</p>
                    <div className="workspace-path-edge__meta">
                      <span>{Math.round(edge.confidence * 100)}% confidence</span>
                      <span>{edge.evidenceIds.length} evidence link{edge.evidenceIds.length === 1 ? "" : "s"}</span>
                    </div>
                  </article>
                ))}
                {investigation.dependencyPath.length === 0 ? (
                  <div className="workspace-empty">Dependency path remains empty until elevated evidence exists inside the current scope.</div>
                ) : null}
              </div>
            </GlassPanel>

            <GlassPanel as="section" className="workspace-section" data-testid="scoring-section">
              <div className="workspace-section__head">
                <div>
                  <p className="workspace-eyebrow">Score and drivers</p>
                  <h2>Explainable scoring</h2>
                </div>
              </div>
              <div className="workspace-score-grid">
                <article>
                  <span>Attention score</span>
                  <strong>{investigation.score.value}</strong>
                </article>
                <article>
                  <span>Delta</span>
                  <strong>{investigation.score.delta >= 0 ? "+" : ""}{investigation.score.delta.toFixed(2)}</strong>
                </article>
                <article>
                  <span>Confidence</span>
                  <strong>{Math.round(investigation.score.confidence * 100)}%</strong>
                </article>
                <article>
                  <span>Evidence count</span>
                  <strong>{investigation.score.evidenceCount}</strong>
                </article>
              </div>
              <div className="workspace-driver-list">
                {investigation.score.drivers.map((driver) => (
                  <article key={driver.id} className="workspace-driver">
                    <div>
                      <strong>{driver.title}</strong>
                      <p>{driver.explanation}</p>
                    </div>
                    <span>{driver.weight.toFixed(2)}</span>
                  </article>
                ))}
              </div>
            </GlassPanel>

            <GlassPanel as="section" className="workspace-section" data-testid="actions-section">
              <div className="workspace-section__head">
                <div>
                  <p className="workspace-eyebrow">Suggested actions</p>
                  <h2>Decision and workflow</h2>
                </div>
                <strong>{copied ? "Copied" : "Ready"}</strong>
              </div>
              <div className="workspace-actions">
                {investigation.actions.map((action) => (
                  <article key={action.id} className="workspace-action">
                    <strong>{action.label}</strong>
                    <p>{action.detail}</p>
                    {action.id === "copy-summary" ? (
                      <button type="button" onClick={() => void copySummary()}>
                        {copied ? "Copied" : "Copy summary"}
                      </button>
                    ) : (
                      <button type="button">{action.label}</button>
                    )}
                  </article>
                ))}
              </div>
              <div className="workspace-export-note">
                <p className="workspace-eyebrow">Export payload</p>
                <p>{investigation.exportSummary}</p>
              </div>
            </GlassPanel>
            <GlassPanel as="section" className="workspace-section workspace-section--support">
              <div className="workspace-section__head">
                <div>
                  <p className="workspace-eyebrow">Spatial support</p>
                  <h2>Live globe support controls</h2>
                </div>
                <strong>{appState.feedError ? "Feed degraded" : appState.feedsReady ? "Feeds live" : "Feeds hydrating"}</strong>
              </div>
              <div className="workspace-support-grid">
                <article>
                  <span>Layer</span>
                  <strong>{investigation.activeLayerLabel}</strong>
                </article>
                <article>
                  <span>Updated</span>
                  <strong>{formatRelativeTime(investigation.updatedAt)}</strong>
                </article>
                <article>
                  <span>Current path</span>
                  <strong>{investigation.dependencyPath[0]?.to ?? "Awaiting scoped evidence"}</strong>
                </article>
              </div>
              <div className="workspace-support-actions">
                <button type="button" onClick={cycleQuality}>
                  Quality {appState.qualityPreset}
                </button>
                <button type="button" onClick={toggleReduceMotion}>
                  Motion {appState.reduceMotion ? "Reduced" : "Standard"}
                </button>
              </div>
              {investigation.relatedEntities.length > 0 ? (
                <div className="workspace-chip-row">
                  {investigation.relatedEntities.map((entity) => (
                    <span key={entity}>{entity}</span>
                  ))}
                </div>
              ) : null}
            </GlassPanel>
          </div>
        </main>
      </div>

      {appState.hoverTooltip ? (
        <div
          className="workspace-tooltip"
          style={{ left: appState.hoverTooltip.x, top: appState.hoverTooltip.y }}
        >
          <div className="workspace-eyebrow">{appState.hoverTooltip.eyebrow}</div>
          <strong>{appState.hoverTooltip.title}</strong>
          <p>{appState.hoverTooltip.summary}</p>
        </div>
      ) : null}

      {showBootGate ? (
        <div className="boot-gate" data-testid="boot-gate">
          <GlassPanel className="boot-gate__panel">
            <div className="boot-gate__eyebrow">Sphere / System readiness</div>
            <h1 className="boot-gate__title">Preparing investigation workspace</h1>
            <p className="boot-gate__body">Loading the spatial context and live signal feeds without blocking the investigation-first layout.</p>
            <div className="boot-gate__status">
              <span>{appState.engineError ? "Spatial context degraded" : "Spatial context loading"}</span>
              <span>{appState.feedError ? "Feed degraded" : feedsReady ? "Feeds live" : "Feeds hydrating"}</span>
            </div>
            {appState.engineError ? <p className="boot-gate__error">{appState.engineError}</p> : null}
            {!appState.engineError && appState.feedError ? <p className="boot-gate__error">{appState.feedError}</p> : null}
          </GlassPanel>
        </div>
      ) : null}
    </>
  );
}
