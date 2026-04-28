// Phase 12.3 — TS mirror of the backend gazetteer.
// Kept deliberately small (~30 entries) so the globe can render zoom-aware
// place labels without a network round-trip on every frame. The backend
// gazetteer remains the canonical source — when a label is clicked we route
// the *exact name* back through `/api/intelligence/query/agent`, which uses
// the backend PlaceResolver to do the real resolution.
//
// Tier semantics (used by the label layer):
//   1 = capitals + financial / logistics megahubs (visible at medium zoom)
//   2 = secondary financial / shipping / port hubs  (visible at close zoom)
//   3 = chokepoints + ports                         (visible at close zoom)
//
// Add new entries only when the backend gazetteer grows — this list MUST
// stay aligned (any name here that the backend cannot resolve will produce
// a confusing "no place found" notice).

export type PlaceLabelType = "city" | "port" | "chokepoint" | "region";

export interface PlaceLabel {
  id: string;
  name: string;
  type: PlaceLabelType;
  countryCode: string | null;
  lat: number;
  lon: number;
  tier: 1 | 2 | 3;
}

export const PLACE_LABELS: readonly PlaceLabel[] = [
  // Tier 1 — capitals + financial / logistics megahubs
  { id: "city:tokyo",        name: "Tokyo",        type: "city", countryCode: "JPN", lat: 35.6762, lon: 139.6503, tier: 1 },
  { id: "city:singapore",    name: "Singapore",    type: "city", countryCode: "SGP", lat: 1.2966,  lon: 103.852,  tier: 1 },
  { id: "city:hong-kong",    name: "Hong Kong",    type: "city", countryCode: "HKG", lat: 22.2793, lon: 114.1628, tier: 1 },
  { id: "city:shanghai",     name: "Shanghai",     type: "city", countryCode: "CHN", lat: 31.2304, lon: 121.4737, tier: 1 },
  { id: "city:beijing",      name: "Beijing",      type: "city", countryCode: "CHN", lat: 39.9042, lon: 116.4074, tier: 1 },
  { id: "city:seoul",        name: "Seoul",        type: "city", countryCode: "KOR", lat: 37.5665, lon: 126.978,  tier: 1 },
  { id: "city:new-york",     name: "New York",     type: "city", countryCode: "USA", lat: 40.7128, lon: -74.006,  tier: 1 },
  { id: "city:los-angeles",  name: "Los Angeles",  type: "city", countryCode: "USA", lat: 34.0522, lon: -118.2437,tier: 1 },
  { id: "city:london",       name: "London",       type: "city", countryCode: "GBR", lat: 51.5074, lon: -0.1278,  tier: 1 },
  { id: "city:paris",        name: "Paris",        type: "city", countryCode: "FRA", lat: 48.8566, lon: 2.3522,   tier: 1 },
  { id: "city:frankfurt",    name: "Frankfurt",    type: "city", countryCode: "DEU", lat: 50.1109, lon: 8.6821,   tier: 1 },
  { id: "city:dubai",        name: "Dubai",        type: "city", countryCode: "ARE", lat: 25.2048, lon: 55.2708,  tier: 1 },
  { id: "city:cairo",        name: "Cairo",        type: "city", countryCode: "EGY", lat: 30.0444, lon: 31.2357,  tier: 1 },
  { id: "city:riyadh",       name: "Riyadh",       type: "city", countryCode: "SAU", lat: 24.7136, lon: 46.6753,  tier: 1 },

  // Tier 2 — secondary cities and port-cities
  { id: "city:osaka",     name: "Osaka",     type: "city", countryCode: "JPN", lat: 34.6937, lon: 135.5023, tier: 2 },
  { id: "city:yokohama",  name: "Yokohama",  type: "city", countryCode: "JPN", lat: 35.4437, lon: 139.638,  tier: 2 },
  { id: "city:shenzhen",  name: "Shenzhen",  type: "city", countryCode: "CHN", lat: 22.5431, lon: 114.0579, tier: 2 },
  { id: "city:rotterdam", name: "Rotterdam", type: "city", countryCode: "NLD", lat: 51.9244, lon: 4.4777,   tier: 2 },

  // Tier 3 — chokepoints + ports (premium operational signal)
  { id: "chokepoint:suez",         name: "Suez Canal",      type: "chokepoint", countryCode: "EGY", lat: 30.5852, lon: 32.2654, tier: 1 },
  { id: "chokepoint:hormuz",       name: "Strait of Hormuz",type: "chokepoint", countryCode: null,  lat: 26.5667, lon: 56.25,   tier: 1 },
  { id: "chokepoint:bab-el-mandeb",name: "Bab el-Mandeb",   type: "chokepoint", countryCode: null,  lat: 12.5833, lon: 43.3333, tier: 2 },
  { id: "chokepoint:malacca",      name: "Strait of Malacca",type: "chokepoint", countryCode: null, lat: 2.5,     lon: 101.0,   tier: 2 },
  { id: "chokepoint:panama",       name: "Panama Canal",    type: "chokepoint", countryCode: "PAN", lat: 9.08,    lon: -79.68,  tier: 2 },
  { id: "port:singapore",          name: "Port of Singapore",type: "port",      countryCode: "SGP", lat: 1.2644,  lon: 103.84,  tier: 3 },
  { id: "port:rotterdam",          name: "Port of Rotterdam",type: "port",      countryCode: "NLD", lat: 51.95,   lon: 4.1428,  tier: 3 },
  { id: "port:shanghai",           name: "Port of Shanghai", type: "port",      countryCode: "CHN", lat: 30.6333, lon: 122.0833,tier: 3 },
  { id: "port:jebel-ali",          name: "Port Jebel Ali",   type: "port",      countryCode: "ARE", lat: 24.9857, lon: 55.0272, tier: 3 },
  { id: "port:hong-kong",          name: "Port of Hong Kong",type: "port",      countryCode: "HKG", lat: 22.3089, lon: 114.227, tier: 3 },
  { id: "port:tokyo",              name: "Port of Tokyo",    type: "port",      countryCode: "JPN", lat: 35.6186, lon: 139.7724,tier: 3 },
] as const;

// Camera distance thresholds (units = three.js scene units, with
// GLOBE_RADIUS = 1). The camera "explore" pose is ~3.8; a country focus
// pose is ~1.9. These thresholds give:
//   distance > 3.0  → no labels (wide explore view)
//   2.0 < d <= 3.0  → tier 1 only (capitals + megahubs + key chokepoints)
//   d <= 2.0        → tier 1 + 2 + 3 (cities, ports, all chokepoints)
export const PLACE_LABEL_TIER_DISTANCE: Record<1 | 2 | 3, number> = {
  1: 3.0,
  2: 2.0,
  3: 1.7,
};

export function tierForDistance(distance: number): 0 | 1 | 2 | 3 {
  if (distance > PLACE_LABEL_TIER_DISTANCE[1]) return 0;
  if (distance > PLACE_LABEL_TIER_DISTANCE[2]) return 1;
  if (distance > PLACE_LABEL_TIER_DISTANCE[3]) return 2;
  return 3;
}

export function findPlaceLabelById(id: string): PlaceLabel | null {
  return PLACE_LABELS.find((p) => p.id === id) ?? null;
}
