import { buildSignalRows, type SignalRow } from "@/components/hud/signalRows";
import { centroidForIso3, regionContainsLatLon } from "@/lib/three/geo";
import type {
  ConflictSignal,
  CountryMetric,
  FlightSignal,
  GlobeLayerId,
  HealthSignal,
  RegionRecord,
  RegionScanResult,
  RegionScanScope,
  ScanEvidenceItem,
  ScanTrendDirection,
  WeatherSignal,
} from "@/lib/types";

import { buildEvidenceWeight, scoreRegion } from "./scoreRegion";
import {
  buildAnalystBrief,
  buildImpactAreas,
  buildQuietBrief,
  buildQuietTrendSummary,
  buildTrendSummary,
} from "./templates";

const MAX_SIGNAL_ROWS = 500;

interface BuildRegionScanOptions {
  activeLayer: GlobeLayerId;
  selectedCountry: string | null;
  selectedRegionSlug: string | null;
  selectedSignalId: string | null;
  flights: FlightSignal[];
  weather: WeatherSignal[];
  conflicts: ConflictSignal[];
  health: HealthSignal[];
  countryMetrics: CountryMetric[];
  regions: RegionRecord[];
  lastUpdated: string | null;
  now?: string | null;
}

export function buildRegionScan(options: BuildRegionScanOptions): RegionScanResult {
  const scope = resolveScope(options.selectedCountry, options.selectedRegionSlug, options.regions);
  const referenceTimestamp = options.now ?? options.lastUpdated ?? new Date().toISOString();
  const allRows = buildSignalRows(
    {
      flights: options.flights,
      weather: options.weather,
      conflicts: options.conflicts,
      health: options.health,
    },
    "global",
    MAX_SIGNAL_ROWS
  );
  const scopedRows = filterRowsByScope(allRows, scope, options.regions);
  const evidence = scopedRows
    .map((row) => toEvidence(row, options.selectedSignalId, referenceTimestamp))
    .sort(sortEvidence);
  const pinnedEvidence = pinEvidence(evidence, options.selectedSignalId);
  const scoring = scoreRegion(pinnedEvidence);
  const dominantLayer = resolveDominantLayer(pinnedEvidence, options.activeLayer);
  const trendDirection = resolveTrendDirection(scope, pinnedEvidence, options.countryMetrics);
  const topSignals = pinnedEvidence.slice(0, 3);
  const likelyImpactAreas = buildImpactAreas(topSignals.length > 0 ? topSignals : pinnedEvidence.slice(0, 4));
  const leadSignal = pinnedEvidence[0] ?? null;
  const hotspotCount = pinnedEvidence.filter((item) => item.layer !== "flights").length;
  const flightCount = pinnedEvidence.filter((item) => item.layer === "flights").length;

  if (pinnedEvidence.length === 0) {
    return {
      scope,
      title: scope.title,
      attentionLevel: "baseline",
      score: 0,
      topSignals: [],
      trendDirection: "stable",
      trendSummary: buildQuietTrendSummary(scope.title),
      likelyImpactAreas: ["routine monitoring"],
      brief: buildQuietBrief(scope.title),
      dominantLayer: options.activeLayer,
      evidence: [],
      signalCount: 0,
      hotspotCount: 0,
      flightCount: 0,
      updatedAt: options.lastUpdated,
    };
  }

  return {
    scope,
    title: scope.title,
    attentionLevel: scoring.attentionLevel,
    score: scoring.score,
    topSignals,
    trendDirection,
    trendSummary: buildTrendSummary({
      scopeTitle: scope.title,
      direction: trendDirection,
      dominantLayer,
      freshSignalCount: pinnedEvidence.filter((item) => item.ageHours < 12).length,
      leadSignal,
    }),
    likelyImpactAreas,
    brief: buildAnalystBrief({
      scopeTitle: scope.title,
      attentionLevel: scoring.attentionLevel,
      dominantLayer,
      leadSignal,
      impactAreas: likelyImpactAreas,
    }),
    dominantLayer,
    evidence: pinnedEvidence,
    signalCount: pinnedEvidence.length,
    hotspotCount,
    flightCount,
    updatedAt: options.lastUpdated,
  };
}

function resolveScope(
  selectedCountry: string | null,
  selectedRegionSlug: string | null,
  regions: RegionRecord[]
): RegionScanScope {
  if (selectedCountry) {
    const centroid = centroidForIso3(selectedCountry);
    return {
      kind: "country",
      title: centroid?.name ?? selectedCountry,
      countryIso3: selectedCountry,
      regionSlug: null,
    };
  }

  if (selectedRegionSlug) {
    const region = regions.find((entry) => entry.slug === selectedRegionSlug) ?? null;
    return {
      kind: "region",
      title: region?.name ?? selectedRegionSlug,
      countryIso3: null,
      regionSlug: selectedRegionSlug,
    };
  }

  return {
    kind: "global",
    title: "Global Watch",
    countryIso3: null,
    regionSlug: null,
  };
}

function filterRowsByScope(rows: SignalRow[], scope: RegionScanScope, regions: RegionRecord[]) {
  if (scope.kind === "country" && scope.countryIso3) {
    return rows.filter((row) => row.iso3Hint === scope.countryIso3);
  }

  if (scope.kind === "region" && scope.regionSlug) {
    const region = regions.find((entry) => entry.slug === scope.regionSlug) ?? null;
    if (!region) {
      return [];
    }

    return rows.filter((row) => regionContainsLatLon(region, row.lat, row.lon));
  }

  return rows;
}

function toEvidence(row: SignalRow, selectedSignalId: string | null, referenceTimestamp: string): ScanEvidenceItem {
  const { ageHours, recencyWeight, weight } = buildEvidenceWeight(row.layer, row.severity, row.timestamp, referenceTimestamp);

  return {
    id: row.id,
    title: row.title,
    detail: row.detail,
    severity: row.severity,
    timestamp: row.timestamp,
    iso3Hint: row.iso3Hint,
    layer: row.layer,
    weight,
    recencyWeight,
    ageHours,
    isPinned: row.id === selectedSignalId,
  };
}

function sortEvidence(left: ScanEvidenceItem, right: ScanEvidenceItem) {
  if (left.weight !== right.weight) {
    return right.weight - left.weight;
  }

  return new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime();
}

function pinEvidence(evidence: ScanEvidenceItem[], selectedSignalId: string | null) {
  if (!selectedSignalId) {
    return evidence;
  }

  const pinned = evidence.find((item) => item.id === selectedSignalId);
  if (!pinned) {
    return evidence;
  }

  return [pinned, ...evidence.filter((item) => item.id !== selectedSignalId)];
}

function resolveDominantLayer(evidence: ScanEvidenceItem[], fallbackLayer: GlobeLayerId) {
  if (evidence.length === 0) {
    return fallbackLayer;
  }

  const weights = new Map<GlobeLayerId, number>();
  for (const item of evidence) {
    weights.set(item.layer, (weights.get(item.layer) ?? 0) + item.weight);
  }

  let dominantLayer = fallbackLayer;
  let strongest = -1;
  for (const [layer, weight] of weights.entries()) {
    if (weight > strongest) {
      dominantLayer = layer;
      strongest = weight;
    }
  }

  return dominantLayer;
}

function resolveTrendDirection(
  scope: RegionScanScope,
  evidence: ScanEvidenceItem[],
  countryMetrics: CountryMetric[]
): ScanTrendDirection {
  const recent = evidence.filter((item) => item.ageHours < 12);
  const older = evidence.filter((item) => item.ageHours >= 12 && item.ageHours < 72);

  if (older.length >= 3) {
    const recentWeight = recent.reduce((sum, item) => sum + item.weight, 0);
    const olderWeight = older.reduce((sum, item) => sum + item.weight, 0);
    const ratio = olderWeight === 0 ? recentWeight : recentWeight / olderWeight;
    const delta = recentWeight - olderWeight;

    if (delta > 0.65 || ratio > 1.18) {
      return "rising";
    }

    if (delta < -0.45 || ratio < 0.82) {
      return "easing";
    }

    return "stable";
  }

  if (scope.kind === "country" && scope.countryIso3) {
    const countryMetric = countryMetrics.find((entry) => entry.iso3 === scope.countryIso3) ?? null;
    return mapFallbackTrend(countryMetric?.delta ?? 0, 0.28, -0.18);
  }

  const layerWeights: Record<GlobeLayerId, number> = {
    conflict: 0,
    health: 0,
    weather: 0,
    flights: 0,
  };
  for (const item of evidence) {
    layerWeights[item.layer] += item.weight;
  }
  const mix = layerWeights.conflict + layerWeights.health + layerWeights.weather * 0.6 - layerWeights.flights * 0.35;
  return mapFallbackTrend(mix, 1.2, -0.25);
}

function mapFallbackTrend(value: number, risingThreshold: number, easingThreshold: number): ScanTrendDirection {
  if (value >= risingThreshold) {
    return "rising";
  }

  if (value <= easingThreshold) {
    return "easing";
  }

  return "stable";
}
