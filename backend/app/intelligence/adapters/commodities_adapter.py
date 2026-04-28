"""Commodities adapter scaffold.

Emits deterministic placeholder moves for a handful of benchmark commodities
so the ingest + UI layers can exercise the shape without an API key.
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


_SEED_COMMODITIES: tuple[dict[str, Any], ...] = (
    {"symbol": "CL", "name": "WTI Crude", "country_code": "USA", "change_pct": 1.2},
    {"symbol": "BZ", "name": "Brent Crude", "country_code": "GBR", "change_pct": 1.0},
    {"symbol": "GC", "name": "Gold", "country_code": "CHE", "change_pct": -0.4},
    {"symbol": "HG", "name": "Copper", "country_code": "CHL", "change_pct": 0.3},
)


class CommoditiesAdapter(SignalAdapter):
    adapter_id = "commodities.scaffold"
    category = "commodities"
    domain = "commodities"
    poll_interval_seconds = 900

    async def fetch(self) -> dict[str, Any]:
        return {
            "commodities": list(_SEED_COMMODITIES),
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }

    def validate(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict) or not isinstance(raw.get("commodities"), list):
            raise ValueError("commodities adapter expected {commodities: []}")
        return raw

    def normalize(self, validated: dict[str, Any]) -> Sequence[SignalEvent]:
        now = datetime.now(timezone.utc)
        out: list[SignalEvent] = []
        for item in validated["commodities"]:
            symbol = str(item.get("symbol") or "").strip()
            if not symbol:
                continue
            name = str(item.get("name") or symbol)
            change_pct = float(item.get("change_pct") or 0.0)
            magnitude = min(abs(change_pct) / 3.0, 1.0)
            severity = (
                "critical"
                if magnitude >= 0.8
                else "elevated"
                if magnitude >= 0.5
                else "watch"
                if magnitude >= 0.25
                else "info"
            )
            direction = "up" if change_pct >= 0 else "down"
            country = lookup_by_alpha3(item.get("country_code"))
            out.append(
                SignalEvent(
                    id=f"cm-{symbol.lower()}",
                    dedupe_key=f"commodities|{symbol}",
                    type="commodities",
                    sub_type="benchmark-move",
                    title=f"{name} {direction} {change_pct:+.2f}%",
                    summary=f"Scaffold commodity signal: {name} {change_pct:+.2f}%.",
                    severity=severity,
                    severity_score=magnitude,
                    confidence=0.4,
                    place=Place(
                        latitude=country.latitude if country else None,
                        longitude=country.longitude if country else None,
                        country_code=country.code if country else None,
                        country_name=country.name if country else None,
                        region=country.region if country else None,
                    ),
                    ingested_at=now,
                    source_timestamp=now,
                    sources=[
                        SourceRef(
                            adapter="commodities.scaffold",
                            provider="scaffold",
                            provider_event_id=symbol,
                            retrieved_at=now,
                            reliability=0.3,
                        )
                    ],
                    tags=["commodities", "scaffold"],
                    entities=[
                        EventEntity(
                            entity_id=f"commodity:{symbol}",
                            entity_type="topic",
                            name=name,
                            country_code=country.code if country else None,
                        )
                    ],
                    properties={"change_pct": change_pct, "symbol": symbol},
                )
            )
        return out


__all__ = ["CommoditiesAdapter"]
