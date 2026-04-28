import centroids from "@/assets/geo/country-centroids.json";
import type { CountryCentroid, WeatherSignal } from "@/lib/types";

import { mulberry32, nowIso, pickCentroid, runtimeSeedBucket, severityBand } from "./shared";

const COUNTRY_CENTROIDS = centroids as CountryCentroid[];
const WEATHER_LABELS = ["Cyclone", "Heat Dome", "Flood Pulse", "Wind Shear", "Arctic Surge", "Storm Front"];

export async function loadWeatherFeed(): Promise<WeatherSignal[]> {
  const random = mulberry32(runtimeSeedBucket(45_000, 0x4f2f5a));
  const items: WeatherSignal[] = [];

  for (let index = 0; index < 48; index += 1) {
    const pivot = pickCentroid(COUNTRY_CENTROIDS, random);
    const label = WEATHER_LABELS[index % WEATHER_LABELS.length];
    items.push({
      id: `weather-${pivot.iso3}-${index + 1}`,
      label: `${label} / ${pivot.name}`,
      center: {
        lat: pivot.lat + (random() - 0.5) * 6,
        lon: pivot.lon + (random() - 0.5) * 8,
      },
      radiusKm: Math.round(120 + random() * 850),
      severity: severityBand(random()),
      timestamp: nowIso(),
      iso3Hint: pivot.iso3,
    });
  }

  return items;
}
