import { LAYER_LABELS } from "@/components/hud/signalRows";
import type { GlobeLayerId, ScanAttentionLevel, ScanEvidenceItem, ScanTrendDirection } from "@/lib/types";

const ATTENTION_LABELS: Record<ScanAttentionLevel, string> = {
  baseline: "Baseline",
  watch: "Watch",
  elevated: "Elevated",
  critical: "Critical",
};

const ATTENTION_PHRASES: Record<ScanAttentionLevel, string> = {
  baseline: "holding a baseline posture",
  watch: "under active watch",
  elevated: "under elevated pressure",
  critical: "under critical pressure",
};

const IMPACT_AREAS: Record<GlobeLayerId, string[]> = {
  conflict: ["border security", "shipping", "civil stability"],
  health: ["public health", "hospital capacity", "mobility"],
  weather: ["infrastructure", "aviation", "supply chain"],
  flights: ["aviation", "mobility", "logistics"],
};

export function getAttentionLabel(level: ScanAttentionLevel) {
  return ATTENTION_LABELS[level];
}

export function getImpactAreasForLayer(layer: GlobeLayerId) {
  return IMPACT_AREAS[layer];
}

export function buildImpactAreas(evidence: ScanEvidenceItem[], limit = 3) {
  const weightedTags = new Map<string, { weight: number; order: number }>();
  let order = 0;

  for (const item of evidence) {
    for (const tag of getImpactAreasForLayer(item.layer)) {
      const existing = weightedTags.get(tag);
      if (existing) {
        existing.weight += item.weight;
        continue;
      }

      weightedTags.set(tag, {
        weight: item.weight,
        order,
      });
      order += 1;
    }
  }

  if (weightedTags.size === 0) {
    return ["routine monitoring"];
  }

  return [...weightedTags.entries()]
    .sort((left, right) => right[1].weight - left[1].weight || left[1].order - right[1].order)
    .slice(0, limit)
    .map(([tag]) => tag);
}

export function buildTrendSummary(options: {
  scopeTitle: string;
  direction: ScanTrendDirection;
  dominantLayer: GlobeLayerId;
  freshSignalCount: number;
  leadSignal: ScanEvidenceItem | null;
}) {
  const { scopeTitle, direction, dominantLayer, freshSignalCount, leadSignal } = options;
  const dominantLabel = LAYER_LABELS[dominantLayer].toLowerCase();

  if (direction === "rising") {
    return `${scopeTitle} is showing rising ${dominantLabel} tempo, with ${freshSignalCount} fresh signals pushing the watch cycle forward${leadSignal ? ` around ${leadSignal.title}` : ""}.`;
  }

  if (direction === "easing") {
    return `${scopeTitle} is showing easing signal tempo, though ${dominantLabel} activity${leadSignal ? ` near ${leadSignal.title}` : ""} still warrants monitoring.`;
  }

  return `${scopeTitle} is holding a steady signal rhythm, with ${dominantLabel} activity broadly consistent with the prior watch cycle.`;
}

export function buildQuietTrendSummary(scopeTitle: string) {
  return `${scopeTitle} is quiet, with no elevated hotspot tempo inside the current scan scope.`;
}

export function buildAnalystBrief(options: {
  scopeTitle: string;
  attentionLevel: ScanAttentionLevel;
  dominantLayer: GlobeLayerId;
  leadSignal: ScanEvidenceItem | null;
  impactAreas: string[];
}) {
  const { scopeTitle, attentionLevel, dominantLayer, leadSignal, impactAreas } = options;
  const dominantLabel = LAYER_LABELS[dominantLayer].toLowerCase();
  const impactPhrase = impactAreas.slice(0, 2).join(" and ");
  const leadPhrase = leadSignal ? ` The lead signal is ${leadSignal.title}.` : "";

  return `${scopeTitle} is ${ATTENTION_PHRASES[attentionLevel]}, with ${dominantLabel} activity setting the operational pace.${leadPhrase} Likely downstream stress centers on ${impactPhrase}.`;
}

export function buildQuietBrief(scopeTitle: string) {
  return `${scopeTitle} is holding a quiet watch posture, with limited frontend evidence above background routing and monitoring activity.`;
}
