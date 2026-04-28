import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2 } from "three";

import centroids from "@/assets/geo/country-centroids.json";
import countriesLow from "@/assets/geo/countries.med.geo.json";
import type { CountryCentroid, LatLon, RegionRecord } from "@/lib/types";

import { latLonToVector3 } from "./coordinate";

type LonLat = [number, number];
type Ring = LonLat[];

interface GeoFeature {
  id: string;
  properties: {
    name?: string;
  };
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
}

interface PolygonRings {
  outer: Ring;
  holes: Ring[];
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  referenceLon: number;
}

interface PreparedCountryFeature {
  id: string;
  name: string;
  polygons: PolygonRings[];
  minLat: number;
  maxLat: number;
}

interface GeoLikeFeature {
  geometry: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  };
}

const COUNTRY_CENTROIDS = centroids as CountryCentroid[];
const COUNTRY_FEATURES = (countriesLow as { type: "FeatureCollection"; features: GeoFeature[] }).features;
const FEATURE_MAP = new Map(COUNTRY_FEATURES.map((feature) => [feature.id, feature]));
const CENTROID_MAP = new Map(COUNTRY_CENTROIDS.map((entry) => [entry.iso3, entry]));
const PREPARED_FEATURES = COUNTRY_FEATURES.map(prepareCountryFeature);

export function getCountryCentroids() {
  return COUNTRY_CENTROIDS;
}

export function getCountryFeatures() {
  return COUNTRY_FEATURES;
}

export function getCountryFeatureByIso3(iso3: string) {
  return FEATURE_MAP.get(iso3) ?? null;
}

export function centroidForIso3(iso3: string): CountryCentroid | null {
  return CENTROID_MAP.get(iso3) ?? null;
}

export function normalizeLatLonPair(latLon: LatLon): LatLon {
  return {
    lat: Math.max(-90, Math.min(90, latLon.lat)),
    lon: wrapLongitude(latLon.lon),
  };
}

export function findCountryAtLatLon(lat: number, lon: number) {
  const point = normalizeLatLonPair({ lat, lon });

  for (const feature of PREPARED_FEATURES) {
    if (point.lat < feature.minLat || point.lat > feature.maxLat) {
      continue;
    }

    for (const polygon of feature.polygons) {
      const alignedLon = alignLongitude(point.lon, polygon.referenceLon);
      if (
        point.lat < polygon.minLat ||
        point.lat > polygon.maxLat ||
        alignedLon < polygon.minLon ||
        alignedLon > polygon.maxLon
      ) {
        continue;
      }

      if (pointInPolygon(point, polygon)) {
        return centroidForIso3(feature.id);
      }
    }
  }

  return null;
}

export function buildBorderLineGeometry(radius = 1.001, iso3?: string | null) {
  const features = iso3 ? COUNTRY_FEATURES.filter((feature) => feature.id === iso3) : COUNTRY_FEATURES;
  return buildLineGeometry(features, radius);
}

export function buildCountryBorderGeometry(iso3: string, radius = 1.001) {
  return buildBorderLineGeometry(radius, iso3);
}

export function buildCountryFillGeometry(iso3: string, radius = 1.0025) {
  const feature = getCountryFeatureByIso3(iso3);
  if (!feature) {
    return null;
  }

  return buildFillGeometry(feature, radius);
}

export function buildRegionFillGeometry(region: RegionRecord, radius = 1.0035) {
  return buildFillGeometry(region.geojson, radius);
}

export function buildRegionBorderGeometry(region: RegionRecord, radius = 1.004) {
  return buildLineGeometry([region.geojson], radius);
}

export function regionContainsLatLon(region: RegionRecord, lat: number, lon: number) {
  const point = normalizeLatLonPair({ lat, lon });
  const polygons = extractPolygons(region.geojson);
  return polygons.some((polygon) => pointInPolygon(point, polygon));
}

function buildLineGeometry(features: GeoLikeFeature[], radius: number) {
  const points: number[] = [];

  for (const feature of features) {
    const polygons = extractPolygons(feature);
    for (const polygon of polygons) {
      for (const ring of [polygon.outer, ...polygon.holes]) {
        for (let index = 0; index < ring.length; index += 1) {
          const current = ring[index];
          const next = ring[(index + 1) % ring.length];
          appendProjectedSegments(points, current, next, radius);
        }
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(points, 3));
  return geometry;
}

function buildFillGeometry(feature: GeoLikeFeature, radius: number) {
  const positions: number[] = [];
  const polygons = extractPolygons(feature);

  for (const polygon of polygons) {
    if (polygon.outer.length < 3) {
      continue;
    }

    const reference = approximateReference(polygon.outer);
    const contour = polygon.outer.map((entry) => projectToLocal(entry, reference));
    const holes = polygon.holes.map((ring) => ring.map((entry) => projectToLocal(entry, reference)));
    const vertices = [
      ...polygon.outer.map((entry) => latLonToVector3(entry[1], entry[0], radius)),
      ...polygon.holes.flat().map((entry) => latLonToVector3(entry[1], entry[0], radius)),
    ];

    const triangles = ShapeUtils.triangulateShape(
      contour.map((entry) => new Vector2(entry.x, entry.y)),
      holes.map((ring) => ring.map((entry) => new Vector2(entry.x, entry.y)))
    );

    for (const [a, b, c] of triangles) {
      const va = vertices[a];
      const vb = vertices[b];
      const vc = vertices[c];
      positions.push(va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z);
    }
  }

  if (positions.length === 0) {
    return null;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function extractPolygons(feature: GeoLikeFeature): PolygonRings[] {
  if (feature.geometry.type === "Polygon") {
    return [normalizePolygon(feature.geometry.coordinates as number[][][])];
  }

  return (feature.geometry.coordinates as number[][][][]).map(normalizePolygon);
}

function normalizePolygon(polygon: number[][][]) {
  const outer = normalizeRing(polygon[0]);
  const holes = polygon.slice(1).map(normalizeRing).filter((ring) => ring.length >= 3);
  const latitudes = outer.map((entry) => entry[1]);
  const referenceLon = approximateReference(outer).lon;
  const alignedLongitudes = outer.map((entry) => alignLongitude(entry[0], referenceLon));
  return {
    outer,
    holes,
    minLat: Math.min(...latitudes),
    maxLat: Math.max(...latitudes),
    minLon: Math.min(...alignedLongitudes),
    maxLon: Math.max(...alignedLongitudes),
    referenceLon,
  };
}

function normalizeRing(ring: number[][]): Ring {
  const normalized = ring.map((entry) => [wrapLongitude(entry[0]), clampLatitude(entry[1])] as LonLat);
  if (normalized.length > 1) {
    const [firstLon, firstLat] = normalized[0];
    const [lastLon, lastLat] = normalized[normalized.length - 1];
    if (firstLon === lastLon && firstLat === lastLat) {
      normalized.pop();
    }
  }
  return normalized;
}

function prepareCountryFeature(feature: GeoFeature): PreparedCountryFeature {
  const polygons = extractPolygons(feature);
  const latitudes = polygons.flatMap((polygon) => polygon.outer.map((entry) => entry[1]));
  return {
    id: feature.id,
    name: feature.properties.name ?? feature.id,
    polygons,
    minLat: Math.min(...latitudes),
    maxLat: Math.max(...latitudes),
  };
}

function pointInPolygon(point: LatLon, polygon: PolygonRings) {
  if (!pointInRing(point, polygon.outer, polygon.referenceLon)) {
    return false;
  }

  for (const hole of polygon.holes) {
    if (pointInRing(point, hole, polygon.referenceLon)) {
      return false;
    }
  }

  return true;
}

function pointInRing(point: LatLon, ring: Ring, referenceLon: number) {
  let inside = false;
  const pointLon = alignLongitude(point.lon, referenceLon);

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const current = ring[index];
    const prev = ring[previous];
    const xi = alignLongitude(current[0], referenceLon);
    const yi = current[1];
    const xj = alignLongitude(prev[0], referenceLon);
    const yj = prev[1];
    const denominator = yj - yi;

    const intersects =
      yi > point.lat !== yj > point.lat &&
      pointLon < ((xj - xi) * (point.lat - yi)) / (denominator === 0 ? Number.EPSILON : denominator) + xi;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function appendProjectedSegments(points: number[], from: LonLat, to: LonLat, radius: number) {
  const startLon = wrapLongitude(from[0]);
  const startLat = clampLatitude(from[1]);
  const endLon = alignLongitude(wrapLongitude(to[0]), startLon);
  const endLat = clampLatitude(to[1]);

  const spanLon = endLon - startLon;
  const spanLat = endLat - startLat;
  const steps = Math.max(1, Math.min(48, Math.ceil(Math.max(Math.abs(spanLon), Math.abs(spanLat)) / 1.6)));

  let previous = latLonToVector3(startLat, startLon, radius);
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const lat = startLat + spanLat * t;
    const lon = wrapLongitude(startLon + spanLon * t);
    const current = latLonToVector3(lat, lon, radius);
    points.push(previous.x, previous.y, previous.z, current.x, current.y, current.z);
    previous = current;
  }
}

function approximateReference(ring: Ring) {
  const referenceLon = ring[0]?.[0] ?? 0;
  const centroid = ring.reduce(
    (accumulator, entry) => ({
      lon: accumulator.lon + alignLongitude(entry[0], referenceLon),
      lat: accumulator.lat + entry[1],
    }),
    { lon: 0, lat: 0 }
  );

  return {
    lon: centroid.lon / ring.length,
    lat: centroid.lat / ring.length,
  };
}

function projectToLocal(entry: LonLat, reference: { lon: number; lat: number }) {
  const alignedLon = alignLongitude(entry[0], reference.lon);
  const x = (alignedLon - reference.lon) * Math.cos((reference.lat * Math.PI) / 180);
  const y = entry[1] - reference.lat;
  return { x, y };
}

function alignLongitude(lon: number, referenceLon: number) {
  let current = lon;
  while (current - referenceLon > 180) {
    current -= 360;
  }
  while (current - referenceLon < -180) {
    current += 360;
  }
  return current;
}

function wrapLongitude(lon: number) {
  let current = lon;
  while (current < -180) {
    current += 360;
  }
  while (current > 180) {
    current -= 360;
  }
  return current;
}

function clampLatitude(lat: number) {
  return Math.max(-90, Math.min(90, lat));
}
