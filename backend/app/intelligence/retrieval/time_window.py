"""Deterministic time-window parser for investigation queries.

Phase 18A.1 fixes the "time / historical retrieval" gap. The agent and
search services already accept ``since`` / ``until`` filters via
:class:`EventQuery`; what was missing was a *parser* that turns analyst
language ("last 24h", "since yesterday", "as of 2026-04-19", "what
changed") into a typed window the orchestrator can route on.

The parser is intentionally rule-based and side-effect free:

* obvious patterns resolve deterministically (``last 7d``, ``past 3 hours``,
  ``since yesterday``, ``today``, ``this week``, ``last month``)
* ``"as of <date>"`` and ``"as of <YYYY-MM-DD HH:MM>"`` anchor a snapshot
* ``"what changed"`` / ``"since the last cycle"`` produces a ``delta`` window
* an unrecognised query falls back to ``kind="live"`` — never raises

The output is a frozen dataclass so downstream workers can pass it around
as plain data.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Literal


TimeWindowKind = Literal["live", "since", "between", "as_of", "delta"]

# Phase 18C — analyst-facing semantic name. ``kind`` is the structural
# shape (since / between / as_of / delta / live); ``semantic_kind`` is
# what the user actually said. Compare-engine logic dispatches off the
# semantic kind so ``"oil yesterday vs today"`` can cleanly produce two
# scoped queries with no string parsing further downstream.
TimeWindowSemanticKind = Literal[
    "live",
    "today",
    "yesterday",
    "last_24h",
    "last_48h",
    "last_72h",
    "last_week",
    "last_month",
    "this_week",
    "this_month",
    "trend",
    "snapshot",
    "delta",
    "custom_relative",
    "custom_between",
    "as_of",
]


@dataclass(frozen=True, slots=True)
class TimeWindow:
    """Resolved time window for a query.

    * ``kind="live"``      — no temporal restriction; current snapshot
    * ``kind="since"``     — open-ended ``[since, anchor]`` window
    * ``kind="between"``   — bounded ``[since, until]`` window
    * ``kind="as_of"``     — point-in-time snapshot (``until`` set)
    * ``kind="delta"``     — "what changed since baseline" (windowed delta)

    ``semantic_kind`` mirrors what the analyst actually said (today /
    yesterday / last_week / trend / ...). Downstream compare and scope
    logic switch on this rather than re-parsing free text.
    """

    kind: TimeWindowKind
    label: str
    since: datetime | None
    until: datetime | None
    anchor: datetime
    is_historical: bool
    raw_phrase: str | None
    semantic_kind: TimeWindowSemanticKind = "live"

    @property
    def is_live(self) -> bool:
        return self.kind == "live"

    @property
    def is_delta(self) -> bool:
        return self.kind == "delta"

    @property
    def is_trend(self) -> bool:
        return self.semantic_kind == "trend"


# ----------------------------------------------------------------------------
# Public API
# ----------------------------------------------------------------------------


def parse_time_window(query: str, *, now: datetime | None = None) -> TimeWindow:
    """Parse ``query`` into a :class:`TimeWindow`.

    The function never raises — an unrecognised query yields a ``live``
    window so callers can chain unconditionally.
    """

    anchor = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    text = (query or "").lower().strip()
    if not text:
        return _live(anchor)

    for parser in (
        _try_trend_phrase,
        _try_anchor_phrase,
        _try_as_of,
        _try_relative_quantity,
        _try_named_relative,
        _try_calendar_phrase,
        _try_delta_phrase,
    ):
        result = parser(text, anchor)
        if result is not None:
            return result

    return _live(anchor)


_TREND_RE = re.compile(
    r"\btrend(?:ing|s)?\s+(?:in|for|of)?\b|\b(?:7|30)[- ]?day\s+trend\b",
    re.IGNORECASE,
)


def _try_trend_phrase(text: str, anchor: datetime) -> TimeWindow | None:
    """Phase 18C — ``"trend in <subject>"`` resolves to a 7-day window.

    The literal phrase is preserved on ``raw_phrase`` so the strip-hints
    pass in :mod:`query_planner` can remove it from the primary subject.
    """

    match = _TREND_RE.search(text)
    if not match:
        return None
    span = timedelta(days=30) if "30" in match.group(0) else timedelta(days=7)
    label = "30-day trend" if span.days == 30 else "7-day trend"
    return TimeWindow(
        kind="since",
        label=label,
        since=anchor - span,
        until=anchor,
        anchor=anchor,
        is_historical=False,
        raw_phrase=match.group(0).strip(),
        semantic_kind="trend",
    )


# ----------------------------------------------------------------------------
# Parsers — each returns ``None`` when not applicable, never raises.
# ----------------------------------------------------------------------------


_AT_THIS_TIME_LAST_WEEK_TOP_RE = re.compile(r"\bat\s+this\s+time\s+last\s+week\b")


def _try_anchor_phrase(text: str, anchor: datetime) -> TimeWindow | None:
    """High-priority anchor phrases that must beat the named-relative table.

    "at this time last week" overlaps with the more general "last week"
    pattern; without this check the parser would resolve it to a 7-day
    sliding window instead of a point-in-time snapshot.
    """

    match = _AT_THIS_TIME_LAST_WEEK_TOP_RE.search(text)
    if not match:
        return None
    target = anchor - timedelta(days=7)
    return TimeWindow(
        kind="as_of",
        label="at this time last week",
        since=None,
        until=target,
        anchor=anchor,
        is_historical=True,
        raw_phrase=match.group(0),
        semantic_kind="snapshot",
    )


_AS_OF_DATE_RE = re.compile(
    r"\bas\s+of\s+"
    r"(?P<date>\d{4}-\d{1,2}-\d{1,2})"
    r"(?:[ tT](?P<time>\d{1,2}:\d{2}(?::\d{2})?))?",
)


def _try_as_of(text: str, anchor: datetime) -> TimeWindow | None:
    match = _AS_OF_DATE_RE.search(text)
    if not match:
        return None
    try:
        target_date = date.fromisoformat(match.group("date"))
    except ValueError:
        return None
    raw_time = match.group("time")
    if raw_time:
        try:
            target_time = time.fromisoformat(raw_time)
        except ValueError:
            target_time = time(0, 0)
    else:
        target_time = time(23, 59, 59)
    until = datetime.combine(target_date, target_time, tzinfo=timezone.utc)
    label = f"as of {until.strftime('%Y-%m-%d %H:%M UTC')}"
    return TimeWindow(
        kind="as_of",
        label=label,
        since=None,
        until=until,
        anchor=anchor,
        is_historical=until < anchor,
        raw_phrase=match.group(0),
        semantic_kind="as_of",
    )


_RELATIVE_QUANTITY_RE = re.compile(
    r"\b(?:last|past|previous)\s+"
    r"(?P<count>\d{1,3})\s*"
    r"(?P<unit>m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|month|months)\b",
)

_RELATIVE_QUANTITY_SHORT_RE = re.compile(
    r"\b(?:last|past)\s+(?P<count>\d{1,3})(?P<unit>m|h|d|w)\b",
)


_UNIT_TO_SECONDS: dict[str, int] = {
    # minutes
    "m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60,
    # hours
    "h": 3600, "hr": 3600, "hrs": 3600, "hour": 3600, "hours": 3600,
    # days
    "d": 86_400, "day": 86_400, "days": 86_400,
    # weeks
    "w": 604_800, "wk": 604_800, "wks": 604_800, "week": 604_800, "weeks": 604_800,
    # months — treated as 30d for windowing; honest enough at this layer
    "mo": 2_592_000, "month": 2_592_000, "months": 2_592_000,
}


def _try_relative_quantity(text: str, anchor: datetime) -> TimeWindow | None:
    match = _RELATIVE_QUANTITY_RE.search(text) or _RELATIVE_QUANTITY_SHORT_RE.search(text)
    if not match:
        return None
    count = int(match.group("count"))
    unit = match.group("unit").lower()
    seconds = _UNIT_TO_SECONDS.get(unit)
    if seconds is None or count <= 0:
        return None
    delta = timedelta(seconds=seconds * count)
    since = anchor - delta
    label = _humanize_relative(count, unit)
    return TimeWindow(
        kind="since",
        label=f"last {label}",
        since=since,
        until=anchor,
        anchor=anchor,
        is_historical=False,
        raw_phrase=match.group(0),
        semantic_kind="custom_relative",
    )


_NAMED_RELATIVE_PATTERNS: tuple[
    tuple[re.Pattern[str], str, timedelta, "TimeWindowSemanticKind"], ...
] = (
    (re.compile(r"\b(?:in\s+the\s+)?last\s+24\s*h(?:ours?)?\b"), "last 24h", timedelta(hours=24), "last_24h"),
    (re.compile(r"\b(?:in\s+the\s+)?last\s+48\s*h(?:ours?)?\b"), "last 48h", timedelta(hours=48), "last_48h"),
    (re.compile(r"\b(?:in\s+the\s+)?last\s+72\s*h(?:ours?)?\b"), "last 72h", timedelta(hours=72), "last_72h"),
    (re.compile(r"\b(?:in\s+the\s+)?last\s+hour\b"), "last hour", timedelta(hours=1), "custom_relative"),
    (re.compile(r"\b(?:in\s+the\s+)?last\s+day\b"), "last day", timedelta(days=1), "last_24h"),
    (re.compile(r"\b(?:in\s+the\s+)?last\s+week\b"), "last week", timedelta(days=7), "last_week"),
    (re.compile(r"\b(?:in\s+the\s+)?last\s+month\b"), "last month", timedelta(days=30), "last_month"),
    (re.compile(r"\bsince\s+yesterday\b"), "since yesterday", timedelta(days=1), "last_24h"),
    (re.compile(r"\bsince\s+last\s+week\b"), "since last week", timedelta(days=7), "last_week"),
    (re.compile(r"\bsince\s+last\s+month\b"), "since last month", timedelta(days=30), "last_month"),
    (re.compile(r"\bovernight\b"), "overnight", timedelta(hours=14), "custom_relative"),
)


def _try_named_relative(text: str, anchor: datetime) -> TimeWindow | None:
    for pattern, label, delta, semantic in _NAMED_RELATIVE_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        return TimeWindow(
            kind="since",
            label=label,
            since=anchor - delta,
            until=anchor,
            anchor=anchor,
            is_historical=False,
            raw_phrase=match.group(0),
            semantic_kind=semantic,
        )
    return None


_TODAY_RE = re.compile(r"\btoday\b")
_YESTERDAY_RE = re.compile(r"\byesterday\b")
_THIS_WEEK_RE = re.compile(r"\bthis\s+week\b")
_THIS_MONTH_RE = re.compile(r"\bthis\s+month\b")
_AT_THIS_TIME_LAST_WEEK_RE = re.compile(r"\bat\s+this\s+time\s+last\s+week\b")


def _try_calendar_phrase(text: str, anchor: datetime) -> TimeWindow | None:
    if _AT_THIS_TIME_LAST_WEEK_RE.search(text):
        target = anchor - timedelta(days=7)
        return TimeWindow(
            kind="as_of",
            label="at this time last week",
            since=None,
            until=target,
            anchor=anchor,
            is_historical=True,
            raw_phrase="at this time last week",
            semantic_kind="snapshot",
        )
    if _TODAY_RE.search(text):
        start = datetime.combine(anchor.date(), time(0, 0), tzinfo=timezone.utc)
        return TimeWindow(
            kind="between",
            label="today",
            since=start,
            until=anchor,
            anchor=anchor,
            is_historical=False,
            raw_phrase="today",
            semantic_kind="today",
        )
    if _YESTERDAY_RE.search(text):
        yesterday = anchor.date() - timedelta(days=1)
        start = datetime.combine(yesterday, time(0, 0), tzinfo=timezone.utc)
        end = datetime.combine(yesterday, time(23, 59, 59), tzinfo=timezone.utc)
        return TimeWindow(
            kind="between",
            label="yesterday",
            since=start,
            until=end,
            anchor=anchor,
            is_historical=True,
            raw_phrase="yesterday",
            semantic_kind="yesterday",
        )
    if _THIS_WEEK_RE.search(text):
        start_date = anchor.date() - timedelta(days=anchor.weekday())
        start = datetime.combine(start_date, time(0, 0), tzinfo=timezone.utc)
        return TimeWindow(
            kind="between",
            label="this week",
            since=start,
            until=anchor,
            anchor=anchor,
            is_historical=False,
            raw_phrase="this week",
            semantic_kind="this_week",
        )
    if _THIS_MONTH_RE.search(text):
        start = datetime.combine(
            anchor.date().replace(day=1), time(0, 0), tzinfo=timezone.utc
        )
        return TimeWindow(
            kind="between",
            label="this month",
            since=start,
            until=anchor,
            anchor=anchor,
            is_historical=False,
            raw_phrase="this month",
            semantic_kind="this_month",
        )
    return None


_DELTA_PATTERNS: tuple[tuple[re.Pattern[str], str, timedelta], ...] = (
    (re.compile(r"\bwhat\s+changed\b"), "what changed", timedelta(hours=24)),
    (re.compile(r"\bwhat\s+has\s+changed\b"), "what has changed", timedelta(hours=24)),
    (re.compile(r"\bsince\s+the\s+last\s+(?:cycle|snapshot|update)\b"), "since last cycle", timedelta(hours=6)),
    (re.compile(r"\brecent(?:ly)?\b"), "recent", timedelta(hours=24)),
    (re.compile(r"\bnew\s+signals?\b"), "new signals", timedelta(hours=12)),
    (re.compile(r"\blatest\b"), "latest", timedelta(hours=12)),
)


def _try_delta_phrase(text: str, anchor: datetime) -> TimeWindow | None:
    for pattern, label, delta in _DELTA_PATTERNS:
        match = pattern.search(text)
        if not match:
            continue
        return TimeWindow(
            kind="delta",
            label=label,
            since=anchor - delta,
            until=anchor,
            anchor=anchor,
            is_historical=False,
            raw_phrase=match.group(0),
            semantic_kind="delta",
        )
    return None


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------


def _live(anchor: datetime) -> TimeWindow:
    return TimeWindow(
        kind="live",
        label="live",
        since=None,
        until=None,
        anchor=anchor,
        is_historical=False,
        raw_phrase=None,
    )


def _humanize_relative(count: int, unit: str) -> str:
    seconds = _UNIT_TO_SECONDS.get(unit, 0)
    if seconds < 3600:
        plural = "minute" if count == 1 else "minutes"
        return f"{count} {plural}"
    if seconds < 86_400:
        plural = "hour" if count == 1 else "hours"
        return f"{count} {plural}"
    if seconds < 604_800:
        plural = "day" if count == 1 else "days"
        return f"{count} {plural}"
    if seconds < 2_592_000:
        plural = "week" if count == 1 else "weeks"
        return f"{count} {plural}"
    plural = "month" if count == 1 else "months"
    return f"{count} {plural}"


__all__ = [
    "TimeWindow",
    "TimeWindowKind",
    "TimeWindowSemanticKind",
    "parse_time_window",
]
