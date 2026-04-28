import centroids from "@/assets/geo/country-centroids.json";
import type { CountryCentroid, HealthSignal } from "@/lib/types";

import { mulberry32, nowIso, pickCentroid, runtimeSeedBucket, severityBand } from "./shared";

const COUNTRY_CENTROIDS = centroids as CountryCentroid[];
const HEALTH_LABELS = ["Respiratory Cluster", "Vector Spread", "Hospital Surge", "Containment Alert", "Pathogen Drift"];

export async function loadHealthFeed(): Promise<HealthSignal[]> {
  const random = mulberry32(runtimeSeedBucket(60_000, 0xac18f4));
  const items: HealthSignal[] = [];

  for (let index = 0; index < 38; index += 1) {
    const pivot = pickCentroid(COUNTRY_CENTROIDS, random);
    items.push({
      id: `health-${pivot.iso3}-${index + 1}`,
      label: `${HEALTH_LABELS[index % HEALTH_LABELS.length]} / ${pivot.name}`,
      center: {
        lat: pivot.lat + (random() - 0.5) * 3.4,
        lon: pivot.lon + (random() - 0.5) * 4.2,
      },
      spread: Math.round(20 + random() * 340),
      severity: severityBand(random()),
      timestamp: nowIso(),
      iso3Hint: pivot.iso3,
    });
  }

  return items;
}
