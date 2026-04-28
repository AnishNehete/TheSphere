"use client";

import { useMemo } from "react";

import {
  computeWindowDelta,
  formatDeltaChip,
  type WindowDelta,
} from "@/lib/intelligence/trends";
import { summariseChangesSince } from "@/lib/intelligence/timeline";
import type { SignalEvent } from "@/lib/intelligence/types";
import { getBetaConfig } from "@/lib/runtime/betaConfig";
import { useOverlayStore } from "@/store/useOverlayStore";
import {
  isDomainStale,
  useSignalRailStore,
} from "@/store/useSignalRailStore";

import {
  DOMAIN_LABEL,
  DomainIcon,
  SIGNAL_DOMAINS,
  type SignalDomain,
} from "./DomainIcon";
import {
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  countryTagFromEvent,
  formatRelative,
} from "./formatters";

// Phase 15A — multi-domain awareness rail.
// Wave 15C — adds:
//   - per-tab staleness dot when a domain hasn't refreshed inside its
//     freshness budget (defined in useSignalRailStore)
//   - replay-aware "what changed" line driven by the workspace asOf cursor
//   - 24h delta chip per tab so the rail itself communicates trend, not
//     just the most recent items
export function SignalStrip() {
  const newsFromOverlay = useOverlayStore((s) => s.latestSignals);
  const openEvent = useOverlayStore((s) => s.openEvent);
  const asOf = useOverlayStore((s) => s.portfolioAsOf);

  const selectedDomain = useSignalRailStore((s) => s.selectedDomain);
  const setSelectedDomain = useSignalRailStore((s) => s.setSelectedDomain);
  const byDomain = useSignalRailStore((s) => s.byDomain);
  const errorByDomain = useSignalRailStore((s) => s.errorByDomain);
  const metaByDomain = useSignalRailStore((s) => s.metaByDomain);

  const railSignals = useMemo<SignalEvent[]>(() => {
    if (selectedDomain === "news") {
      const bucket = byDomain.news ?? [];
      if (bucket.length > 0) return bucket;
      return newsFromOverlay;
    }
    return byDomain[selectedDomain] ?? [];
  }, [byDomain, newsFromOverlay, selectedDomain]);

  const sorted = useMemo(() => {
    return [...railSignals].sort((a, b) => {
      const sev = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
      if (sev !== 0) return sev;
      const aTs = a.source_timestamp ?? a.ingested_at;
      const bTs = b.source_timestamp ?? b.ingested_at;
      return Date.parse(bTs) - Date.parse(aTs);
    });
  }, [railSignals]);

  const errorMessage = errorByDomain[selectedDomain] ?? null;
  const stale = isDomainStale(metaByDomain[selectedDomain], selectedDomain);
  const betaConfig = useMemo(() => getBetaConfig(), []);
  const feedHealth = useMemo(() => {
    if (errorMessage) return "down" as const;
    if (stale) return "stale" as const;
    if (metaByDomain[selectedDomain]?.lastSuccessAt) return "ok" as const;
    return "stale" as const;
  }, [errorMessage, stale, metaByDomain, selectedDomain]);

  const delta24h = useMemo(
    () => computeWindowDelta(railSignals, "24h", asOf),
    [railSignals, asOf],
  );

  const changesSince = useMemo(
    () => summariseChangesSince(railSignals, "24h", asOf),
    [railSignals, asOf],
  );

  return (
    <div
      className={`ws-strip ws-strip--signal${asOf ? " ws-strip--asof" : ""}`}
      aria-label="Latest intelligence signals"
      data-testid="signal-rail"
      data-domain={selectedDomain}
      data-asof={asOf ?? ""}
      // Phase 17A.3 follow-up — drive the rail's pulsation off the
      // computed feed health. When the feed is ok the container gets
      // a soft breath; stale/down kills the breath so the operator
      // reads a degraded surface as visibly still.
      data-feed-health={feedHealth}
    >
      <div className="ws-strip__head">
        <span className="ws-eyebrow">
          {/* Live dot mirrors the tape's pulse on the lower rail so
              the awareness rail also reads as visibly alive. The dot
              only animates when the feed is ok; CSS handles the
              suppression for stale/down via [data-feed-health]. */}
          <span className="ws-strip__live-dot" aria-hidden="true" />
          Awareness rail
          {asOf ? (
            <span className="ws-strip__asof-chip" data-testid="signal-rail-asof">
              · as of {asOf.slice(0, 10)}
            </span>
          ) : null}
        </span>
        <span className="ws-strip__count">
          {betaConfig.feedHealthVisible ? (
            <span
              className="ws-feed-health"
              data-testid="signal-rail-health"
              data-health={feedHealth}
              title={
                feedHealth === "down"
                  ? "Feed offline — last attempt failed"
                  : feedHealth === "stale"
                    ? "Feed stale — past freshness budget"
                    : "Feed live — within freshness budget"
              }
            >
              <span className={`ws-feed-health__dot ws-feed-health__dot--${feedHealth}`} />
              {feedHealth === "ok" ? "Live" : feedHealth === "stale" ? "Stale" : "Down"}
            </span>
          ) : null}
          {" "}
          {sorted.length > 0 ? `${sorted.length} active` : "—"}
        </span>
      </div>

      <DomainTabs
        selected={selectedDomain}
        onSelect={setSelectedDomain}
        metaByDomain={metaByDomain}
      />

      <p
        className="ws-rail-changes"
        data-testid="signal-rail-changes"
      >
        {changesSince.copy}
      </p>

      {stale ? (
        <p
          className="ws-rail-stale"
          role="status"
          data-testid="signal-rail-stale"
        >
          Feed is stale — last fresh page returned {formatRelative(metaByDomain[selectedDomain]?.lastSuccessAt)}.
        </p>
      ) : null}

      {errorMessage ? (
        <p className="ws-rail-error" role="status">
          {errorMessage}
        </p>
      ) : null}

      {sorted.length === 0 ? (
        <p className="ws-rail-empty">
          No active {DOMAIN_LABEL[selectedDomain].toLowerCase()} signals right now.
        </p>
      ) : (
        <ul className="ws-strip__list">
          {sorted.slice(0, 25).map((event) => {
            const country =
              event.place.country_code ?? countryTagFromEvent(event.tags);
            return (
              <li key={event.id}>
                <button
                  type="button"
                  className="ws-chip-row ws-chip-row--with-icon"
                  onClick={() => openEvent(event, "signal-strip")}
                  title={event.title}
                  data-testid="rail-item"
                >
                  <span
                    className={`ws-dot ws-dot--${event.severity}`}
                    aria-hidden
                  />
                  <span className="ws-chip-row__main">
                    <span className="ws-chip-row__icon" aria-hidden>
                      <DomainIcon domain={selectedDomain} size={12} />
                    </span>
                    <span className="ws-chip-row__title">{event.title}</span>
                  </span>
                  <span className="ws-chip-row__meta">
                    {country ? (
                      <span className="ws-chip-row__country">{country}</span>
                    ) : null}
                    <span>{SEVERITY_LABEL[event.severity]}</span>
                    <span>
                      {formatRelative(
                        event.source_timestamp ?? event.ingested_at,
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div
        className="ws-rail-trend"
        data-testid="signal-rail-trend"
        aria-label="Trend over the last 24 hours"
      >
        <RailDeltaChip delta={delta24h} />
      </div>
    </div>
  );
}

interface RailDeltaChipProps {
  delta: WindowDelta;
}

function RailDeltaChip({ delta }: RailDeltaChipProps) {
  return (
    <span
      className={`ws-rail-trend__chip ws-rail-trend__chip--${delta.direction}`}
      data-direction={delta.direction}
    >
      {formatDeltaChip(delta)}
    </span>
  );
}

interface DomainTabsProps {
  selected: SignalDomain;
  onSelect: (domain: SignalDomain) => void;
  metaByDomain: Partial<Record<SignalDomain, { lastSuccessAt: string | null }>>;
}

function DomainTabs({ selected, onSelect, metaByDomain }: DomainTabsProps) {
  return (
    <div
      className="ws-rail-tabs"
      role="tablist"
      aria-label="Signal domains"
      data-testid="rail-tabs"
    >
      {SIGNAL_DOMAINS.map((domain) => {
        const active = domain === selected;
        const meta = metaByDomain[domain];
        const stale = meta ? isDomainStale(meta as never, domain) : false;
        return (
          <button
            key={domain}
            type="button"
            role="tab"
            aria-selected={active}
            className={`ws-rail-tab${active ? " ws-rail-tab--active" : ""}${stale ? " ws-rail-tab--stale" : ""}`}
            onClick={() => onSelect(domain)}
            data-domain={domain}
            data-stale={stale ? "true" : "false"}
            data-testid={`rail-tab-${domain}`}
          >
            <DomainIcon domain={domain} size={13} />
            <span className="ws-rail-tab__label">{DOMAIN_LABEL[domain]}</span>
            {stale ? (
              <span
                className="ws-rail-tab__stale-dot"
                aria-hidden
                title="Feed past freshness budget"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
