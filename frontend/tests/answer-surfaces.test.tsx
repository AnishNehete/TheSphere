import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  CaveatList,
  CompareSummaryCard,
  ResolvedEntitiesBadges,
  TimeContextChip,
} from "@/components/workspace/answer";
import type {
  AgentCompareSummary,
  AgentResponse,
  AgentTimeContext,
} from "@/lib/intelligence/types";

// Phase 18A.4 — tests for the four sub-components that surface the
// retrieval orchestrator's typed contract on the answer panel.

function timeContext(
  partial: Partial<AgentTimeContext> & Pick<AgentTimeContext, "kind" | "coverage">,
): AgentTimeContext {
  return {
    label: "live",
    answer_mode_label: "Live",
    since: null,
    until: null,
    matched_event_count: 0,
    is_historical: false,
    ...partial,
  };
}

// ---- TimeContextChip ----------------------------------------------------------

describe("TimeContextChip", () => {
  it("renders nothing for live coverage", () => {
    const { container } = render(
      <TimeContextChip context={timeContext({ kind: "live", coverage: "live" })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a calm chip for windowed coverage", () => {
    render(
      <TimeContextChip
        context={timeContext({
          kind: "since",
          coverage: "windowed",
          label: "last 24h",
          answer_mode_label: "Last 24h",
          matched_event_count: 4,
        })}
      />,
    );
    const chip = screen.getByTestId("time-context-chip");
    expect(chip).toHaveAttribute("data-variant", "windowed");
    expect(chip).toHaveTextContent("Last 24h");
    expect(chip).toHaveTextContent("4 signals");
  });

  it("renders an as_of chip with the timestamp label", () => {
    render(
      <TimeContextChip
        context={timeContext({
          kind: "as_of",
          coverage: "as_of",
          label: "as of 2026-04-19 12:00 UTC",
          answer_mode_label: "As of 2026-04-19 12:00 UTC",
          is_historical: true,
          matched_event_count: 1,
        })}
      />,
    );
    const chip = screen.getByTestId("time-context-chip");
    expect(chip).toHaveAttribute("data-variant", "as_of");
    expect(chip).toHaveTextContent("As of 2026-04-19 12:00 UTC");
  });

  it("renders a delta chip with the matched count", () => {
    render(
      <TimeContextChip
        context={timeContext({
          kind: "delta",
          coverage: "delta",
          label: "what changed",
          answer_mode_label: "Delta — what changed",
          matched_event_count: 2,
        })}
      />,
    );
    const chip = screen.getByTestId("time-context-chip");
    expect(chip).toHaveAttribute("data-variant", "delta");
    expect(chip).toHaveTextContent("Delta");
    expect(chip).toHaveTextContent("2 signals");
  });

  it("renders a no_match chip without a count", () => {
    render(
      <TimeContextChip
        context={timeContext({
          kind: "since",
          coverage: "no_match",
          label: "last 30 minutes",
          answer_mode_label: "Last 30 minutes",
          matched_event_count: 0,
        })}
      />,
    );
    const chip = screen.getByTestId("time-context-chip");
    expect(chip).toHaveAttribute("data-variant", "no_match");
    expect(chip).toHaveTextContent("returned no signals");
  });
});

// ---- CompareSummaryCard -------------------------------------------------------

function compareSummary(
  partial: Partial<AgentCompareSummary> & Pick<AgentCompareSummary, "requested">,
): AgentCompareSummary {
  return {
    collapsed: false,
    mode: "vs",
    raw_phrase: " vs ",
    targets: [],
    headline: null,
    ...partial,
  };
}

describe("CompareSummaryCard", () => {
  it("renders nothing when compare was not requested", () => {
    const { container } = render(<CompareSummaryCard summary={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders both legs of a resolved compare", () => {
    render(
      <CompareSummaryCard
        summary={compareSummary({
          requested: true,
          collapsed: false,
          headline: "Japan vs Korea",
          targets: [
            {
              raw: "Japan",
              kind: "country",
              canonical_id: "country:JPN",
              label: "Japan",
              country_code: "JPN",
              confidence: 0.9,
              resolution: "exact",
              event_ids: ["jp-1", "jp-2"],
              counts_by_category: { weather: 1, currency: 1 },
              severity_distribution: { elevated: 2 },
              freshness_minutes: 12,
              watch_score: 0.62,
              watch_label: "elevated",
            },
            {
              raw: "Korea",
              kind: "country",
              canonical_id: "country:KOR",
              label: "South Korea",
              country_code: "KOR",
              confidence: 0.85,
              resolution: "alias",
              event_ids: ["kr-1"],
              counts_by_category: { news: 1 },
              severity_distribution: { watch: 1 },
              freshness_minutes: 24,
              watch_score: 0.48,
              watch_label: "watch",
            },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("compare-summary-card")).toBeInTheDocument();
    expect(screen.getByText("Japan vs Korea")).toBeInTheDocument();
    const rows = screen.getAllByTestId("compare-target-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-resolution", "exact");
    expect(rows[1]).toHaveAttribute("data-resolution", "alias");
    expect(screen.queryByTestId("compare-collapsed-badge")).toBeNull();
  });

  it("shows a partial-resolution badge when compare is collapsed", () => {
    render(
      <CompareSummaryCard
        summary={compareSummary({
          requested: true,
          collapsed: true,
          targets: [
            {
              raw: "zzz",
              kind: "unknown",
              canonical_id: null,
              label: "zzz",
              country_code: null,
              confidence: 0,
              resolution: "none",
              event_ids: [],
              counts_by_category: {},
              severity_distribution: {},
              freshness_minutes: null,
              watch_score: null,
              watch_label: null,
            },
            {
              raw: "Japan",
              kind: "country",
              canonical_id: "country:JPN",
              label: "Japan",
              country_code: "JPN",
              confidence: 0.9,
              resolution: "exact",
              event_ids: ["jp-1"],
              counts_by_category: {},
              severity_distribution: {},
              freshness_minutes: null,
              watch_score: null,
              watch_label: null,
            },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("compare-collapsed-badge")).toBeInTheDocument();
    expect(screen.getByText(/Only one leg matched/)).toBeInTheDocument();
  });
});

// ---- ResolvedEntitiesBadges ---------------------------------------------------

describe("ResolvedEntitiesBadges", () => {
  it("renders nothing when no place was resolved", () => {
    const { container } = render(
      <ResolvedEntitiesBadges
        response={{
          scope_used: "global",
          scope_confidence: 0,
          resolved_place: null,
          fallback_notice: null,
        } as Pick<
          AgentResponse,
          "scope_used" | "scope_confidence" | "resolved_place" | "fallback_notice"
        >}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the resolved name with scope + confidence chips", () => {
    render(
      <ResolvedEntitiesBadges
        response={{
          scope_used: "exact_place",
          scope_confidence: 0.92,
          resolved_place: {
            query: "Tokyo",
            place_id: "city:tokyo",
            name: "Tokyo",
            type: "city",
            country_code: "JPN",
            country_name: "Japan",
            parent_id: null,
            parent_name: null,
            latitude: 35.7,
            longitude: 139.7,
            bbox: null,
            aliases: [],
            tags: [],
            fallback_level: "exact",
            is_fallback: false,
            confidence: 0.92,
            macro_context: null,
            source: "place_resolver",
          },
          fallback_notice: null,
        }}
      />,
    );
    const badges = screen.getByTestId("resolved-entities-badges");
    expect(badges).toHaveTextContent("Tokyo");
    expect(badges).toHaveTextContent("Exact place");
    expect(badges).toHaveTextContent("92% confidence");
    expect(
      screen.queryByTestId("resolved-entities-fallback-badge"),
    ).toBeNull();
  });

  it("surfaces the fallback badge when a fallback notice is present", () => {
    render(
      <ResolvedEntitiesBadges
        response={{
          scope_used: "country",
          scope_confidence: 0.55,
          resolved_place: {
            query: "Tokyo",
            place_id: "country:JPN",
            name: "Japan",
            type: "country",
            country_code: "JPN",
            country_name: "Japan",
            parent_id: null,
            parent_name: null,
            latitude: null,
            longitude: null,
            bbox: null,
            aliases: [],
            tags: [],
            fallback_level: "parent_country",
            is_fallback: true,
            confidence: 0.55,
            macro_context: null,
            source: "place_resolver",
          },
          fallback_notice: "Showing country-level signals.",
        }}
      />,
    );
    expect(
      screen.getByTestId("resolved-entities-fallback-badge"),
    ).toBeInTheDocument();
  });
});

// ---- CaveatList ---------------------------------------------------------------

describe("CaveatList", () => {
  it("renders nothing when there are no caveats", () => {
    const { container } = render(<CaveatList caveats={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a list when caveats are present", () => {
    render(
      <CaveatList
        caveats={[
          "Compare resolution was partial.",
          "No primary-scope events fell in the last 30 minutes window.",
        ]}
      />,
    );
    const list = screen.getByTestId("caveat-list");
    expect(list).toBeInTheDocument();
    const items = list.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Compare resolution was partial.");
  });
});
