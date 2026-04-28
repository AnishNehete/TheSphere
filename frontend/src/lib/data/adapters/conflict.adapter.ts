import centroids from "@/assets/geo/country-centroids.json";
import type { ConflictSignal, CountryCentroid } from "@/lib/types";

import { mulberry32, nowIso, pickCentroid, runtimeSeedBucket, severityBand } from "./shared";

const COUNTRY_CENTROIDS = centroids as CountryCentroid[];

const ACTOR_A = ["State Force", "Regional Guard", "Alliance Group", "Border Unit", "Naval Task Group"];
const ACTOR_B = ["Militia Cell", "Proxy Group", "Insurgent Wing", "Piracy Network", "Paramilitary Wing"];

export async function loadConflictFeed(): Promise<ConflictSignal[]> {
  const random = mulberry32(runtimeSeedBucket(50_000, 0x17e9a3));
  const items: ConflictSignal[] = [];

  for (let index = 0; index < 34; index += 1) {
    const pivot = pickCentroid(COUNTRY_CENTROIDS, random);
    items.push({
      id: `conflict-${pivot.iso3}-${index + 1}`,
      label: `Tension Node / ${pivot.name}`,
      center: {
        lat: pivot.lat + (random() - 0.5) * 4.5,
        lon: pivot.lon + (random() - 0.5) * 5.5,
      },
      severity: severityBand(random(), 0.3, 0.98),
      actors: [ACTOR_A[index % ACTOR_A.length], ACTOR_B[index % ACTOR_B.length]],
      timestamp: nowIso(),
      iso3Hint: pivot.iso3,
    });
  }

  return items;
}
