"""Flight adapter scaffold.

Follows the :class:`SignalAdapter` contract so Phase 12 can plug in a real
ADS-B / OpenSky integration without refactoring the ingest pipeline. Today it
emits a deterministic placeholder set so dependent UI (markers, filters,
search) can be developed against a realistic shape.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Sequence

from app.intelligence.adapters.base import SignalAdapter
from app.intelligence.schemas import (
    EventEntity,
    Place,
    SignalEvent,
    SourceRef,
)


class FlightAdapter(SignalAdapter):
    adapter_id = "flights.scaffold"
    category = "flights"
    domain = "flight"
    poll_interval_seconds = 180

    async def fetch(self) -> dict[str, Any]:
        return {
            "flights": [
                {
                    "callsign": "QTR204",
                    "origin_country": "QAT",
                    "destination_country": "KEN",
                    "latitude": 19.0,
                    "longitude": 42.0,
                    "delay_minutes": 0,
                },
                {
                    "callsign": "SIA318",
                    "origin_country": "SGP",
                    "destination_country": "JPN",
                    "latitude": 20.0,
                    "longitude": 121.0,
                    "delay_minutes": 22,
                },
            ],
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }

    def validate(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict) or not isinstance(raw.get("flights"), list):
            raise ValueError("flight adapter expected {flights: []}")
        return raw

    def normalize(self, validated: dict[str, Any]) -> Sequence[SignalEvent]:
        now = datetime.now(timezone.utc)
        events: list[SignalEvent] = []
        for item in validated["flights"]:
            callsign = str(item.get("callsign") or "").strip()
            if not callsign:
                continue
            delay = int(item.get("delay_minutes") or 0)
            severity_score = min(0.9, delay / 60.0) if delay > 0 else 0.2
            severity = "elevated" if delay >= 45 else "watch" if delay >= 20 else "info"

            events.append(
                SignalEvent(
                    id=f"fl-{callsign.lower()}",
                    dedupe_key=f"flights|{callsign}",
                    type="flights",
                    sub_type="route-delay" if delay else "route",
                    title=f"{callsign}: {delay} min delay" if delay else f"{callsign} en route",
                    summary=(
                        f"{callsign} en route from {item.get('origin_country')} "
                        f"to {item.get('destination_country')}; delay {delay} min."
                    ),
                    severity=severity,
                    severity_score=severity_score,
                    confidence=0.5,
                    place=Place(
                        latitude=float(item.get("latitude") or 0.0),
                        longitude=float(item.get("longitude") or 0.0),
                        country_code=str(item.get("origin_country") or None),
                    ),
                    ingested_at=now,
                    source_timestamp=now,
                    sources=[
                        SourceRef(
                            adapter="flights.scaffold",
                            provider="scaffold",
                            provider_event_id=callsign,
                            retrieved_at=now,
                            reliability=0.3,
                        )
                    ],
                    tags=["flights", "scaffold"],
                    entities=[
                        EventEntity(
                            entity_id=f"flight:{callsign}",
                            entity_type="route",
                            name=callsign,
                        )
                    ],
                    properties={"delay_minutes": delay},
                )
            )
        return events
