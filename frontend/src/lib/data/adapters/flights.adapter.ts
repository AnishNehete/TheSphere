import centroids from "@/assets/geo/country-centroids.json";
import { fetchFlightEvents } from "@/lib/api";
import { findCountryAtLatLon } from "@/lib/three/geo";
import type { CountryCentroid, FlightSignal } from "@/lib/types";

import { mulberry32, nowIso, pickCentroid, runtimeSeedBucket, severityBand, shouldUseDiagnosticsDataContract } from "./shared";

const COUNTRY_CENTROIDS = centroids as CountryCentroid[];

export async function loadFlightsFeed(): Promise<FlightSignal[]> {
  if (shouldUseDiagnosticsDataContract()) {
    return buildFallbackFlights();
  }

  try {
    const events = await fetchFlightEvents(220);
    return events.map((event, index) => {
      const route = event.metadata.route;
      const originPoint = route?.origin ?? { lat: event.lat + 2, lon: event.lon - 6 };
      const destinationPoint = route?.destination ?? { lat: event.lat - 2, lon: event.lon + 6 };
      const callsign = event.metadata.callsign ?? event.metadata.flight_id ?? `FLT-${index + 1}`;
      const matchedCountry = findCountryAtLatLon(event.lat, event.lon);

      return {
        id: event.id,
        callsign,
        origin: event.metadata.origin ?? "UNK",
        destination: event.metadata.destination ?? "UNK",
        originPoint,
        destinationPoint,
        position: {
          lat: event.lat,
          lon: event.lon,
        },
        altitudeFt: event.metadata.altitude_ft ?? 32000,
        speedKts: Math.max(220, Math.round((event.metadata.velocity_mph ?? 480) / 1.15078)),
        severity: severityBand(event.severity),
        timestamp: event.timestamp,
        iso3Hint: matchedCountry?.iso3,
        regionHint: event.metadata.region ?? undefined,
      };
    });
  } catch {
    return buildFallbackFlights();
  }
}

function buildFallbackFlights(): FlightSignal[] {
  const random = mulberry32(runtimeSeedBucket(30_000));
  const signals: FlightSignal[] = [];

  for (let index = 0; index < 84; index += 1) {
    const origin = pickCentroid(COUNTRY_CENTROIDS, random);
    const destination = pickCentroid(COUNTRY_CENTROIDS, random);
    const progress = random();
    const lat = origin.lat + (destination.lat - origin.lat) * progress;
    const lon = origin.lon + (destination.lon - origin.lon) * progress;

    signals.push({
      id: `fallback-flight-${index + 1}`,
      callsign: `SF${String(100 + index)}`,
      origin: origin.name.slice(0, 3).toUpperCase(),
      destination: destination.name.slice(0, 3).toUpperCase(),
      originPoint: { lat: origin.lat, lon: origin.lon },
      destinationPoint: { lat: destination.lat, lon: destination.lon },
      position: { lat, lon },
      altitudeFt: Math.round(29000 + random() * 12000),
      speedKts: Math.round(380 + random() * 190),
      severity: severityBand(random()),
      timestamp: nowIso(),
      iso3Hint: origin.iso3,
    });
  }

  return signals;
}
