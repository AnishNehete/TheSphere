"""Ingest service — the orchestrator for the live intelligence backbone.

Responsibilities:

* own the adapter lifecycle (poll intervals, retries, error isolation)
* deduplicate and merge canonical events across adapters
* persist events + per-country summaries into the repository
* expose a manual :meth:`run_once` entry point that the API / tests use to
  drive the pipeline without spinning up the full background scheduler

The service is decoupled from FastAPI — it takes a list of adapters, a
repository, and the two analysis services. :class:`IntelligenceRuntime`
in ``app.intelligence.runtime`` (wired from ``main.py``) owns one instance
for the lifetime of the process.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Sequence

from app.intelligence.adapters.base import AdapterHealth, AdapterResult, SignalAdapter
from app.intelligence.repositories.event_repository import EventRepository
from app.intelligence.schemas import CountrySignalSummary, SignalEvent
from app.intelligence.services.country_summary_service import CountrySummaryService
from app.intelligence.services.dedupe_service import DedupeService, DedupeStats


logger = logging.getLogger(__name__)


@dataclass(slots=True)
class IngestCycleResult:
    """One full poll -> dedupe -> persist -> summarize cycle."""

    started_at: datetime
    finished_at: datetime
    adapter_results: list[AdapterResult] = field(default_factory=list)
    raw_event_count: int = 0
    deduped_event_count: int = 0
    merged_count: int = 0
    summaries_written: int = 0
    errors: list[str] = field(default_factory=list)

    @property
    def duration_seconds(self) -> float:
        return max(0.0, (self.finished_at - self.started_at).total_seconds())

    def to_dict(self) -> dict[str, object]:
        return {
            "startedAt": self.started_at.isoformat(),
            "finishedAt": self.finished_at.isoformat(),
            "durationSeconds": round(self.duration_seconds, 3),
            "rawEventCount": self.raw_event_count,
            "dedupedEventCount": self.deduped_event_count,
            "mergedCount": self.merged_count,
            "summariesWritten": self.summaries_written,
            "errors": self.errors,
            "adapters": [r.adapter_id for r in self.adapter_results],
        }


@dataclass(slots=True)
class IngestState:
    """Running state kept between cycles for lightweight observability."""

    last_cycle: IngestCycleResult | None = None
    last_dedupe_stats: DedupeStats | None = None
    last_summaries: dict[str, CountrySignalSummary] = field(default_factory=dict)
    total_cycles: int = 0
    total_events_ingested: int = 0


class IngestService:
    """Drives adapters and keeps the repository warm."""

    def __init__(
        self,
        *,
        adapters: Sequence[SignalAdapter],
        repository: EventRepository,
        dedupe_service: DedupeService,
        summary_service: CountrySummaryService,
        stale_ttl: timedelta = timedelta(hours=6),
    ) -> None:
        self._adapters = list(adapters)
        self._repository = repository
        self._dedupe = dedupe_service
        self._summaries = summary_service
        self._stale_ttl = stale_ttl
        self._state = IngestState()
        self._background_task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self._cycle_lock = asyncio.Lock()

    @property
    def state(self) -> IngestState:
        return self._state

    @property
    def adapters(self) -> tuple[SignalAdapter, ...]:
        return tuple(self._adapters)

    async def adapter_health(self) -> list[AdapterHealth]:
        return [adapter.health for adapter in self._adapters]

    async def start_background(self, *, interval_seconds: float = 90.0) -> None:
        """Kick off the background poller. Safe to call once per process."""

        if self._background_task and not self._background_task.done():
            return
        self._stop_event.clear()
        self._background_task = asyncio.create_task(
            self._run_forever(interval_seconds),
            name="sphere.intelligence.ingest",
        )

    async def stop_background(self) -> None:
        self._stop_event.set()
        task = self._background_task
        if task is None:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        self._background_task = None

    async def _run_forever(self, interval_seconds: float) -> None:
        try:
            # run once right away so /health reflects real data quickly
            await self.run_once()
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("ingest: initial cycle failed: %s", exc)

        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=interval_seconds,
                )
                break  # stop_event set -> exit
            except asyncio.TimeoutError:
                try:
                    await self.run_once()
                except Exception as exc:  # pragma: no cover - defensive
                    logger.exception("ingest: cycle failed: %s", exc)

    async def run_once(self) -> IngestCycleResult:
        """Run a single synchronous ingest cycle end to end."""

        async with self._cycle_lock:
            started = datetime.now(timezone.utc)
            errors: list[str] = []

            adapter_results = await asyncio.gather(
                *(adapter.poll() for adapter in self._adapters),
                return_exceptions=True,
            )
            normalized: list[AdapterResult] = []
            raw_events: list[SignalEvent] = []
            for adapter, result in zip(self._adapters, adapter_results):
                if isinstance(result, Exception):
                    errors.append(f"{adapter.adapter_id}: {result!r}")
                    continue
                normalized.append(result)
                if result.ok:
                    raw_events.extend(result.events)
                elif result.error:
                    errors.append(f"{adapter.adapter_id}: {result.error}")

            deduped, dedupe_stats = self._dedupe.dedupe(raw_events)
            self._state.last_dedupe_stats = dedupe_stats

            if deduped:
                await self._repository.upsert_many(deduped)

            summaries_written = await self._rebuild_summaries(now=started)

            pruned = 0
            try:
                pruned = await self._repository.prune_stale(self._stale_ttl)
            except Exception as exc:
                errors.append(f"prune_stale: {exc!r}")

            finished = datetime.now(timezone.utc)
            cycle = IngestCycleResult(
                started_at=started,
                finished_at=finished,
                adapter_results=normalized,
                raw_event_count=len(raw_events),
                deduped_event_count=len(deduped),
                merged_count=dedupe_stats.merged_count,
                summaries_written=summaries_written,
                errors=errors,
            )
            self._state.last_cycle = cycle
            self._state.total_cycles += 1
            self._state.total_events_ingested += len(deduped)
            logger.info(
                "ingest: cycle done raw=%s deduped=%s summaries=%s pruned=%s errors=%s",
                len(raw_events),
                len(deduped),
                summaries_written,
                pruned,
                len(errors),
            )
            return cycle

    async def _rebuild_summaries(self, *, now: datetime) -> int:
        """Recompute country summaries from whatever is currently in the repo."""

        events = await self._repository.latest(limit=2000)
        prior = dict(self._state.last_summaries)
        summaries = self._summaries.build_all(events, prior=prior, now=now)

        written = 0
        for summary in summaries:
            await self._repository.upsert_country_summary(summary)
            self._state.last_summaries[summary.country_code] = summary
            written += 1
        return written


__all__ = ["IngestService", "IngestCycleResult", "IngestState"]
