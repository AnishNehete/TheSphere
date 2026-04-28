"use client";

import { useEffect, useMemo, useState } from "react";

import {
  describeAge,
  type SavedInvestigationWire,
} from "@/lib/intelligence/investigations";
import type {
  MarketNarrative,
  MarketPostureResponse,
  PostureLabel,
  ProviderHealth,
} from "@/lib/intelligence/types";

// Phase 17B.3 — read-only share surface.
//
// This is intentionally NOT the full investigation workspace. The goal
// is "anyone with the link can see exactly what was captured" — not
// "open a fresh interactive investigation". So:
//
//   * No globe canvas mount (no Three.js, no live polling).
//   * No mode switcher, no search input, no Save / Compare / Portfolio
//     pivots — sharing must not let a recipient mutate the analyst's
//     workspace through a public URL.
//   * The frozen snapshot is the only data source. We never re-call
//     /market/{symbol}/posture or /market/{symbol}/narrative on this
//     page — doing so would silently replace the operator's captured
//     view with a different one.
//   * captured_at + age + provider_health_at_capture ride the banner
//     so the recipient understands exactly how old this view is.
//
// The age label refreshes once a minute so a tab left open for an
// hour still shows "62m ago" rather than the original "2m ago".

interface SharedInvestigationViewProps {
  record: SavedInvestigationWire;
}

const POSTURE_TONE: Record<PostureLabel, string> = {
  strong_sell: "ws-share-posture--strong-sell",
  sell: "ws-share-posture--sell",
  neutral: "ws-share-posture--neutral",
  buy: "ws-share-posture--buy",
  strong_buy: "ws-share-posture--strong-buy",
};

const PROVIDER_LABEL: Record<ProviderHealth, string> = {
  live: "Provider: live at capture",
  degraded: "Provider: degraded at capture",
  unsupported: "Provider: unsupported at capture",
  unconfigured: "Provider: unconfigured at capture",
};

export function SharedInvestigationView({
  record,
}: SharedInvestigationViewProps) {
  const { snapshot } = record;
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const age = useMemo(
    () => describeAge(snapshot.captured_at, now),
    [snapshot.captured_at, now],
  );

  const captured = useMemo(
    () => new Date(snapshot.captured_at),
    [snapshot.captured_at],
  );

  return (
    <div className="ws-share" data-testid="shared-investigation-view">
      <header className="ws-share__banner" role="status">
        <div className="ws-share__banner-row">
          <div className="ws-share__brand" aria-hidden>
            <span className="ws-share__mark">◎</span>
            <span className="ws-share__brandname">Sphere</span>
          </div>
          <span className="ws-share__pill">Read-only snapshot</span>
        </div>
        <h1 className="ws-share__title">{record.name}</h1>
        <p className="ws-share__sub">
          <span data-testid="shared-captured-at">
            Captured {captured.toLocaleString()}
          </span>
          <span aria-hidden> · </span>
          <span data-testid="shared-age">{age.text}</span>
          <span aria-hidden> · </span>
          <span data-testid="shared-provider">
            {PROVIDER_LABEL[snapshot.provider_health_at_capture]}
          </span>
          {snapshot.freshness_seconds_at_capture !== null ? (
            <>
              <span aria-hidden> · </span>
              <span>
                {snapshot.freshness_seconds_at_capture}s data freshness at
                capture
              </span>
            </>
          ) : null}
        </p>
      </header>

      <main className="ws-share__body">
        <section className="ws-share__panel">
          <h2 className="ws-share__panel-title">Selection</h2>
          <SelectionSummary snapshot={snapshot} />
        </section>

        {snapshot.market_posture ? (
          <section className="ws-share__panel">
            <h2 className="ws-share__panel-title">Market posture (frozen)</h2>
            <PostureBlock posture={snapshot.market_posture} />
            {snapshot.market_narrative ? (
              <NarrativeBlock narrative={snapshot.market_narrative} />
            ) : null}
          </section>
        ) : null}

        {snapshot.compare_targets.length > 0 ? (
          <section className="ws-share__panel">
            <h2 className="ws-share__panel-title">Compare set</h2>
            <ul className="ws-share__list">
              {snapshot.compare_targets.map((t) => (
                <li key={`${t.kind}:${t.id}`} className="ws-share__compare-row">
                  <span className="ws-share__compare-kind">{t.kind}</span>
                  <span className="ws-share__compare-label">{t.label}</span>
                  {t.country_code ? (
                    <span className="ws-share__compare-iso">
                      {t.country_code}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {snapshot.caveats.length > 0 ? (
          <section className="ws-share__panel ws-share__panel--caveats">
            <h2 className="ws-share__panel-title">Caveats at capture</h2>
            <ul className="ws-share__caveats">
              {snapshot.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="ws-share__footer">
          This is a read-only snapshot. Numbers and posture were captured
          at the time shown above and have not been refreshed.
        </footer>
      </main>
    </div>
  );
}

function SelectionSummary({
  snapshot,
}: {
  snapshot: SavedInvestigationWire["snapshot"];
}) {
  const { selection } = snapshot;
  const rows: Array<[string, string]> = [];
  rows.push(["Mode", snapshot.workspace_mode]);
  if (selection.country_name || selection.country_code) {
    rows.push([
      "Country",
      `${selection.country_name ?? ""}${
        selection.country_code ? ` (${selection.country_code})` : ""
      }`.trim(),
    ]);
  }
  if (selection.event_summary || selection.event_id) {
    rows.push(["Event", selection.event_summary ?? selection.event_id ?? "—"]);
  }
  if (selection.market_symbol) {
    rows.push([
      "Market",
      `${selection.market_symbol}${
        selection.market_asset_class
          ? ` (${selection.market_asset_class})`
          : ""
      }`,
    ]);
  }
  if (snapshot.portfolio_id) {
    rows.push(["Portfolio", snapshot.portfolio_id]);
  }
  if (snapshot.portfolio_as_of) {
    rows.push([
      "As-of cursor",
      new Date(snapshot.portfolio_as_of).toLocaleString(),
    ]);
  }

  return (
    <dl className="ws-share__defs">
      {rows.map(([label, value]) => (
        <div key={label} className="ws-share__def">
          <dt>{label}</dt>
          <dd>{value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function PostureBlock({ posture }: { posture: MarketPostureResponse }) {
  const tone = POSTURE_TONE[posture.posture];
  return (
    <div className={`ws-share-posture ${tone}`}>
      <div className="ws-share-posture__head">
        <span className="ws-share-posture__symbol">{posture.symbol}</span>
        <span className="ws-share-posture__label">{posture.posture_label}</span>
        <span className="ws-share-posture__confidence">
          conf {Math.round(posture.confidence * 100)}%
        </span>
      </div>
      {posture.drivers.length > 0 ? (
        <ul className="ws-share-posture__drivers">
          {posture.drivers.map((d, idx) => (
            <li key={`${d.component}-${idx}`}>
              <span className="ws-share-posture__driver-label">{d.label}</span>
              <span className="ws-share-posture__driver-rationale">
                {d.rationale}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {posture.caveats.length > 0 ? (
        <ul className="ws-share-posture__caveats">
          {posture.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function NarrativeBlock({ narrative }: { narrative: MarketNarrative }) {
  return (
    <div className="ws-share-narrative" data-source={narrative.source}>
      <p className="ws-share-narrative__body">{narrative.narrative}</p>
      <p className="ws-share-narrative__meta">
        Source: {narrative.source} · alignment: {narrative.posture_alignment_check}
      </p>
    </div>
  );
}
