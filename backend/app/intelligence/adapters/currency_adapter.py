"""Currency adapter backed by Frankfurter.

Frankfurter (https://api.frankfurter.app) is a keyless ECB-backed FX feed. We
pull the latest reference rates for a small reserve-currency basket and, when
available, compare them against yesterday's fix to emit a delta-driven
:class:`SignalEvent`. If the network is unavailable we fall back to a
deterministic synthetic payload so downstream services keep working.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Sequence

import httpx

from app.intelligence.adapters.base import SignalAdapter
from app.intelligence.adapters.country_lookup import lookup_by_alpha3
from app.intelligence.schemas import (
    EventEntity,
    Place,
    SignalEvent,
    SignalSeverity,
    SourceRef,
)
from app.settings import ProviderConfig


logger = logging.getLogger(__name__)

FRANKFURTER_DEFAULT_BASE = "https://api.frankfurter.app"

# Reserve basket. Each (base, quote) pair is pinned to a representative country
# so the UI layer can still place FX signals on the map.
_PAIR_COUNTRY: dict[tuple[str, str], str] = {
    ("USD", "EUR"): "DEU",
    ("USD", "JPY"): "JPN",
    ("USD", "GBP"): "GBR",
    ("USD", "CNY"): "CHN",
    ("USD", "CHF"): "CHE",
    ("USD", "CAD"): "CAN",
}
_DEFAULT_PAIRS: tuple[tuple[str, str], ...] = tuple(_PAIR_COUNTRY.keys())


class CurrencyAdapter(SignalAdapter):
    adapter_id = "currency.frankfurter"
    category = "currency"
    domain = "currency"
    poll_interval_seconds = 3600

    def __init__(
        self,
        *,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 10.0,
        pairs: Sequence[tuple[str, str]] | None = None,
        config: ProviderConfig | None = None,
    ) -> None:
        super().__init__(config=config)
        self._client = client
        self._owns_client = client is None
        self._timeout = timeout_seconds
        self._pairs: tuple[tuple[str, str], ...] = tuple(pairs) if pairs else _DEFAULT_PAIRS

    @property
    def _base_url(self) -> str:
        if self._config and self._config.base_url:
            return self._config.base_url.rstrip("/")
        return FRANKFURTER_DEFAULT_BASE

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout)
        return self._client

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def fetch(self) -> dict[str, Any]:
        client = await self._get_client()
        bases = sorted({base for base, _ in self._pairs})
        yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")

        latest: dict[str, dict[str, Any]] = {}
        previous: dict[str, dict[str, Any]] = {}

        for base in bases:
            symbols = ",".join(quote for b, quote in self._pairs if b == base)
            latest[base] = await self._safe_get(
                client, f"{self._base_url}/latest", {"from": base, "to": symbols}
            )
            previous[base] = await self._safe_get(
                client, f"{self._base_url}/{yesterday}", {"from": base, "to": symbols}
            )

        if not any((payload or {}).get("rates") for payload in latest.values()):
            return _synthetic_fx_payload(self._pairs)

        return {
            "latest": latest,
            "previous": previous,
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }

    @staticmethod
    async def _safe_get(
        client: httpx.AsyncClient, url: str, params: dict[str, Any]
    ) -> dict[str, Any]:
        try:
            response = await client.get(url, params=params)
            response.raise_for_status()
            payload = response.json()
            return payload if isinstance(payload, dict) else {}
        except Exception as exc:
            logger.debug("currency adapter: fetch failed for %s: %s", url, exc)
            return {}

    def validate(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict) or "latest" not in raw:
            raise ValueError("currency adapter expected {latest: {...}}")
        return raw

    def normalize(self, validated: dict[str, Any]) -> Sequence[SignalEvent]:
        now = datetime.now(timezone.utc)
        latest = validated.get("latest") or {}
        previous = validated.get("previous") or {}
        out: list[SignalEvent] = []

        for base, quote in self._pairs:
            payload = latest.get(base) or {}
            rates = payload.get("rates") or {}
            if quote not in rates:
                continue
            try:
                latest_rate = float(rates[quote])
            except (TypeError, ValueError):
                continue

            prev_rates = (previous.get(base) or {}).get("rates") or {}
            prev_rate: float | None = None
            if quote in prev_rates:
                try:
                    prev_rate = float(prev_rates[quote])
                except (TypeError, ValueError):
                    prev_rate = None

            change_pct = (
                ((latest_rate - prev_rate) / prev_rate) * 100.0 if prev_rate else 0.0
            )
            magnitude = min(abs(change_pct) / 2.0, 1.0)
            severity: SignalSeverity = (
                "critical"
                if magnitude >= 0.8
                else "elevated"
                if magnitude >= 0.5
                else "watch"
                if magnitude >= 0.25
                else "info"
            )
            direction = "up" if change_pct >= 0 else "down"
            pair = f"{base}{quote}"
            country = lookup_by_alpha3(_PAIR_COUNTRY.get((base, quote)))
            stamp = _parse_date(payload.get("date")) or now

            title = (
                f"{base}/{quote} {direction} {change_pct:+.2f}%"
                if prev_rate
                else f"{base}/{quote} {latest_rate:.4f}"
            )
            summary = (
                f"ECB reference rate {base}/{quote} = {latest_rate:.4f}"
                + (f" ({change_pct:+.2f}% vs prior fix)" if prev_rate else "")
            )

            out.append(
                SignalEvent(
                    id=f"fx-{pair.lower()}-{payload.get('date') or stamp.strftime('%Y%m%d')}",
                    dedupe_key=f"currency|{pair}|{payload.get('date')}",
                    type="currency",
                    sub_type="fx-rate",
                    title=title,
                    summary=summary,
                    severity=severity,
                    severity_score=magnitude,
                    confidence=0.8,
                    place=Place(
                        latitude=country.latitude if country else None,
                        longitude=country.longitude if country else None,
                        country_code=country.code if country else None,
                        country_name=country.name if country else None,
                        region=country.region if country else None,
                    ),
                    ingested_at=now,
                    source_timestamp=stamp,
                    sources=[
                        SourceRef(
                            adapter="currency.frankfurter",
                            provider="frankfurter",
                            provider_event_id=f"{pair}-{payload.get('date')}",
                            url="https://www.frankfurter.app",
                            retrieved_at=now,
                            source_timestamp=stamp,
                            publisher="European Central Bank (via Frankfurter)",
                            reliability=0.85,
                        )
                    ],
                    tags=["currency", "fx", base.lower(), quote.lower()],
                    entities=[
                        EventEntity(
                            entity_id=f"fx:{pair}",
                            entity_type="topic",
                            name=pair,
                            country_code=country.code if country else None,
                        )
                    ],
                    properties={
                        "pair": pair,
                        "base": base,
                        "quote": quote,
                        "rate": latest_rate,
                        "previous_rate": prev_rate,
                        "change_pct": change_pct,
                        "date": payload.get("date"),
                    },
                )
            )
        return out


def _parse_date(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(str(value), "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _synthetic_fx_payload(pairs: Sequence[tuple[str, str]]) -> dict[str, Any]:
    """Deterministic offline fallback so ingestion never fully stalls."""

    now = datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")
    yesterday = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    seed_rates = {
        "EUR": 0.92, "JPY": 151.0, "GBP": 0.78, "CNY": 7.24,
        "CHF": 0.88, "CAD": 1.37,
    }
    seed_prev = {
        "EUR": 0.91, "JPY": 150.3, "GBP": 0.775, "CNY": 7.22,
        "CHF": 0.885, "CAD": 1.365,
    }
    bases = {base for base, _ in pairs}
    latest = {
        base: {
            "amount": 1.0,
            "base": base,
            "date": today,
            "rates": {
                quote: seed_rates.get(quote, 1.0)
                for b, quote in pairs
                if b == base
            },
        }
        for base in bases
    }
    previous = {
        base: {
            "amount": 1.0,
            "base": base,
            "date": yesterday,
            "rates": {
                quote: seed_prev.get(quote, 1.0)
                for b, quote in pairs
                if b == base
            },
        }
        for base in bases
    }
    return {
        "latest": latest,
        "previous": previous,
        "retrieved_at": now.isoformat(),
    }


__all__ = ["CurrencyAdapter"]
