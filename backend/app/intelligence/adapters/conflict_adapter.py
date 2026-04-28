"""Conflict adapter scaffold.

Phase 12 should replace this with an ACLED / GDELT-GKG-backed integration.
Today it emits a deterministic placeholder so the ingest + UI layers can be
developed against a realistic shape without standing up ACLED credentials.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Sequence

from app.intelligence.adapters.base import SignalAdapter
from app.intelligence.adapters.country_lookup import lookup_by_alpha3
from app.intelligence.schemas import (
    EventEntity,
    Place,
    SignalEvent,
    SourceRef,
)


class ConflictAdapter(SignalAdapter):
    adapter_id = "conflict.scaffold"
    category = "conflict"
    domain = "conflict"
    poll_interval_seconds = 600

    async def fetch(self) -> dict[str, Any]:
        return {
            "incidents": [
                {
                    "country_code": "UKR",
                    "title": "Reported air-defense activity near Kharkiv",
                    "intensity": 0.7,
                },
                {
                    "country_code": "SDN",
                    "title": "Clashes reported in western Darfur corridor",
                    "intensity": 0.65,
                },
                {
                    "country_code": "YEM",
                    "title": "Vessel incident reported south of Bab el-Mandeb",
                    "intensity": 0.75,
                },
            ],
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }

    def validate(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict) or not isinstance(raw.get("incidents"), list):
            raise ValueError("conflict adapter expected {incidents: []}")
        return raw

    def normalize(self, validated: dict[str, Any]) -> Sequence[SignalEvent]:
        now = datetime.now(timezone.utc)
        out: list[SignalEvent] = []
        for incident in validated["incidents"]:
            country = lookup_by_alpha3(incident.get("country_code"))
            if country is None:
                continue
            intensity = float(incident.get("intensity") or 0.5)
            severity = "critical" if intensity >= 0.75 else "elevated" if intensity >= 0.55 else "watch"
            title = str(incident.get("title") or f"Incident reported in {country.name}")
            out.append(
                SignalEvent(
                    id=f"cf-{country.code.lower()}-{int(intensity * 100)}",
                    dedupe_key=f"conflict|{country.code}|{title}",
                    type="conflict",
                    sub_type="incident",
                    title=title,
                    summary=f"Scaffold conflict signal for {country.name}.",
                    severity=severity,
                    severity_score=intensity,
                    confidence=0.45,
                    place=Place(
                        latitude=country.latitude,
                        longitude=country.longitude,
                        country_code=country.code,
                        country_name=country.name,
                        region=country.region,
                    ),
                    ingested_at=now,
                    source_timestamp=now,
                    sources=[
                        SourceRef(
                            adapter="conflict.scaffold",
                            provider="scaffold",
                            provider_event_id=f"{country.code}-{title}",
                            retrieved_at=now,
                            reliability=0.3,
                        )
                    ],
                    tags=["conflict", "scaffold"],
                    entities=[
                        EventEntity(
                            entity_id=f"country:{country.code}",
                            entity_type="country",
                            name=country.name,
                            country_code=country.code,
                            score=1.0,
                        )
                    ],
                    properties={"intensity": intensity},
                )
            )
        return out
