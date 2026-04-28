"use client";

import { useEffect, useState } from "react";

import {
  getDependenciesForCountry,
  getDependenciesForEvent,
} from "@/lib/intelligence/client";
import type { DependencyPath, DependencyResponse } from "@/lib/intelligence/types";
import { IntelligenceApiError } from "@/lib/intelligence/types";
import { useOverlayStore } from "@/store/useOverlayStore";

interface DependencySectionProps {
  countryCode?: string | null;
  eventId?: string | null;
}

// Phase 12C — renders ranked downstream paths as compact chains. Each node is
// clickable (pivots the overlay when a node points at a known country or
// event); each edge exposes its rationale and evidence link so the user can
// audit the reasoning without leaving the panel.
export function DependencySection({ countryCode, eventId }: DependencySectionProps) {
  const [response, setResponse] = useState<DependencyResponse | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openCountry = useOverlayStore((s) => s.openCountry);

  useEffect(() => {
    if (!countryCode && !eventId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const fetcher = countryCode
      ? getDependenciesForCountry(countryCode, { signal: controller.signal })
      : getDependenciesForEvent(eventId!, { signal: controller.signal });
    fetcher
      .then((value) => setResponse(value))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message =
          err instanceof IntelligenceApiError
            ? "Dependency reasoning is temporarily unavailable."
            : err instanceof Error
              ? err.message
              : "Dependency lookup failed.";
        setError(message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [countryCode, eventId]);

  return (
    <section className="ws-section">
      <h3 className="ws-section__title">
        Dependency paths
        {response ? (
          <span className="ws-section__count">{response.paths.length}</span>
        ) : null}
      </h3>

      {isLoading && !response ? (
        <div className="ws-skeleton" aria-busy="true">
          <div className="ws-skeleton__block" style={{ width: "65%" }} />
          <div className="ws-skeleton__block" style={{ width: "45%" }} />
        </div>
      ) : null}

      {error && !response ? (
        <div className="ws-empty">
          <span className="ws-eyebrow">Unavailable</span>
          <p>{error}</p>
        </div>
      ) : null}

      {response && response.paths.length === 0 ? (
        <div className="ws-empty">
          <span className="ws-eyebrow">No ranked path</span>
          <p>
            No downstream template matches the current scope. Focus a specific
            event or wait for more evidence.
          </p>
        </div>
      ) : null}

      {response && response.paths.length > 0 ? (
        <ul className="ws-dep-list">
          {response.paths.map((path) => (
            <PathRow key={path.id} path={path} onCountryClick={openCountry} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function PathRow({
  path,
  onCountryClick,
}: {
  path: DependencyPath;
  onCountryClick: (code: string, name?: string, intent?: "deep-link") => void;
}) {
  return (
    <li className="ws-dep">
      <div className="ws-dep__head">
        <span className="ws-dep__title">{path.title}</span>
        <span className="ws-dep__conf">
          {Math.round(path.overall_confidence * 100)}%
        </span>
      </div>

      <ol className="ws-dep__chain">
        {path.nodes.map((node, idx) => (
          <li key={node.id} className="ws-dep__node-wrap">
            <button
              type="button"
              className="ws-dep__node"
              onClick={() => {
                if (node.country_code) {
                  onCountryClick(node.country_code, undefined, "deep-link");
                }
              }}
              disabled={!node.country_code}
              title={node.country_code ? `Open country: ${node.country_code}` : node.label}
            >
              <span className="ws-dep__domain">{node.domain}</span>
              <span className="ws-dep__label">{node.label}</span>
            </button>
            {idx < path.edges.length && path.edges[idx].from_id === node.id ? (
              <div
                className="ws-dep__edge"
                title={path.edges[idx].rationale}
              >
                <span className="ws-dep__edge-arrow" aria-hidden>→</span>
                <span className="ws-dep__edge-label">
                  {path.edges[idx].relation}
                  <span className="ws-dep__edge-conf">
                    {Math.round(path.edges[idx].confidence * 100)}%
                  </span>
                </span>
              </div>
            ) : null}
          </li>
        ))}
      </ol>

      <p className="ws-dep__rationale">{path.rationale}</p>
    </li>
  );
}
