"""Replay cursor — thread `as_of` through the portfolio intelligence layer.

A ReplayCursor is a lightweight value object that callers pass to services.
Services use it to pick the right candle window, filter the event corpus
(`ingested_at <= as_of`), and decide whether to mutate live-only state
such as the risk-score history deque.

Tilt discipline: we report bullish_tilt / bearish_tilt / uncertainty ONLY.
We NEVER emit buy / sell / recommendation / target price language.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass(frozen=True, slots=True)
class ReplayCursor:
    """Immutable cursor that carries `as_of` through all service calls.

    ``is_live`` is ``True`` when ``as_of`` is ``None`` (the default —
    no replay intent). ``is_live`` is ``False`` for historical snapshots,
    and any live-only mutations (e.g., appending to the risk-score rolling
    baseline) must check this flag before writing.
    """

    as_of: datetime | None = None

    @property
    def is_live(self) -> bool:
        """Return True when this cursor represents the live (real-time) state."""
        return self.as_of is None

    def truncate(self, ts: datetime | None) -> bool:
        """Return True if an event with ``ingested_at == ts`` should be excluded.

        An event is excluded when its timestamp is *after* the cursor's
        ``as_of`` bound. When the cursor is live (``as_of is None``) nothing
        is ever excluded.
        """
        if self.as_of is None or ts is None:
            return False
        return ts > self.as_of


def parse_as_of(value: str | None) -> datetime | None:
    """Parse an ISO-8601 string into a tz-aware UTC datetime.

    Returns ``None`` for empty / ``None`` input. Raises ``ValueError`` for
    malformed strings — callers that surface this over HTTP should catch
    ``ValueError`` and raise ``HTTPException(422)``.
    """
    if value is None or value == "":
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def cursor_from(value: str | datetime | None) -> ReplayCursor:
    """Construct a :class:`ReplayCursor` from a string, datetime, or None.

    Accepts the same inputs that routes and service method signatures
    can receive without requiring callers to import ``parse_as_of`` directly.
    """
    if value is None:
        return ReplayCursor(as_of=None)
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return ReplayCursor(as_of=value.astimezone(timezone.utc))
    return ReplayCursor(as_of=parse_as_of(value))


__all__ = ["ReplayCursor", "cursor_from", "parse_as_of"]
