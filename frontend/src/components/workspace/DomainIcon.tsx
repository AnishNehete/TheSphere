"use client";

import type { SignalCategory } from "@/lib/intelligence/types";

// Phase 15A — restrained, monochrome SVG glyphs for the six surfaced
// intelligence domains. Inline SVGs (no icon-lib dependency) so the visual
// language stays disciplined and matches the dark operational shell.
// Each glyph is centered in a 16x16 viewBox at 1.5px stroke weight.

export type SignalDomain =
  | "news"
  | "stocks"
  | "weather"
  | "flights"
  | "health"
  | "conflict";

export const SIGNAL_DOMAINS: readonly SignalDomain[] = [
  "news",
  "stocks",
  "weather",
  "flights",
  "health",
  "conflict",
] as const;

export const DOMAIN_LABEL: Record<SignalDomain, string> = {
  news: "News",
  stocks: "Stocks",
  weather: "Weather",
  flights: "Flights",
  health: "Health",
  conflict: "Conflict",
};

// Map UI-domain to backend SignalCategory values used by /events/latest.
export const DOMAIN_TO_CATEGORY: Record<SignalDomain, SignalCategory> = {
  news: "news",
  stocks: "stocks",
  weather: "weather",
  flights: "flights",
  health: "health",
  conflict: "conflict",
};

// Map a backend signal type onto the UI domain it should render under.
// Returns null when the signal does not belong to any of the surfaced
// domains (e.g. mood, markets, currency — handled by other surfaces).
export function categoryToDomain(type: SignalCategory): SignalDomain | null {
  switch (type) {
    case "news":
      return "news";
    case "stocks":
    case "markets":
      return "stocks";
    case "weather":
      return "weather";
    case "flights":
      return "flights";
    case "health":
    case "disease":
      return "health";
    case "conflict":
      return "conflict";
    default:
      return null;
  }
}

interface DomainIconProps {
  domain: SignalDomain;
  size?: number;
  className?: string;
  title?: string;
}

export function DomainIcon({
  domain,
  size = 14,
  className,
  title,
}: DomainIconProps) {
  const path = ICON_PATHS[domain];
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-domain={domain}
    >
      {title ? <title>{title}</title> : null}
      {path}
    </svg>
  );
}

// Path geometry kept inline so the icon set is one file. Glyphs are
// intentionally simple — they need to read at 12-14px in a dense rail.
const ICON_PATHS: Record<SignalDomain, JSX.Element> = {
  news: (
    <>
      <rect x={2.25} y={3.25} width={11.5} height={9.5} rx={1.25} />
      <line x1={4.5} y1={6} x2={11.5} y2={6} />
      <line x1={4.5} y1={8.25} x2={11.5} y2={8.25} />
      <line x1={4.5} y1={10.5} x2={9} y2={10.5} />
    </>
  ),
  stocks: (
    <>
      <polyline points="2.5,11 5.5,7.5 8.5,9.5 13.5,4.5" />
      <polyline points="10.5,4.5 13.5,4.5 13.5,7.5" />
    </>
  ),
  weather: (
    <>
      <path d="M5 10.5 a2.6 2.6 0 1 1 2 -4.4 a3 3 0 0 1 5.6 1.5 a2.4 2.4 0 0 1 -0.6 4.7 H5 a2.4 2.4 0 0 1 0 -1.8 z" />
    </>
  ),
  flights: (
    <>
      <path d="M2.5 9.5 L13.5 5 L11.5 8.5 L8 8.5 L6 13 L5 13 L6 8.5 L3.5 8.5 z" />
    </>
  ),
  health: (
    <>
      <path d="M8 13.5 C 4 11 2 8.5 2 6.25 a2.75 2.75 0 0 1 4.6 -2 L8 5.5 L9.4 4.25 a2.75 2.75 0 0 1 4.6 2 C 14 8.5 12 11 8 13.5 z" />
    </>
  ),
  conflict: (
    <>
      <polygon points="8,2.5 14,13.5 2,13.5" />
      <line x1={8} y1={6.5} x2={8} y2={9.5} />
      <circle cx={8} cy={11.5} r={0.4} fill="currentColor" stroke="none" />
    </>
  ),
};
