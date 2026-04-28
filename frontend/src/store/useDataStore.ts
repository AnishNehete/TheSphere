import { create } from "zustand";

import type { ConflictSignal, CountryMetric, FlightSignal, HealthSignal, RegionRecord, WeatherSignal } from "@/lib/types";

interface DataState {
  flights: FlightSignal[];
  weather: WeatherSignal[];
  conflicts: ConflictSignal[];
  health: HealthSignal[];
  countryMetrics: CountryMetric[];
  regions: RegionRecord[];
  lastUpdated: string | null;
  setFlights: (flights: FlightSignal[]) => void;
  setWeather: (weather: WeatherSignal[]) => void;
  setConflicts: (conflicts: ConflictSignal[]) => void;
  setHealth: (health: HealthSignal[]) => void;
  setCountryMetrics: (countryMetrics: CountryMetric[]) => void;
  setRegions: (regions: RegionRecord[]) => void;
  setLastUpdated: (timestamp: string) => void;
}

export const useDataStore = create<DataState>((set) => ({
  flights: [],
  weather: [],
  conflicts: [],
  health: [],
  countryMetrics: [],
  regions: [],
  lastUpdated: null,

  setFlights: (flights) => set(() => ({ flights })),
  setWeather: (weather) => set(() => ({ weather })),
  setConflicts: (conflicts) => set(() => ({ conflicts })),
  setHealth: (health) => set(() => ({ health })),
  setCountryMetrics: (countryMetrics) => set(() => ({ countryMetrics })),
  setRegions: (regions) => set(() => ({ regions })),
  setLastUpdated: (lastUpdated) => set(() => ({ lastUpdated })),
}));
