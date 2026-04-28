import { LAYER_LABELS } from "@/components/hud/signalRows";
import { centroidForIso3 } from "@/lib/three/geo";
import type { AppState } from "@/store/useAppStore";
import type { useDataStore } from "@/store/useDataStore";
import type { CountryMetric, GlobeLayerId, RegionRecord, ScanEvidenceItem } from "@/lib/types";

import { buildRegionScan } from "../scan/buildRegionScan";
import { scoreRegion } from "../scan/scoreRegion";

export interface HomepageInvestigationSection {
  title: string;
  body: string;
}

export interface HomepageEvidenceItem extends ScanEvidenceItem {
  sourceLabel: string;
  sourceType: "feed" | "derived";
  rationale: string;
  confidence: number;
}

export interface HomepageDependencyEdge {
  id: string;
  from: string;
  to: string;
  rationale: string;
  confidence: number;
  evidenceIds: string[];
}

export interface HomepageDriver {
  id: string;
  title: string;
  explanation: string;
  weight: number;
  evidenceIds: string[];
}

export interface HomepageAction {
  id: string;
  label: string;
  detail: string;
}

export interface HomepageInvestigationModel {
  title: string;
  scopeLabel: string;
  statusLabel: string;
  activeLayer: GlobeLayerId;
  activeLayerLabel: string;
  updatedAt: string | null;
  resolvedEntity: string;
  summary: HomepageInvestigationSection;
  whyItMatters: HomepageInvestigationSection;
  confidence: number;
  score: {
    value: number;
    delta: number;
    confidence: number;
    evidenceCount: number;
    drivers: HomepageDriver[];
  };
  evidence: HomepageEvidenceItem[];
  dependencyPath: HomepageDependencyEdge[];
  actions: HomepageAction[];
  exportSummary: string;
  relatedEntities: string[];
}

type DataState = ReturnType<typeof useDataStore.getState>;

const SOURCE_LABELS: Record<GlobeLayerId, string> = {
  conflict: "Conflict feed",
  flights: "Aviation feed",
  health: "Health feed",
  weather: "Weather feed",
};

const ACTION_DETAILS: Record<GlobeLayerId, string> = {
  conflict: "Escalation exposure and route continuity review",
  flights: "Carrier, route, and airport continuity review",
  health: "Capacity, mobility, and continuity review",
  weather: "Weather disruption and downstream schedule review",
};

// The homepage uses one derived investigation object so every section reads the
// same scope, evidence, score, and action context instead of recomputing its
// own local version of the investigation.
export function buildHomepageInvestigation(appState: AppState, dataState: DataState): HomepageInvestigationModel {
  const scan = buildRegionScan({
    activeLayer: appState.activeLayer,
    selectedCountry: appState.selectedCountry,
    selectedRegionSlug: appState.selectedRegionSlug,
    selectedSignalId: appState.selectedSignalId,
    flights: dataState.flights,
    weather: dataState.weather,
    conflicts: dataState.conflicts,
    health: dataState.health,
    countryMetrics: dataState.countryMetrics,
    regions: dataState.regions,
    lastUpdated: dataState.lastUpdated,
  });

  const countryMetric = resolveCountryMetric(scan.scope.countryIso3 ?? null, dataState.countryMetrics);
  const evidence = scan.evidence.slice(0, 8).map((item) => decorateEvidence(item));
  const scoring = scoreRegion(evidence);
  const delta = resolveDelta(scan.evidence, countryMetric);
  const confidence = resolveConfidence(evidence);
  const drivers = buildDrivers(evidence);
  const dependencyPath = buildDependencyPath(scan.title, evidence, scan.likelyImpactAreas);
  const actions = buildActions(scan.title, scan.dominantLayer, dependencyPath);
  const summary = buildSummary(scan.title, scan.brief, scan.topSignals[0]?.title ?? null, scan.trendDirection, confidence);
  const whyItMatters = buildWhyItMatters(scan.title, evidence, scan.likelyImpactAreas, scan.trendDirection);
  const resolvedEntity = resolveEntityLabel(scan.scope.countryIso3 ?? null, scan.scope.regionSlug ?? null, dataState.regions);

  return {
    title: scan.title,
    scopeLabel: scan.scope.kind === "country" ? "Country investigation" : scan.scope.kind === "region" ? "Regional investigation" : "Global watchlist",
    statusLabel: attentionToStatus(scan.attentionLevel),
    activeLayer: scan.dominantLayer,
    activeLayerLabel: LAYER_LABELS[scan.dominantLayer],
    updatedAt: scan.updatedAt,
    resolvedEntity,
    summary,
    whyItMatters,
    confidence,
    score: {
      value: scan.score,
      delta,
      confidence,
      evidenceCount: evidence.length,
      drivers,
    },
    evidence,
    dependencyPath,
    actions,
    exportSummary: `${scan.title}: ${summary.body}`,
    relatedEntities: scan.likelyImpactAreas.slice(0, 3),
  };
}

function decorateEvidence(item: ScanEvidenceItem): HomepageEvidenceItem {
  const confidence = Math.max(0.38, Math.min(0.96, Number((item.recencyWeight * 0.55 + item.severity * 0.45).toFixed(2))));
  return {
    ...item,
    sourceLabel: SOURCE_LABELS[item.layer],
    sourceType: "feed",
    rationale: `${LAYER_LABELS[item.layer]} signal severity ${item.severity.toFixed(2)} with freshness weight ${item.recencyWeight.toFixed(2)}.`,
    confidence,
  };
}

function buildDrivers(evidence: HomepageEvidenceItem[]): HomepageDriver[] {
  return evidence.slice(0, 3).map((item) => ({
    id: item.id,
    title: item.title,
    explanation: `${item.rationale} It currently leads the investigation because it is one of the strongest scoped signals.`,
    weight: Number(item.weight.toFixed(2)),
    evidenceIds: [item.id],
  }));
}

function buildDependencyPath(scopeTitle: string, evidence: HomepageEvidenceItem[], impactAreas: string[]): HomepageDependencyEdge[] {
  if (evidence.length === 0) {
    return [];
  }

  const lead = evidence[0];
  const secondary = evidence[1] ?? lead;
  const firstImpact = impactAreas[0] ?? "operational continuity";
  const secondImpact = impactAreas[1] ?? "executive monitoring";

  return [
    {
      id: "edge-scope-lead",
      from: scopeTitle,
      to: lead.title,
      rationale: `The investigation centers on ${lead.title} because it is the strongest current signal inside the selected scope.`,
      confidence: lead.confidence,
      evidenceIds: [lead.id],
    },
    {
      id: "edge-lead-secondary",
      from: lead.title,
      to: secondary.title === lead.title ? firstImpact : secondary.title,
      rationale:
        secondary.title === lead.title
          ? `With no competing lead signal, the strongest evidence rolls directly into ${firstImpact}.`
          : `${secondary.title} remains in-path because it shares the same scope and sustains the pressure indicated by the lead evidence.`,
      confidence: Number(Math.max(0.42, Math.min(0.94, (lead.confidence + secondary.confidence) / 2)).toFixed(2)),
      evidenceIds: secondary.title === lead.title ? [lead.id] : [lead.id, secondary.id],
    },
    {
      id: "edge-secondary-impact",
      from: secondary.title === lead.title ? firstImpact : secondary.title,
      to: secondImpact,
      rationale: `This edge is shown because the current evidence mix points to downstream pressure on ${secondImpact}.`,
      confidence: Number(Math.max(0.4, Math.min(0.9, secondary.confidence - 0.06)).toFixed(2)),
      evidenceIds: [secondary.id],
    },
  ];
}

function buildActions(scopeTitle: string, activeLayer: GlobeLayerId, dependencyPath: HomepageDependencyEdge[]): HomepageAction[] {
  return [
    {
      id: "export",
      label: "Export brief",
      detail: `Prepare a concise analyst brief for ${scopeTitle}.`,
    },
    {
      id: "copy-summary",
      label: "Copy summary",
      detail: `Capture the current executive summary and score context.`,
    },
    {
      id: "investigate-related",
      label: "Investigate related",
      detail: dependencyPath[1]?.to
        ? `Use the current path to continue into ${dependencyPath[1].to}.`
        : ACTION_DETAILS[activeLayer],
    },
  ];
}

function buildSummary(
  scopeTitle: string,
  brief: string,
  leadSignalTitle: string | null,
  trendDirection: "rising" | "stable" | "easing",
  confidence: number
): HomepageInvestigationSection {
  const directionCopy =
    trendDirection === "rising" ? "Pressure is building." : trendDirection === "easing" ? "Pressure is easing." : "Pressure is holding steady.";

  return {
    title: "Executive summary",
    body: `${brief} ${directionCopy} ${leadSignalTitle ? `Lead evidence remains ${leadSignalTitle}.` : `${scopeTitle} is currently in a quiet posture.`} Confidence ${Math.round(
      confidence * 100
    )}%.`,
  };
}

function buildWhyItMatters(
  scopeTitle: string,
  evidence: HomepageEvidenceItem[],
  impactAreas: string[],
  trendDirection: "rising" | "stable" | "easing"
): HomepageInvestigationSection {
  if (evidence.length === 0) {
    return {
      title: "Why it matters",
      body: `${scopeTitle} does not currently have elevated scoped evidence, so the right action is continued monitoring instead of escalation.`,
    };
  }

  const lead = evidence[0];
  const impact = impactAreas[0] ?? "operational continuity";
  const movement = trendDirection === "rising" ? "is increasing" : trendDirection === "easing" ? "is softening" : "is holding";
  return {
    title: "Why it matters",
    body: `${lead.title} anchors the current view. Exposure ${movement}, and the strongest likely downstream effect is pressure on ${impact}.`,
  };
}

function resolveConfidence(evidence: HomepageEvidenceItem[]) {
  if (evidence.length === 0) {
    return 0.34;
  }

  const avg = evidence.reduce((sum, item) => sum + item.confidence, 0) / evidence.length;
  const densityBonus = Math.min(0.12, evidence.length * 0.015);
  return Number(Math.max(0.36, Math.min(0.96, avg + densityBonus)).toFixed(2));
}

function resolveDelta(evidence: ScanEvidenceItem[], countryMetric: CountryMetric | null) {
  if (countryMetric) {
    return Number(countryMetric.delta.toFixed(2));
  }

  const recentWeight = evidence.filter((item) => item.ageHours < 12).reduce((sum, item) => sum + item.weight, 0);
  const olderWeight = evidence.filter((item) => item.ageHours >= 12 && item.ageHours < 72).reduce((sum, item) => sum + item.weight, 0);
  return Number((recentWeight - olderWeight).toFixed(2));
}

function resolveCountryMetric(iso3: string | null, metrics: CountryMetric[]) {
  if (!iso3) {
    return null;
  }

  return metrics.find((entry) => entry.iso3 === iso3) ?? null;
}

function resolveEntityLabel(selectedCountry: string | null, selectedRegionSlug: string | null, regions: RegionRecord[]) {
  if (selectedCountry) {
    return centroidForIso3(selectedCountry)?.name ?? selectedCountry;
  }

  if (selectedRegionSlug) {
    return regions.find((entry) => entry.slug === selectedRegionSlug)?.name ?? selectedRegionSlug;
  }

  return "Global Watch";
}

function attentionToStatus(level: "baseline" | "watch" | "elevated" | "critical") {
  switch (level) {
    case "critical":
      return "Critical attention";
    case "elevated":
      return "Elevated attention";
    case "watch":
      return "Active watch";
    default:
      return "Baseline monitoring";
  }
}
