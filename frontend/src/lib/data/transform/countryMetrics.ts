import type { ConflictSignal, CountryMetric, FlightSignal, HealthSignal, WeatherSignal } from "@/lib/types";

interface CountryAccumulator {
  flights: number;
  weather: number;
  conflicts: number;
  health: number;
}

export function buildCountryMetrics(input: {
  flights: FlightSignal[];
  weather: WeatherSignal[];
  conflicts: ConflictSignal[];
  health: HealthSignal[];
}): CountryMetric[] {
  const map = new Map<string, CountryAccumulator>();

  const ensure = (iso3: string) => {
    const existing = map.get(iso3);
    if (existing) {
      return existing;
    }
    const next: CountryAccumulator = {
      flights: 0,
      weather: 0,
      conflicts: 0,
      health: 0,
    };
    map.set(iso3, next);
    return next;
  };

  for (const flight of input.flights) {
    if (!flight.iso3Hint) {
      continue;
    }
    ensure(flight.iso3Hint).flights += flight.severity;
  }

  for (const weather of input.weather) {
    if (!weather.iso3Hint) {
      continue;
    }
    ensure(weather.iso3Hint).weather += weather.severity;
  }

  for (const conflict of input.conflicts) {
    if (!conflict.iso3Hint) {
      continue;
    }
    ensure(conflict.iso3Hint).conflicts += conflict.severity;
  }

  for (const health of input.health) {
    if (!health.iso3Hint) {
      continue;
    }
    ensure(health.iso3Hint).health += health.severity;
  }

  const rows: CountryMetric[] = [];
  for (const [iso3, row] of map.entries()) {
    const score = row.flights * 0.25 + row.weather * 0.2 + row.conflicts * 0.35 + row.health * 0.2;
    const delta = (row.conflicts + row.health) * 0.22 - row.flights * 0.08;
    rows.push({
      iso3,
      score: round(score),
      delta: round(delta),
      label: score > 2.2 ? "Escalating" : score > 1.4 ? "Watch" : "Stable",
    });
  }

  return rows.sort((left, right) => right.score - left.score);
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
