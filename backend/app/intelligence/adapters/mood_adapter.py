"""Mood / happiness adapter scaffold.

Keeps a stable, explainable country-level mood signal. Sphere deliberately
avoids person-level mental-health inference — this adapter is a country-level
aggregate only, driven by survey-style reference data (replaced in a later
phase by a real ingestion flow against e.g. the World Happiness Report feed).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Sequence

from app.intelligence.adapters.base import SignalAdapter
from app.intelligence.adapters.country_lookup import list_countries
from app.intelligence.schemas import (
    EventEntity,
    Place,
    SignalEvent,
    SourceRef,
)


_MOOD_SEEDS: dict[str, float] = {
    "FIN": 0.82, "DNK": 0.80, "NOR": 0.78, "SWE": 0.76, "NLD": 0.75,
    "CHE": 0.74, "NZL": 0.73, "CAN": 0.72, "AUS": 0.71, "GBR": 0.68,
    "USA": 0.66, "DEU": 0.65, "FRA": 0.63, "JPN": 0.62, "KOR": 0.58,
    "BRA": 0.55, "MEX": 0.54, "IND": 0.52, "CHN": 0.57, "ZAF": 0.45,
    "UKR": 0.40, "SYR": 0.32, "YEM": 0.30, "SDN": 0.34,
}


class MoodAdapter(SignalAdapter):
    adapter_id = "mood.scaffold"
    category = "mood"
    domain = "mood"
    poll_interval_seconds = 3600

    async def fetch(self) -> dict[str, Any]:
        return {
            "country_scores": [
                {"country_code": c.code, "score": _MOOD_SEEDS.get(c.code, 0.5)}
                for c in list_countries()
            ],
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }

    def validate(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict) or not isinstance(raw.get("country_scores"), list):
            raise ValueError("mood adapter expected {country_scores: []}")
        return raw

    def normalize(self, validated: dict[str, Any]) -> Sequence[SignalEvent]:
        now = datetime.now(timezone.utc)
        out: list[SignalEvent] = []
        for item in validated["country_scores"]:
            code = str(item.get("country_code") or "").upper()
            if not code:
                continue
            score = float(item.get("score") or 0.5)
            meta = next((c for c in list_countries() if c.code == code), None)
            if meta is None:
                continue
            severity = "info" if score >= 0.6 else "watch" if score >= 0.45 else "elevated"
            out.append(
                SignalEvent(
                    id=f"mood-{code.lower()}",
                    dedupe_key=f"mood|{code}",
                    type="mood",
                    sub_type="country-index",
                    title=f"Country mood index: {meta.name}",
                    summary=(
                        f"Aggregate mood index for {meta.name}: {score:.2f}. "
                        "Country-level only; no person-level inference."
                    ),
                    severity=severity,
                    severity_score=1.0 - score,
                    confidence=0.5,
                    place=Place(
                        latitude=meta.latitude,
                        longitude=meta.longitude,
                        country_code=meta.code,
                        country_name=meta.name,
                        region=meta.region,
                    ),
                    ingested_at=now,
                    source_timestamp=now,
                    sources=[
                        SourceRef(
                            adapter="mood.scaffold",
                            provider="scaffold",
                            provider_event_id=code,
                            retrieved_at=now,
                            reliability=0.4,
                        )
                    ],
                    tags=["mood", "scaffold", "country-level"],
                    entities=[
                        EventEntity(
                            entity_id=f"country:{code}",
                            entity_type="country",
                            name=meta.name,
                            country_code=meta.code,
                            score=1.0,
                        )
                    ],
                    properties={"index": score},
                )
            )
        return out
