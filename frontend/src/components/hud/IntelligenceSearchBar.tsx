"use client";

import { FormEvent, useMemo, useState } from "react";

import { buildAnalystSummary, buildSignalRows, filterRowsByFocus, LAYER_LABELS } from "@/components/hud/signalRows";
import { SystemIcon } from "@/components/ui/SystemIcon";
import { resolveSearchIntent } from "@/lib/search/resolveSearchIntent";
import { useDataStore } from "@/store/useDataStore";
import { useGlobeStore } from "@/store/useGlobeStore";
import { useLayerStore } from "@/store/useLayerStore";
import { useUIStore } from "@/store/useUIStore";

export function IntelligenceSearchBar() {
  const flights = useDataStore((state) => state.flights);
  const weather = useDataStore((state) => state.weather);
  const conflicts = useDataStore((state) => state.conflicts);
  const health = useDataStore((state) => state.health);
  const regions = useDataStore((state) => state.regions);
  const countryMetrics = useDataStore((state) => state.countryMetrics);

  const setActiveLayer = useLayerStore((state) => state.setActiveLayer);

  const focusCountry = useGlobeStore((state) => state.focusCountry);
  const focusSignal = useGlobeStore((state) => state.focusSignal);
  const focusRegion = useGlobeStore((state) => state.focusRegion);
  const clearFocus = useGlobeStore((state) => state.clearFocus);
  const setQueryBrief = useUIStore((state) => state.setQueryBrief);
  const clearQueryBrief = useUIStore((state) => state.clearQueryBrief);

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("Query ready. Search a country, region, outbreak, signal layer, or callsign.");
  const [isResolving, setIsResolving] = useState(false);

  const trimmed = useMemo(() => query.trim(), [query]);
  const allRows = useMemo(
    () =>
      buildSignalRows(
        {
          flights,
          weather,
          conflicts,
          health,
        },
        "global",
        400
      ),
    [conflicts, flights, health, weather]
  );

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmed) {
      return;
    }

    setIsResolving(true);

    const resolution = await resolveSearchIntent({
      query: trimmed,
      flights,
      weather,
      conflicts,
      health,
      regions,
    });

    if (resolution.layer) {
      setActiveLayer(resolution.layer);
    }

    if (resolution.type === "country" && resolution.countryIso3) {
      const countryRows = allRows.filter((row) => row.iso3Hint === resolution.countryIso3);
      const countryMetric = countryMetrics.find((entry) => entry.iso3 === resolution.countryIso3) ?? null;
      const brief = buildAnalystSummary({
        label: resolution.label,
        rows: countryRows,
        countryMetric,
        fallbackLayer: resolution.layer ?? undefined,
      });
      focusCountry(resolution.countryIso3);
      setQueryBrief({
        query: trimmed,
        title: resolution.label,
        detail: `${brief.signalCount} active signals / country focus engaged`,
        summary: brief.summary,
        actionLabel: "LLM Summary",
        type: resolution.type,
        layer: resolution.layer ?? brief.dominantLayer,
      });
      setStatus(`Focused ${resolution.label}.`);
      setIsResolving(false);
      return;
    }

    if (resolution.type === "signal" && resolution.signalId) {
      const signal = allRows.find((row) => row.id === resolution.signalId) ?? null;
      focusSignal(resolution.signalId, resolution.countryIso3 ?? null);
      setQueryBrief({
        query: trimmed,
        title: resolution.label,
        detail: signal ? `${LAYER_LABELS[signal.layer]} / ${signal.detail}` : "Live signal focus engaged",
        summary: signal
          ? `${resolution.label} is now pinned as the lead tracked signal with ${LAYER_LABELS[signal.layer].toLowerCase()} context in focus.`
          : `${resolution.label} is now pinned as the lead tracked signal.`,
        actionLabel: "LLM Summary",
        type: resolution.type,
        layer: resolution.layer ?? signal?.layer ?? null,
      });
      setStatus(`Tracking ${resolution.label}.`);
      setIsResolving(false);
      return;
    }

    if (resolution.type === "region" && resolution.regionSlug) {
      const region = regions.find((entry) => entry.slug === resolution.regionSlug) ?? null;
      const regionRows = region ? filterRowsByFocus(allRows, null, region) : [];
      const brief = buildAnalystSummary({
        label: resolution.label,
        rows: regionRows,
        fallbackLayer: resolution.layer ?? undefined,
      });
      focusRegion(resolution.regionSlug);
      setQueryBrief({
        query: trimmed,
        title: resolution.label,
        detail: `${brief.signalCount} regional signals / area focus engaged`,
        summary: brief.summary,
        actionLabel: "LLM Summary",
        type: resolution.type,
        layer: resolution.layer ?? brief.dominantLayer,
      });
      setStatus(`Focused ${resolution.label}.`);
      setIsResolving(false);
      return;
    }

    if (resolution.type === "layer" && resolution.layer) {
      const layerRows = buildSignalRows(
        {
          flights,
          weather,
          conflicts,
          health,
        },
        resolution.layer,
        120
      );
      const brief = buildAnalystSummary({
        label: LAYER_LABELS[resolution.layer],
        rows: layerRows,
        fallbackLayer: resolution.layer,
      });
      clearFocus();
      setQueryBrief({
        query: trimmed,
        title: `${resolution.label} layer`,
        detail: `${layerRows.length} live signals available`,
        summary: brief.summary,
        actionLabel: "LLM Summary",
        type: resolution.type,
        layer: resolution.layer,
      });
      setStatus(`Switched to ${resolution.label}.`);
      setIsResolving(false);
      return;
    }

    setQueryBrief({
      query: trimmed,
      title: "No exact match",
      detail: "Manual analyst review",
      summary: resolution.message ?? "No exact match was found. Try a country, region, callsign, or signal layer.",
      actionLabel: "LLM Summary",
      type: resolution.type,
      layer: resolution.layer ?? null,
    });
    setStatus(resolution.message ?? "No exact match.");
    setIsResolving(false);
  };

  return (
    <form className="intelligence-search" onSubmit={onSubmit} data-testid="intelligence-search">
      <div className="intelligence-search__field">
        <div className="intelligence-search__leading" aria-hidden>
          <SystemIcon name="spark" />
        </div>
        <input
          type="text"
          value={query}
          onChange={(event) => {
            const nextValue = event.target.value;
            setQuery(nextValue);
            if (!nextValue.trim()) {
              clearQueryBrief();
              setStatus("Query ready. Search a country, region, outbreak, signal layer, or callsign.");
            }
          }}
          placeholder="Search countries, regions, signals, or active layers"
          aria-label="AI Search"
        />
        <div className="intelligence-search__tag">Analyst Search</div>
        <button type="submit" disabled={!trimmed || isResolving}>
          {isResolving ? "Analyzing" : "Run Query"}
        </button>
      </div>
      <p className="intelligence-search__status">{status}</p>
    </form>
  );
}
