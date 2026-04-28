import type { SourceRef } from "@/lib/intelligence/types";

import { formatRelative, formatUtc, hostnameOf } from "./formatters";

interface SourceListProps {
  sources: SourceRef[];
  compact?: boolean;
}

export function SourceList({ sources, compact = false }: SourceListProps) {
  if (sources.length === 0) {
    return (
      <p className="ws-source-list__empty">
        No provenance attached to this signal yet.
      </p>
    );
  }

  return (
    <ul className={compact ? "ws-source-list ws-source-list--compact" : "ws-source-list"}>
      {sources.map((source, idx) => {
        const host = hostnameOf(source.url) ?? source.publisher ?? source.provider;
        const key = `${source.adapter}:${source.provider_event_id ?? idx}`;
        const retrieved = source.source_timestamp ?? source.retrieved_at;
        return (
          <li key={key} className="ws-source">
            <div className="ws-source__head">
              <span className="ws-source__publisher">{source.publisher ?? host}</span>
              <span className="ws-source__reliability">
                {Math.round(source.reliability * 100)}% reliability
              </span>
            </div>
            <div className="ws-source__meta">
              <span>{source.provider}</span>
              <span aria-hidden>·</span>
              <span title={formatUtc(retrieved)}>{formatRelative(retrieved)}</span>
              {source.url ? (
                <>
                  <span aria-hidden>·</span>
                  <a
                    className="ws-source__link"
                    href={source.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {host ?? "Open source"}
                  </a>
                </>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
