import type { SignalSeverity } from "@/lib/intelligence/types";

export const SEVERITY_LABEL: Record<SignalSeverity, string> = {
  info: "Info",
  watch: "Watch",
  elevated: "Elevated",
  critical: "Critical",
};

export const SEVERITY_ORDER: Record<SignalSeverity, number> = {
  critical: 3,
  elevated: 2,
  watch: 1,
  info: 0,
};

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const diff = Date.now() - then;
  const seconds = Math.max(0, Math.round(diff / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  return then.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

export function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 100)}%`;
}

export function hostnameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function countryTagFromEvent(tags: string[]): string | null {
  const tag = tags.find((t) => t.startsWith("country:"));
  if (!tag) return null;
  return tag.slice("country:".length).toUpperCase();
}

export function categoryLabel(type: string): string {
  const map: Record<string, string> = {
    weather: "Weather",
    news: "News",
    flights: "Flights",
    conflict: "Conflict",
    health: "Health",
    disease: "Disease",
    mood: "Mood",
    markets: "Markets",
    stocks: "Equities",
    commodities: "Commodities",
    currency: "FX",
  };
  return map[type] ?? type;
}
