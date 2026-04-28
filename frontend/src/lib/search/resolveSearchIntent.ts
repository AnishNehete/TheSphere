import { postQuery } from "@/lib/api";
import { getCountryCentroids } from "@/lib/three/geo";
import type {
  ConflictSignal,
  FlightSignal,
  GlobeLayerId,
  HealthSignal,
  RegionRecord,
  SearchResolution,
  WeatherSignal,
} from "@/lib/types";

interface ResolveSearchIntentOptions {
  query: string;
  flights: FlightSignal[];
  weather: WeatherSignal[];
  conflicts: ConflictSignal[];
  health: HealthSignal[];
  regions: RegionRecord[];
}

const LAYER_ALIASES: Record<string, GlobeLayerId> = {
  aviation: "flights",
  conflict: "conflict",
  disease: "health",
  diseases: "health",
  flights: "flights",
  health: "health",
  outbreak: "health",
  weather: "weather",
};

export async function resolveSearchIntent({
  query,
  flights,
  weather,
  conflicts,
  health,
  regions,
}: ResolveSearchIntentOptions): Promise<SearchResolution> {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      query,
      type: "none",
      label: "No query",
      message: "Enter a country, region, layer, or live signal.",
    };
  }

  const normalized = normalizeToken(trimmed);
  const country = resolveCountry(normalized);
  if (country) {
    return {
      query,
      type: "country",
      label: country.name,
      countryIso3: country.iso3,
    };
  }

  const signal = resolveSignal(normalized, flights, weather, conflicts, health);
  if (signal) {
    return signal;
  }

  const localRegion = resolveRegion(normalized, regions);
  if (localRegion) {
    return {
      query,
      type: "region",
      label: localRegion.name,
      regionSlug: localRegion.slug,
    };
  }

  const localLayer = resolveLayer(normalized);
  if (localLayer) {
    return {
      query,
      type: "layer",
      label: titleCase(localLayer),
      layer: localLayer,
    };
  }

  try {
    const backendResult = await postQuery(trimmed);
    if (backendResult.entityId) {
      const backendSignal = resolveSignal(normalizeToken(backendResult.entityId), flights, weather, conflicts, health);
      if (backendSignal) {
        return {
          ...backendSignal,
          layer: backendResult.layer ?? backendSignal.layer ?? null,
        };
      }
    }

    if (backendResult.region) {
      const region = regions.find((entry) => entry.slug === backendResult.region);
      if (region) {
        return {
          query,
          type: "region",
          label: region.name,
          regionSlug: region.slug,
          layer: backendResult.layer,
        };
      }
    }

    if (backendResult.layer) {
      return {
        query,
        type: "layer",
        label: titleCase(backendResult.layer),
        layer: backendResult.layer,
      };
    }
  } catch {
    // Keep local fallback behavior when the backend query endpoint is unavailable.
  }

  return {
    query,
    type: "none",
    label: "No exact match",
    message: "Try a country name, ISO3 code, layer, region, or a live callsign.",
  };
}

function resolveCountry(token: string) {
  return getCountryCentroids().find((entry) => {
    const iso3 = normalizeToken(entry.iso3);
    const name = normalizeToken(entry.name);
    return token === iso3 || token === name || name.includes(token);
  });
}

function resolveRegion(token: string, regions: RegionRecord[]) {
  return regions.find((entry) => {
    const slug = normalizeToken(entry.slug);
    const name = normalizeToken(entry.name);
    return token === slug || token === name || name.includes(token);
  });
}

function resolveLayer(token: string) {
  return LAYER_ALIASES[token] ?? null;
}

function resolveSignal(
  token: string,
  flights: FlightSignal[],
  weather: WeatherSignal[],
  conflicts: ConflictSignal[],
  health: HealthSignal[]
): SearchResolution | null {
  const flight = flights.find((entry) => normalizeToken(entry.callsign) === token);
  if (flight) {
    return {
      query: token,
      type: "signal",
      label: flight.callsign,
      signalId: flight.id,
      countryIso3: flight.iso3Hint,
      layer: "flights",
    };
  }

  const weatherSignal = weather.find((entry) => normalizeToken(entry.label) === token);
  if (weatherSignal) {
    return {
      query: token,
      type: "signal",
      label: weatherSignal.label,
      signalId: weatherSignal.id,
      countryIso3: weatherSignal.iso3Hint,
      layer: "weather",
    };
  }

  const conflictSignal = conflicts.find((entry) => normalizeToken(entry.label) === token);
  if (conflictSignal) {
    return {
      query: token,
      type: "signal",
      label: conflictSignal.label,
      signalId: conflictSignal.id,
      countryIso3: conflictSignal.iso3Hint,
      layer: "conflict",
    };
  }

  const healthSignal = health.find((entry) => normalizeToken(entry.label) === token);
  if (healthSignal) {
    return {
      query: token,
      type: "signal",
      label: healthSignal.label,
      signalId: healthSignal.id,
      countryIso3: healthSignal.iso3Hint,
      layer: "health",
    };
  }

  return null;
}

function normalizeToken(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
