"use client";

import type {
  AgentResponse,
  ScopeUsed,
} from "@/lib/intelligence/types";

// Phase 18A.4 — small chip strip surfacing the resolution badge for the
// primary subject. Complements (does not replace) the existing
// ResolvedEntityChip row in QueryPanel: this row exposes the *scope*
// confidence and exact/alias/region/global classification so the user
// can see whether the answer is grounded on a precise match or a
// region-wide fallback.

interface ResolvedEntitiesBadgesProps {
  response: Pick<
    AgentResponse,
    "scope_used" | "scope_confidence" | "resolved_place" | "fallback_notice"
  >;
}

const SCOPE_LABEL: Record<ScopeUsed, string> = {
  exact_place: "Exact place",
  country: "Country",
  region: "Region",
  global: "Global",
};

export function ResolvedEntitiesBadges({
  response,
}: ResolvedEntitiesBadgesProps) {
  const place = response.resolved_place;
  if (place === null) {
    return null;
  }
  const confidencePct = Math.round(response.scope_confidence * 100);
  return (
    <div
      className="ws-resolved-badges"
      data-testid="resolved-entities-badges"
    >
      <span className="ws-resolved-badges__name">
        {place.name ?? place.query}
      </span>
      <span
        className="ws-resolved-badges__chip"
        data-scope={response.scope_used}
      >
        {SCOPE_LABEL[response.scope_used]}
      </span>
      <span
        className="ws-resolved-badges__chip"
        data-variant="confidence"
        title="Scope confidence"
      >
        {confidencePct}% confidence
      </span>
      {response.fallback_notice ? (
        <span
          className="ws-resolved-badges__chip"
          data-variant="fallback"
          data-testid="resolved-entities-fallback-badge"
        >
          Fallback
        </span>
      ) : null}
    </div>
  );
}
