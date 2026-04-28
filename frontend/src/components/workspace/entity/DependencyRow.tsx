"use client";

import type { ReactNode } from "react";

// Phase 14 — graph-ready dependency row.
// Renders a from → to relationship with rationale + confidence. Consistent
// grammar across place dependencies, portfolio dependencies, and event
// dependencies so a future graph view can reuse the same data model.
interface DependencyRowProps {
  from: ReactNode;
  to: ReactNode;
  relation?: string;
  rationale?: string;
  confidence?: number | null;
  rank?: number;
}

export function DependencyRow({
  from,
  to,
  relation,
  rationale,
  confidence,
  rank,
}: DependencyRowProps) {
  return (
    <div className="ws-dependency-row">
      <div className="ws-dependency-row__head">
        {typeof rank === "number" ? (
          <span className="ws-dependency-row__rank">#{rank + 1}</span>
        ) : null}
        <div className="ws-dependency-row__chain">
          <div className="ws-dependency-row__node">{from}</div>
          <span className="ws-dependency-row__arrow" aria-hidden>→</span>
          <div className="ws-dependency-row__node">{to}</div>
        </div>
        {typeof confidence === "number" ? (
          <span className="ws-dependency-row__conf" title={`Confidence ${Math.round(confidence * 100)}%`}>
            {Math.round(confidence * 100)}%
          </span>
        ) : null}
      </div>
      {relation ? (
        <div className="ws-dependency-row__relation">{relation}</div>
      ) : null}
      {rationale ? (
        <p className="ws-dependency-row__rationale">{rationale}</p>
      ) : null}
    </div>
  );
}
