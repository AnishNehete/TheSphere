"use client";

import { useOverlayStore } from "@/store/useOverlayStore";

// Phase 19A — small "try these queries" chip row.
//
// Surfaces the four canonical demo queries underneath the command bar
// when no query has been issued yet. The row hides itself once the user
// has run any query so it never competes with the answer surface.

interface ExampleQuery {
  label: string;
  query: string;
  hint: string;
}

const EXAMPLES: readonly ExampleQuery[] = [
  {
    label: "Compare Japan vs Korea",
    query: "compare Japan vs Korea",
    hint: "Two-target country compare",
  },
  {
    label: "Compare oil yesterday vs today",
    query: "compare oil yesterday vs today",
    hint: "Time-shift compare",
  },
  {
    label: "Why is TSLA down?",
    query: "why is TSLA down",
    hint: "Causal driver explanation",
  },
  {
    label: "What changed in Japan last 24h?",
    query: "what changed in Japan last 24h",
    hint: "Windowed delta",
  },
];

export function ExampleQueriesRow() {
  const queryText = useOverlayStore((s) => s.queryText);
  const openQuery = useOverlayStore((s) => s.openQuery);
  const hasQuery = Boolean(queryText && queryText.trim());

  if (hasQuery) {
    return null;
  }

  return (
    <div
      className="ws-examples"
      role="group"
      aria-label="Example queries"
      data-testid="example-queries-row"
    >
      <span className="ws-examples__label">Try</span>
      <ul className="ws-examples__list">
        {EXAMPLES.map((example) => (
          <li key={example.query} className="ws-examples__item">
            <button
              type="button"
              className="ws-examples__chip"
              onClick={() => openQuery(example.query, undefined, "search")}
              title={example.hint}
            >
              {example.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
