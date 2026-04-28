"use client";

import { useEffect, useState } from "react";

import { SharedInvestigationView } from "@/components/workspace/SharedInvestigationView";
import {
  getSharedInvestigation,
  type SavedInvestigationWire,
} from "@/lib/intelligence/investigations";
import { IntelligenceApiError } from "@/lib/intelligence/types";

// Phase 17B.3 — read-only share route.
//
// Lives outside the InvestigationWorkspace tree on purpose: the share
// surface must not mount the live globe, polling hooks, mode switcher,
// or saved-investigations menu. The unguessable share token in the URL
// IS the auth boundary — the route makes no auth headers and never
// surfaces mutation actions.
//
// Honest-freshness rule: this page renders the frozen snapshot only.
// It does not silently re-fetch /market/{symbol}/posture or any other
// live endpoint. The captured_at + age + provider_health_at_capture
// fields ride the banner so the recipient understands what they are
// looking at.

interface SharePageProps {
  params: { token: string };
}

type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; record: SavedInvestigationWire }
  | { phase: "error"; status: number | null; message: string };

export default function SharePage({ params }: SharePageProps) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const record = await getSharedInvestigation(params.token, {
          signal: controller.signal,
        });
        if (cancelled) return;
        setState({ phase: "ready", record });
      } catch (err) {
        if (cancelled) return;
        const status =
          err instanceof IntelligenceApiError ? err.status : null;
        const message =
          err instanceof Error ? err.message : "Failed to load share";
        setState({ phase: "error", status, message });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [params.token]);

  if (state.phase === "loading") {
    return (
      <div className="ws-share-page" data-testid="share-loading">
        <div className="ws-share-page__center">
          <span className="ws-share-page__spinner" aria-hidden />
          <p>Loading shared investigation…</p>
        </div>
      </div>
    );
  }

  if (state.phase === "error") {
    const isMissing = state.status === 404;
    return (
      <div className="ws-share-page" data-testid="share-error">
        <div className="ws-share-page__center">
          <h1 className="ws-share-page__error-title">
            {isMissing ? "Share link not found" : "Could not load share"}
          </h1>
          <p className="ws-share-page__error-body">
            {isMissing
              ? "This share link has been revoked, deleted, or never existed."
              : state.message}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="ws-share-page">
      <SharedInvestigationView record={state.record} />
    </div>
  );
}
