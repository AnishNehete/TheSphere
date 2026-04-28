"use client";

import { useMemo } from "react";

import { GlassPanel } from "@/components/ui/GlassPanel";
import { SystemIcon } from "@/components/ui/SystemIcon";
import { centroidForIso3 } from "@/lib/three/geo";
import { useDataStore } from "@/store/useDataStore";
import { useGlobeStore } from "@/store/useGlobeStore";
import { useLayerStore } from "@/store/useLayerStore";
import { useUIStore } from "@/store/useUIStore";

import { buildAnalystSummary, buildSignalRows, filterRowsByFocus, formatRelativeTime, LAYER_LABELS } from "./signalRows";

export function RightInsightPanel() {
  const activeLayer = useLayerStore((state) => state.activeLayer);
  const setActiveLayer = useLayerStore((state) => state.setActiveLayer);
  const flights = useDataStore((state) => state.flights);
  const weather = useDataStore((state) => state.weather);
  const conflicts = useDataStore((state) => state.conflicts);
  const health = useDataStore((state) => state.health);
  const countryMetrics = useDataStore((state) => state.countryMetrics);
  const regions = useDataStore((state) => state.regions);
  const lastUpdated = useDataStore((state) => state.lastUpdated);

  const selectedCountry = useGlobeStore((state) => state.selectedCountry);
  const selectedRegionSlug = useGlobeStore((state) => state.selectedRegionSlug);
  const selectedSignalId = useGlobeStore((state) => state.selectedSignalId);
  const focusSignal = useGlobeStore((state) => state.focusSignal);
  const clearFocus = useGlobeStore((state) => state.clearFocus);

  const queryBrief = useUIStore((state) => state.queryBrief);

  const region = useMemo(
    () => regions.find((entry) => entry.slug === selectedRegionSlug) ?? null,
    [regions, selectedRegionSlug]
  );
  const title = useMemo(() => {
    if (selectedCountry) {
      return centroidForIso3(selectedCountry)?.name ?? selectedCountry;
    }

    if (region) {
      return region.name;
    }

    return queryBrief?.title ?? "Global Watch";
  }, [queryBrief?.title, region, selectedCountry]);

  const rows = useMemo(
    () =>
      buildSignalRows(
        {
          flights,
          weather,
          conflicts,
          health,
        },
        activeLayer,
        18
      ),
    [activeLayer, conflicts, flights, health, weather]
  );

  const scopedRows = useMemo(
    () => filterRowsByFocus(rows, selectedCountry, region),
    [region, rows, selectedCountry]
  );
  const leadSignal = useMemo(
    () => scopedRows.find((row) => row.id === selectedSignalId) ?? scopedRows[0] ?? null,
    [scopedRows, selectedSignalId]
  );
  const countryMetric = useMemo(
    () => (selectedCountry ? countryMetrics.find((entry) => entry.iso3 === selectedCountry) ?? null : null),
    [countryMetrics, selectedCountry]
  );
  const generatedBrief = useMemo(
    () =>
      buildAnalystSummary({
        label: title,
        rows: scopedRows,
        countryMetric,
        fallbackLayer: activeLayer,
      }),
    [activeLayer, countryMetric, scopedRows, title]
  );
  const activeQueryBrief = useMemo(() => {
    if (!queryBrief) {
      return null;
    }

    if (queryBrief.type === "signal") {
      return selectedSignalId ? queryBrief : null;
    }

    if (queryBrief.type === "country" || queryBrief.type === "region") {
      return queryBrief.title === title ? queryBrief : null;
    }

    if (queryBrief.type === "layer" || queryBrief.type === "none") {
      return !selectedCountry && !selectedRegionSlug && !selectedSignalId ? queryBrief : null;
    }

    return null;
  }, [queryBrief, selectedCountry, selectedRegionSlug, selectedSignalId, title]);
  const panelSummary = activeQueryBrief?.summary ?? generatedBrief.summary;

  const onSignalSelect = (signalId: string, iso3Hint?: string) => {
    const signal = scopedRows.find((entry) => entry.id === signalId);
    if (signal) {
      setActiveLayer(signal.layer);
    }
    focusSignal(signalId, iso3Hint ?? null);
  };

  const scopeEyebrow = selectedCountry || region || selectedSignalId ? "Focused Theater" : activeQueryBrief ? "Analyst Brief" : "Global Theater";

  return (
    <GlassPanel as="aside" className="right-panel" aria-label="Intelligence Panel">
      <div className="right-panel__header">
        <div>
          <div className="right-panel__eyebrow">{scopeEyebrow}</div>
          <h2 className="right-panel__title">{title}</h2>
        </div>
        {(selectedCountry || selectedRegionSlug || selectedSignalId) && (
          <button type="button" className="right-panel__clear" onClick={clearFocus}>
            <SystemIcon name="close" />
            <span>Clear</span>
          </button>
        )}
      </div>

      <p className="right-panel__summary">{panelSummary}</p>

      <dl className="right-panel__metrics">
        <div>
          <dt>Score</dt>
          <dd>{generatedBrief.score === null ? "--" : generatedBrief.score.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Signals</dt>
          <dd>{generatedBrief.signalCount}</dd>
        </div>
        <div>
          <dt>Layer</dt>
          <dd>{LAYER_LABELS[activeQueryBrief?.layer ?? generatedBrief.dominantLayer]}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatRelativeTime(lastUpdated)}</dd>
        </div>
      </dl>

      {activeQueryBrief ? (
        <section className="right-panel__brief">
          <div className="right-panel__brief-head">
            <span>{activeQueryBrief.actionLabel}</span>
            <SystemIcon name="spark" />
          </div>
          <strong>{activeQueryBrief.title}</strong>
          <p>{activeQueryBrief.detail}</p>
        </section>
      ) : null}

      <section className="right-panel__section">
        <div className="right-panel__section-head">
          <span>Priority Signals</span>
          <strong>{leadSignal ? leadSignal.title : "Standby"}</strong>
        </div>
        <ul className="right-panel__list">
          {scopedRows.slice(0, 5).map((row) => (
            <li key={row.id}>
              <button type="button" className="right-panel__item" onClick={() => onSignalSelect(row.id, row.iso3Hint)}>
                <span className="right-panel__item-title">{row.title}</span>
                <span className="right-panel__item-meta">
                  {LAYER_LABELS[row.layer]} / {row.detail}
                </span>
              </button>
            </li>
          ))}
          {scopedRows.length === 0 ? (
            <li className="right-panel__empty">No elevated signals inside the current focus.</li>
          ) : null}
        </ul>
      </section>
    </GlassPanel>
  );
}
