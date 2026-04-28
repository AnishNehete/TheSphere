import type { GlobeLayerId, ScanAttentionLevel, ScanEvidenceItem } from "@/lib/types";

const HOURS_PER_MS = 1 / (1000 * 60 * 60);

const LAYER_WEIGHTS: Record<GlobeLayerId, number> = {
  conflict: 1.2,
  health: 1.05,
  weather: 0.95,
  flights: 0.75,
};

export interface RegionScore {
  densityScore: number;
  severityScore: number;
  recencyScore: number;
  flightScore: number;
  compositeScore: number;
  score: number;
  attentionLevel: ScanAttentionLevel;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function getLayerWeight(layer: GlobeLayerId) {
  return LAYER_WEIGHTS[layer];
}

export function getRecencyWeight(timestamp: string, referenceTimestamp: string | null) {
  const referenceMs = referenceTimestamp ? new Date(referenceTimestamp).getTime() : Date.now();
  const signalMs = new Date(timestamp).getTime();
  if (Number.isNaN(referenceMs) || Number.isNaN(signalMs)) {
    return 0.3;
  }

  const ageHours = Math.max(0, (referenceMs - signalMs) * HOURS_PER_MS);
  if (ageHours < 6) {
    return 1;
  }

  if (ageHours < 24) {
    return 0.8;
  }

  if (ageHours < 72) {
    return 0.55;
  }

  return 0.3;
}

export function getAgeHours(timestamp: string, referenceTimestamp: string | null) {
  const referenceMs = referenceTimestamp ? new Date(referenceTimestamp).getTime() : Date.now();
  const signalMs = new Date(timestamp).getTime();
  if (Number.isNaN(referenceMs) || Number.isNaN(signalMs)) {
    return 999;
  }

  return Math.max(0, (referenceMs - signalMs) * HOURS_PER_MS);
}

export function buildEvidenceWeight(
  layer: GlobeLayerId,
  severity: number,
  timestamp: string,
  referenceTimestamp: string | null
) {
  const recencyWeight = getRecencyWeight(timestamp, referenceTimestamp);
  const weight = severity * recencyWeight * getLayerWeight(layer);

  return {
    recencyWeight,
    weight: round(weight),
    ageHours: round(getAgeHours(timestamp, referenceTimestamp)),
  };
}

export function mapAttentionLevel(score: number): ScanAttentionLevel {
  if (score >= 78) {
    return "critical";
  }

  if (score >= 58) {
    return "elevated";
  }

  if (score >= 35) {
    return "watch";
  }

  return "baseline";
}

export function scoreRegion(evidence: Pick<ScanEvidenceItem, "layer" | "weight" | "recencyWeight">[]): RegionScore {
  const hotspots = evidence
    .filter((item) => item.layer !== "flights")
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 5);
  const flights = evidence
    .filter((item) => item.layer === "flights")
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 8);

  const densityScore = clamp01(evidence.filter((item) => item.layer !== "flights").length / 10);
  const severityScore = clamp01(average(hotspots.map((item) => item.weight)) / 1.1);
  const recencyScore = clamp01(average(hotspots.map((item) => item.recencyWeight)));
  const flightScore = clamp01(flights.reduce((sum, item) => sum + item.weight, 0) / 5);
  const compositeScore = round(densityScore * 0.35 + severityScore * 0.35 + recencyScore * 0.15 + flightScore * 0.15);
  const score = Math.round(compositeScore * 100);

  return {
    densityScore: round(densityScore),
    severityScore: round(severityScore),
    recencyScore: round(recencyScore),
    flightScore: round(flightScore),
    compositeScore,
    score,
    attentionLevel: mapAttentionLevel(score),
  };
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
