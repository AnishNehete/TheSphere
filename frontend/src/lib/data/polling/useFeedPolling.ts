"use client";

import { useEffect, useState } from "react";

import { fetchRegions } from "@/lib/api";
import { loadConflictFeed } from "@/lib/data/adapters/conflict.adapter";
import { loadFlightsFeed } from "@/lib/data/adapters/flights.adapter";
import { loadHealthFeed } from "@/lib/data/adapters/health.adapter";
import { loadWeatherFeed } from "@/lib/data/adapters/weather.adapter";
import { buildCountryMetrics } from "@/lib/data/transform/countryMetrics";
import { getRuntimeTimestamp, isDiagnosticsRuntimeEnabled } from "@/lib/runtime/renderSettings";
import { useDataStore } from "@/store/useDataStore";

const POLL_INTERVAL_MS = 9000;

export function useFeedPolling() {
  const setFlights = useDataStore((state) => state.setFlights);
  const setWeather = useDataStore((state) => state.setWeather);
  const setConflicts = useDataStore((state) => state.setConflicts);
  const setHealth = useDataStore((state) => state.setHealth);
  const setCountryMetrics = useDataStore((state) => state.setCountryMetrics);
  const setRegions = useDataStore((state) => state.setRegions);
  const setLastUpdated = useDataStore((state) => state.setLastUpdated);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: number | null = null;
    const diagnosticsEnabled = isDiagnosticsRuntimeEnabled();

    const loadRegions = async () => {
      try {
        const regions = await fetchRegions();
        if (!active) {
          return;
        }
        setRegions(regions);
      } catch {
        if (!active) {
          return;
        }
        setRegions([]);
      }
    };

    const pull = async () => {
      try {
        const [flights, weather, conflicts, health] = await Promise.all([
          loadFlightsFeed(),
          loadWeatherFeed(),
          loadConflictFeed(),
          loadHealthFeed(),
        ]);

        if (!active) {
          return;
        }

        const countryMetrics = buildCountryMetrics({
          flights,
          weather,
          conflicts,
          health,
        });
        const now = getRuntimeTimestamp();

        setFlights(flights);
        setWeather(weather);
        setConflicts(conflicts);
        setHealth(health);
        setCountryMetrics(countryMetrics);
        setLastUpdated(now);
        setError(null);
        setReady(true);
      } catch (unknownError) {
        if (!active) {
          return;
        }

        const message =
          unknownError instanceof Error ? unknownError.message : "Failed to update live feeds.";
        setError(message);
      } finally {
        if (!active || diagnosticsEnabled) {
          return;
        }

        timer = window.setTimeout(pull, POLL_INTERVAL_MS);
      }
    };

    void loadRegions();
    void pull();

    return () => {
      active = false;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [
    setConflicts,
    setCountryMetrics,
    setFlights,
    setHealth,
    setLastUpdated,
    setRegions,
    setWeather,
  ]);

  return {
    ready,
    error,
  };
}
