"""Disease adapter scaffold.

Phase-next will replace this with a HealthMap / WHO / ProMED backed flow.
Today it emits deterministic country-level outbreak placeholders so the UI,
scoring, and ingest pipeline can be exercised against a realistic shape
without person-level inference.
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


_SEED_OUTBREAKS: tuple[dict[str, Any], ...] = (
    {"country_code": "IND", "label": "Seasonal dengue caseload uptick", "intensity": 0.55},
    {"country_code": "BRA", "label": "Regional respiratory outbreak signal", "intensity": 0.45},
    {"country_code": "COD", "label": "Watch: filovirus case reports", "intensity": 0.7},
    {"country_code": "PHL", "label": "Cholera cluster flagged by public health bulletin", "intensity": 0.5},
)


class DiseaseAdapter(SignalAdapter):
    adapter_id = "disease.scaffold"
    category = "disease"
    domain = "disease"
    poll_interval_seconds = 1800

    async def fetch(self) -> dict[str, Any]:
        return {
            "outbreaks": list(_SEED_OUTBREAKS),
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }

    def validate(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict) or not isinstance(raw.get("outbreaks"), list):
            raise ValueError("disease adapter expected {outbreaks: []}")
        return raw

    def normalize(self, validated: dict[str, Any]) -> Sequence[SignalEvent]:
        now = datetime.now(timezone.utc)
        out: list[SignalEvent] = []
        for item in validated["outbreaks"]:
            country = lookup_by_alpha3(item.get("country_code"))
            if country is None:
                continue
            intensity = float(item.get("intensity") or 0.4)
            severity = (
                "critical"
                if intensity >= 0.75
                else "elevated"
                if intensity >= 0.55
                else "watch"
            )
            label = str(item.get("label") or f"Disease signal in {country.name}")
            out.append(
                SignalEvent(
                    id=f"ds-{country.code.lower()}-{int(intensity * 100)}",
                    dedupe_key=f"disease|{country.code}|{label}",
                    type="disease",
                    sub_type="outbreak-scaffold",
                    title=label,
                    summary=(
                        f"Scaffold disease signal for {country.name}. "
                        "Country-level only; no person-level inference."
                    ),
                    severity=severity,
                    severity_score=intensity,
                    confidence=0.4,
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
                            adapter="disease.scaffold",
                            provider="scaffold",
                            provider_event_id=f"{country.code}-{label}",
                            retrieved_at=now,
                            reliability=0.3,
                        )
                    ],
                    tags=["disease", "scaffold", "country-level"],
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


__all__ = ["DiseaseAdapter"]
