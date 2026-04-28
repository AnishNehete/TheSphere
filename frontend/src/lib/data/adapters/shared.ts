import type { CountryCentroid } from "@/lib/types";
import {
  getRuntimeSeedBucket,
  getRuntimeTimestamp,
  isDiagnosticsRuntimeEnabled,
} from "@/lib/runtime/renderSettings";

export function mulberry32(seed: number) {
  let current = seed >>> 0;
  return () => {
    current += 0x6d2b79f5;
    let result = Math.imul(current ^ (current >>> 15), current | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickCentroid(centroids: CountryCentroid[], random: () => number) {
  const index = Math.floor(random() * centroids.length);
  return centroids[index] ?? centroids[0];
}

export function nowIso() {
  return getRuntimeTimestamp();
}

export function severityBand(value: number, min = 0.25, max = 0.95) {
  const clamped = Math.min(1, Math.max(0, value));
  return min + clamped * (max - min);
}

export function runtimeSeedBucket(intervalMs: number, salt = 0) {
  return getRuntimeSeedBucket(intervalMs, salt);
}

export function shouldUseDiagnosticsDataContract() {
  return isDiagnosticsRuntimeEnabled();
}
