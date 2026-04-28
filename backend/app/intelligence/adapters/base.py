"""Adapter interface shared by every live intelligence source.

Each adapter is responsible for one provider / one signal category. The
:class:`SignalAdapter` protocol keeps the surface area tiny so new sources
(flights, conflict, mood, economic, agent-derived) plug into the orchestrator
without leaking provider-specific shapes.

Contract:
* :meth:`fetch` performs transport-level retrieval with retries
* :meth:`validate` runs lightweight schema assertions on the raw payload
* :meth:`normalize` converts provider schemas into canonical :class:`SignalEvent`s
* :meth:`health_check` reports adapter liveness for observability
* :attr:`provider_config` surfaces enable/provider/base_url/key state for
  the ``/api/intelligence/health`` route (secrets never leak)
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Sequence

from app.intelligence.schemas import SignalCategory, SignalEvent
from app.settings import ProviderConfig


@dataclass(slots=True)
class AdapterHealth:
    """Lightweight per-adapter health snapshot."""

    adapter_id: str
    category: SignalCategory
    last_success_at: datetime | None = None
    last_failure_at: datetime | None = None
    last_error: str | None = None
    consecutive_failures: int = 0
    last_item_count: int = 0
    stale: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "adapter": self.adapter_id,
            "category": self.category,
            "lastSuccessAt": self.last_success_at.isoformat() if self.last_success_at else None,
            "lastFailureAt": self.last_failure_at.isoformat() if self.last_failure_at else None,
            "lastError": self.last_error,
            "consecutiveFailures": self.consecutive_failures,
            "lastItemCount": self.last_item_count,
            "stale": self.stale,
        }


@dataclass(slots=True)
class AdapterResult:
    """Return envelope for a single :meth:`SignalAdapter.poll` cycle."""

    adapter_id: str
    category: SignalCategory
    events: list[SignalEvent] = field(default_factory=list)
    ok: bool = True
    error: str | None = None
    fetched_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class SignalAdapter(abc.ABC):
    """Abstract base class for every live intelligence source."""

    adapter_id: str
    category: SignalCategory
    domain: str = ""
    poll_interval_seconds: int = 120
    max_retries: int = 2

    def __init__(self, *, config: ProviderConfig | None = None) -> None:
        self._health = AdapterHealth(adapter_id=self.adapter_id, category=self.category)
        self._config = config

    @property
    def health(self) -> AdapterHealth:
        return self._health

    @property
    def provider_config(self) -> ProviderConfig | None:
        return self._config

    @property
    def enabled(self) -> bool:
        """Adapter is enabled for this process (default True when no config)."""

        if self._config is None:
            return True
        return self._config.enabled

    @property
    def is_configured(self) -> bool:
        """Adapter has the minimum it needs to reach its provider.

        Default: ``enabled`` + a provider name is set. Adapters that require
        an API key can override by inspecting the config in :meth:`fetch`.
        """

        if self._config is None:
            return True
        return self._config.is_configured

    @abc.abstractmethod
    async def fetch(self) -> Any:
        """Retrieve the raw provider payload. Should raise on transport failure."""

    @abc.abstractmethod
    def validate(self, raw: Any) -> Any:
        """Validate the raw payload. Return the validated shape or raise."""

    @abc.abstractmethod
    def normalize(self, validated: Any) -> Sequence[SignalEvent]:
        """Convert the validated payload into canonical :class:`SignalEvent`s."""

    async def poll(self) -> AdapterResult:
        """Run a full fetch -> validate -> normalize cycle with error isolation."""

        if self._config is not None and not self._config.enabled:
            # Explicitly disabled: don't touch the network; don't mutate health.
            return AdapterResult(
                adapter_id=self.adapter_id,
                category=self.category,
                events=[],
                ok=True,
                fetched_at=datetime.now(timezone.utc),
            )

        attempt = 0
        last_exc: Exception | None = None
        while attempt <= self.max_retries:
            try:
                raw = await self.fetch()
                validated = self.validate(raw)
                events = list(self.normalize(validated))
                now = datetime.now(timezone.utc)
                self._health.last_success_at = now
                self._health.last_failure_at = None
                self._health.last_error = None
                self._health.consecutive_failures = 0
                self._health.last_item_count = len(events)
                self._health.stale = False
                return AdapterResult(
                    adapter_id=self.adapter_id,
                    category=self.category,
                    events=events,
                    ok=True,
                    fetched_at=now,
                )
            except Exception as exc:  # adapter isolation: a bad source never crashes ingest
                last_exc = exc
                attempt += 1

        self._health.last_failure_at = datetime.now(timezone.utc)
        self._health.last_error = repr(last_exc) if last_exc else "unknown error"
        self._health.consecutive_failures += 1
        self._health.stale = True
        return AdapterResult(
            adapter_id=self.adapter_id,
            category=self.category,
            events=[],
            ok=False,
            error=self._health.last_error,
        )

    async def health_check(self) -> AdapterHealth:
        return self._health
