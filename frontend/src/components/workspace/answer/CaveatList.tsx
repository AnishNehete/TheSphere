"use client";

// Phase 18A.4 — render the bundle's caveats verbatim. The orchestrator
// only emits a caveat when something honestly limits the answer
// (no-match window, partial compare, broader-corpus fallback). The UI
// must surface them; keeping the list dumb avoids accidentally hiding
// one through prose remixing.

interface CaveatListProps {
  caveats: string[] | null | undefined;
}

export function CaveatList({ caveats }: CaveatListProps) {
  if (!caveats || caveats.length === 0) {
    return null;
  }
  return (
    <section className="ws-section ws-caveats" data-testid="caveat-list">
      <h3 className="ws-section__title">Caveats</h3>
      <ul className="ws-caveats__list">
        {caveats.map((caveat) => (
          <li key={caveat} className="ws-caveats__item">
            {caveat}
          </li>
        ))}
      </ul>
    </section>
  );
}
