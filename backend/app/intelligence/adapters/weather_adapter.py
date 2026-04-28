"""Weather adapter backed by the USGS earthquake feed and Open-Meteo severe-weather.

Open-Meteo (https://open-meteo.com) and USGS both expose keyless public feeds
that return structured JSON suitable for Phase 11 without provisioning an API
key. If the network is unavailable (which is common in demo / offline dev
environments) we fall back to a deterministic synthetic sample so the rest of
the system stays exercisable.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import math
from datetime import datetime, timezone
from typing import Any, Sequence

import httpx

from app.intelligence.adapters.base import SignalAdapter
from app.intelligence.adapters.country_lookup import CountryMeta, list_countries, lookup_by_alpha3
from app.intelligence.schemas import (
    EventEntity,
    Place,
    SignalEvent,
    SignalSeverity,
    SourceRef,
)
from app.settings import ProviderConfig


logger = logging.getLogger(__name__)

USGS_ENDPOINT = (
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_day.geojson"
)
OPEN_METEO_DEFAULT_BASE = "https://api.open-meteo.com"
OPEN_METEO_FORECAST_PATH = "/v1/forecast"


class WeatherAdapter(SignalAdapter):
    """Fetch significant weather + seismic activity and normalize to SignalEvents."""

    adapter_id = "weather.usgs+openmeteo"
    category = "weather"
    domain = "weather"
    poll_interval_seconds = 180

    def __init__(
        self,
        *,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 10.0,
        max_countries_sampled: int = 12,
        config: ProviderConfig | None = None,
    ) -> None:
        super().__init__(config=config)
        self._client = client
        self._owns_client = client is None
        self._timeout = timeout_seconds
        self._max_countries = max_countries_sampled

    @property
    def _open_meteo_endpoint(self) -> str:
        base = (
            self._config.base_url.rstrip("/")
            if self._config and self._config.base_url
            else OPEN_METEO_DEFAULT_BASE
        )
        return f"{base}{OPEN_METEO_FORECAST_PATH}"

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
        usgs_payload: dict[str, Any] = {"features": []}
        open_meteo_samples: list[dict[str, Any]] = []

        try:
            response = await client.get(USGS_ENDPOINT)
            response.raise_for_status()
            usgs_payload = response.json()
        except Exception as exc:  # network/provider errors isolated per-source
            logger.warning("weather adapter: USGS fetch failed: %s", exc)
            usgs_payload = {"features": []}

        sample_countries = list(list_countries())[: self._max_countries]
        tasks = [self._fetch_open_meteo(client, c) for c in sample_countries]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for country, result in zip(sample_countries, results):
            if isinstance(result, Exception):
                logger.debug("weather adapter: Open-Meteo failed for %s: %s", country.code, result)
                continue
            if result is not None:
                open_meteo_samples.append(result)

        if not usgs_payload.get("features") and not open_meteo_samples:
            # offline fallback: keep the rest of the pipeline exercisable
            open_meteo_samples = _synthetic_weather_samples(sample_countries)

        return {
            "usgs": usgs_payload,
            "open_meteo": open_meteo_samples,
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }

    async def _fetch_open_meteo(
        self, client: httpx.AsyncClient, country: CountryMeta
    ) -> dict[str, Any] | None:
        params = {
            "latitude": country.latitude,
            "longitude": country.longitude,
            "current": "temperature_2m,wind_speed_10m,precipitation,weather_code",
            "timezone": "UTC",
        }
        try:
            response = await client.get(self._open_meteo_endpoint, params=params)
            response.raise_for_status()
            payload = response.json()
        except Exception:
            return None
        return {"country": country, "payload": payload}

    def validate(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise ValueError("weather adapter expected dict payload")
        usgs = raw.get("usgs") or {}
        open_meteo = raw.get("open_meteo") or []
        if not isinstance(usgs, dict) or not isinstance(open_meteo, list):
            raise ValueError("weather adapter payload shape invalid")
        return raw

    def normalize(self, validated: dict[str, Any]) -> Sequence[SignalEvent]:
        now = datetime.now(timezone.utc)
        events: list[SignalEvent] = []

        for feature in validated["usgs"].get("features", []):
            event = _normalize_usgs_feature(feature, now=now)
            if event is not None:
                events.append(event)

        for sample in validated["open_meteo"]:
            event = _normalize_open_meteo_sample(sample, now=now)
            if event is not None:
                events.append(event)

        return events


def _normalize_usgs_feature(feature: dict[str, Any], *, now: datetime) -> SignalEvent | None:
    props = feature.get("properties") or {}
    geom = feature.get("geometry") or {}
    coords = geom.get("coordinates") or []
    if len(coords) < 2:
        return None
    longitude, latitude = float(coords[0]), float(coords[1])
    magnitude = float(props.get("mag") or 0.0)
    title = str(props.get("title") or props.get("place") or "Seismic event")
    place_name = str(props.get("place") or "")
    provider_id = str(feature.get("id") or props.get("code") or title)

    severity, severity_score = _severity_from_magnitude(magnitude)
    source_timestamp = _from_epoch_ms(props.get("time"))

    dedupe_key = _dedupe("usgs", provider_id, round(latitude, 1), round(longitude, 1))
    return SignalEvent(
        id=f"wx-usgs-{_short_hash(provider_id)}",
        dedupe_key=dedupe_key,
        type="weather",
        sub_type="seismic",
        title=title,
        summary=f"Magnitude {magnitude:.1f} seismic event{f' near {place_name}' if place_name else ''}.",
        description=str(props.get("detail") or "") or None,
        severity=severity,
        severity_score=severity_score,
        confidence=min(0.55 + magnitude / 10.0, 0.95),
        status="active",
        place=Place(
            latitude=latitude,
            longitude=longitude,
            locality=place_name or None,
        ),
        start_time=source_timestamp,
        source_timestamp=source_timestamp,
        ingested_at=now,
        sources=[
            SourceRef(
                adapter="weather.usgs+openmeteo",
                provider="usgs",
                provider_event_id=provider_id,
                url=str(props.get("url")) if props.get("url") else None,
                retrieved_at=now,
                source_timestamp=source_timestamp,
                publisher="USGS Earthquake Hazards Program",
                reliability=0.9,
            )
        ],
        tags=["seismic", "usgs"],
        entities=[],
        properties={
            "magnitude": magnitude,
            "mmi": props.get("mmi"),
            "alert": props.get("alert"),
            "tsunami": props.get("tsunami"),
        },
    )


def _normalize_open_meteo_sample(
    sample: dict[str, Any], *, now: datetime
) -> SignalEvent | None:
    country: CountryMeta | None = sample.get("country")
    payload = sample.get("payload") or {}
    current = payload.get("current") or {}
    if country is None or not current:
        return None

    temperature = _as_float(current.get("temperature_2m"))
    wind = _as_float(current.get("wind_speed_10m"))
    precipitation = _as_float(current.get("precipitation"))
    weather_code = current.get("weather_code")
    observation_time = current.get("time")
    source_timestamp = _parse_iso(observation_time) or now

    severity, severity_score = _severity_from_weather(
        wind=wind, precipitation=precipitation, temperature=temperature
    )

    if severity == "info" and (precipitation or 0) < 2.0 and (wind or 0) < 8.0:
        # suppress purely calm samples to avoid UI noise
        return None

    title_parts: list[str] = []
    if precipitation and precipitation >= 2.0:
        title_parts.append(f"{precipitation:.1f} mm precipitation")
    if wind and wind >= 12.0:
        title_parts.append(f"{wind:.0f} m/s wind")
    if temperature is not None and (temperature >= 35 or temperature <= -10):
        title_parts.append(f"{temperature:.0f}°C")
    if not title_parts:
        title_parts.append("Active weather")

    title = f"{', '.join(title_parts)} over {country.name}"
    summary = (
        f"Open-Meteo observation for {country.name}: "
        f"temp {temperature if temperature is not None else '—'}°C, "
        f"wind {wind if wind is not None else '—'} m/s, "
        f"precip {precipitation if precipitation is not None else '—'} mm."
    )

    dedupe_key = _dedupe("openmeteo", country.code, observation_time or "now")
    return SignalEvent(
        id=f"wx-om-{country.code.lower()}-{_short_hash(str(observation_time))}",
        dedupe_key=dedupe_key,
        type="weather",
        sub_type="observation",
        title=title,
        summary=summary,
        description=None,
        severity=severity,
        severity_score=severity_score,
        confidence=0.7,
        status="active",
        place=Place(
            latitude=country.latitude,
            longitude=country.longitude,
            country_code=country.code,
            country_name=country.name,
            region=country.region,
        ),
        start_time=source_timestamp,
        source_timestamp=source_timestamp,
        ingested_at=now,
        sources=[
            SourceRef(
                adapter="weather.usgs+openmeteo",
                provider="open-meteo",
                provider_event_id=f"{country.code}-{observation_time}",
                url="https://open-meteo.com",
                retrieved_at=now,
                source_timestamp=source_timestamp,
                publisher="Open-Meteo",
                reliability=0.75,
            )
        ],
        tags=["weather", "current"],
        entities=[
            EventEntity(
                entity_id=f"country:{country.code}",
                entity_type="country",
                name=country.name,
                country_code=country.code,
                score=1.0,
            )
        ],
        properties={
            "temperature_c": temperature,
            "wind_ms": wind,
            "precipitation_mm": precipitation,
            "weather_code": weather_code,
        },
    )


def _severity_from_magnitude(magnitude: float) -> tuple[SignalSeverity, float]:
    if magnitude >= 6.0:
        return "critical", min(0.95, 0.75 + magnitude / 20.0)
    if magnitude >= 5.0:
        return "elevated", 0.7
    if magnitude >= 4.0:
        return "watch", 0.55
    return "info", 0.35


def _severity_from_weather(
    *, wind: float | None, precipitation: float | None, temperature: float | None
) -> tuple[SignalSeverity, float]:
    score = 0.2
    if precipitation is not None:
        score = max(score, min(0.95, precipitation / 40.0))
    if wind is not None:
        score = max(score, min(0.95, wind / 30.0))
    if temperature is not None:
        if temperature >= 40 or temperature <= -20:
            score = max(score, 0.75)
        elif temperature >= 35 or temperature <= -10:
            score = max(score, 0.55)

    if score >= 0.75:
        return "critical", score
    if score >= 0.55:
        return "elevated", score
    if score >= 0.4:
        return "watch", score
    return "info", score


def _synthetic_weather_samples(countries: Sequence[CountryMeta]) -> list[dict[str, Any]]:
    """Deterministic offline fallback so ingestion never fully stalls."""

    out: list[dict[str, Any]] = []
    for idx, country in enumerate(countries):
        wave = math.sin(idx * 0.7)
        payload = {
            "current": {
                "temperature_2m": round(18 + wave * 10, 1),
                "wind_speed_10m": round(8 + abs(wave) * 12, 1),
                "precipitation": round(max(0.0, wave * 6), 1),
                "weather_code": 63 if wave > 0.5 else 3,
                "time": datetime.now(timezone.utc).replace(second=0, microsecond=0).isoformat(),
            }
        }
        out.append({"country": country, "payload": payload})
    return out


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _from_epoch_ms(value: Any) -> datetime | None:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(float(value) / 1000.0, tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def _parse_iso(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        stamp = datetime.fromisoformat(str(value))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return stamp
    except ValueError:
        return None


def _short_hash(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:10]


def _dedupe(*parts: Any) -> str:
    token = "|".join(str(p) for p in parts)
    return hashlib.sha1(token.encode("utf-8")).hexdigest()[:16]


# keep lookup importable for other adapters without direct dependency cycles
__all__ = ["WeatherAdapter", "lookup_by_alpha3"]
