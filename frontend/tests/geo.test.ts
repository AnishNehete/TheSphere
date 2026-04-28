import { findCountryAtLatLon } from "@/lib/three/geo";

const COUNTRY_FIXTURES = [
  { iso3: "USA", lat: 39.5, lon: -98.35 },
  { iso3: "BRA", lat: -14.2, lon: -51.9 },
  { iso3: "FRA", lat: 46.2, lon: 2.2 },
  { iso3: "IND", lat: 22.4, lon: 79.1 },
  { iso3: "JPN", lat: 36.2, lon: 138.3 },
  { iso3: "AUS", lat: -25.3, lon: 133.8 },
  { iso3: "ZAF", lat: -29.0, lon: 24.0 },
  { iso3: "EGY", lat: 26.7, lon: 30.8 },
  { iso3: "ARG", lat: -34.0, lon: -64.0 },
  { iso3: "MEX", lat: 23.6, lon: -102.5 },
] as const;

describe("country lookup diagnostics", () => {
  it("matches 10 centroid test points across continents", () => {
    for (const fixture of COUNTRY_FIXTURES) {
      const match = findCountryAtLatLon(fixture.lat, fixture.lon);
      expect(match?.iso3).toBe(fixture.iso3);
    }
  });
});
