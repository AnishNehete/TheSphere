"""Adapter contract tests.

Each adapter normalizes a provider payload into canonical SignalEvents. Weather
and news adapters are exercised via httpx.MockTransport so tests never touch
the network. Scaffold adapters (flights, conflict, mood) are exercised directly
since they hold their own deterministic sample data.
"""

from __future__ import annotations

from typing import Any, Sequence

import httpx
import pytest
from httpx import MockTransport, Request, Response

from app.intelligence.adapters import (
    ConflictAdapter,
    CurrencyAdapter,
    FlightAdapter,
    MoodAdapter,
    NewsAdapter,
    SignalAdapter,
    StocksAdapter,
    WeatherAdapter,
)
from app.intelligence.schemas import SignalEvent
from app.settings import ProviderConfig


# --- WeatherAdapter -----------------------------------------------------------


def _weather_ok_handler(request: Request) -> Response:
    if "earthquake.usgs.gov" in request.url.host:
        return Response(
            200,
            json={
                "type": "FeatureCollection",
                "features": [
                    {
                        "id": "us-test-001",
                        "properties": {
                            "mag": 5.4,
                            "place": "120km SSE of Sample",
                            "title": "M 5.4 test event",
                            "time": 1_713_712_800_000,
                            "url": "https://earthquake.example/test",
                        },
                        "geometry": {"type": "Point", "coordinates": [-120.5, 40.5, 5]},
                    }
                ],
            },
        )
    if "api.open-meteo.com" in request.url.host:
        return Response(
            200,
            json={
                "current": {
                    "temperature_2m": 36.0,
                    "wind_speed_10m": 15.0,
                    "precipitation": 6.0,
                    "weather_code": 95,
                    "time": "2026-04-21T12:00",
                }
            },
        )
    return Response(404)


def _weather_offline_handler(request: Request) -> Response:
    if "earthquake.usgs.gov" in request.url.host:
        return Response(200, json={"type": "FeatureCollection", "features": []})
    return Response(500, json={"error": "offline"})


async def test_weather_adapter_happy_path_normalizes_events() -> None:
    client = httpx.AsyncClient(transport=MockTransport(_weather_ok_handler))
    adapter = WeatherAdapter(client=client, max_countries_sampled=2)
    try:
        result = await adapter.poll()
    finally:
        await client.aclose()

    assert result.ok is True
    assert result.error is None
    assert len(result.events) >= 2  # 1 seismic + >=1 severe-weather sample
    for event in result.events:
        assert isinstance(event, SignalEvent)
        assert event.type == "weather"
        assert 0.0 <= event.severity_score <= 1.0
        assert event.sources, "every event must carry provenance"
    assert adapter.health.last_item_count == len(result.events)
    assert adapter.health.stale is False


async def test_weather_adapter_honors_provider_config_base_url() -> None:
    """When ProviderConfig.base_url is set, Open-Meteo calls must hit that host."""

    visited_hosts: list[str] = []

    def handler(request: Request) -> Response:
        visited_hosts.append(request.url.host)
        if "earthquake.usgs.gov" in request.url.host:
            return Response(200, json={"type": "FeatureCollection", "features": []})
        if request.url.host == "open-meteo.mirror.example":
            return Response(
                200,
                json={
                    "current": {
                        "temperature_2m": 22.0,
                        "wind_speed_10m": 3.0,
                        "precipitation": 0.0,
                        "weather_code": 1,
                        "time": "2026-04-21T12:00",
                    }
                },
            )
        return Response(404)

    client = httpx.AsyncClient(transport=MockTransport(handler))
    config = ProviderConfig(
        domain="weather",
        enabled=True,
        provider="open-meteo",
        base_url="https://open-meteo.mirror.example",
    )
    adapter = WeatherAdapter(client=client, max_countries_sampled=1, config=config)
    try:
        await adapter.poll()
    finally:
        await client.aclose()

    assert "open-meteo.mirror.example" in visited_hosts
    assert "api.open-meteo.com" not in visited_hosts


async def test_weather_adapter_falls_back_when_network_fails() -> None:
    client = httpx.AsyncClient(transport=MockTransport(_weather_offline_handler))
    adapter = WeatherAdapter(client=client, max_countries_sampled=3)
    try:
        result = await adapter.poll()
    finally:
        await client.aclose()

    assert result.ok is True
    # synthetic fallback still yields at least one weather event
    assert len(result.events) >= 1
    assert all(e.type == "weather" for e in result.events)


# --- NewsAdapter --------------------------------------------------------------


def _news_ok_handler(request: Request) -> Response:
    if "api.gdeltproject.org" in request.url.host:
        return Response(
            200,
            json={
                "articles": [
                    {
                        "title": "Severe storm warning issued across Japan",
                        "url": "https://news.example/jp-storm",
                        "sourcecountry": "Japan",
                        "seendate": "20260421T120000Z",
                        "language": "eng",
                    },
                    {
                        "title": "Red Sea shipping delays widen",
                        "url": "https://news.example/red-sea",
                        "sourcecountry": "Egypt",
                        "seendate": "20260421T120000Z",
                    },
                ]
            },
        )
    return Response(404)


def _news_fail_handler(request: Request) -> Response:
    return Response(500)


async def test_news_adapter_happy_path_normalizes_articles() -> None:
    client = httpx.AsyncClient(transport=MockTransport(_news_ok_handler))
    adapter = NewsAdapter(client=client, limit=5)
    try:
        result = await adapter.poll()
    finally:
        await client.aclose()

    assert result.ok is True
    assert len(result.events) == 2
    for event in result.events:
        assert event.type == "news"
        assert event.title
        assert event.sources
        assert event.sources[0].adapter == "news.gdelt"


async def test_news_adapter_uses_synthetic_fallback_when_gdelt_fails() -> None:
    client = httpx.AsyncClient(transport=MockTransport(_news_fail_handler))
    adapter = NewsAdapter(client=client, limit=5)
    try:
        result = await adapter.poll()
    finally:
        await client.aclose()

    assert result.ok is True
    assert len(result.events) >= 1
    assert all(e.type == "news" for e in result.events)


async def test_news_adapter_resolves_country_from_sourcecountry_name() -> None:
    def handler(request: Request) -> Response:
        return Response(
            200,
            json={
                "articles": [
                    {
                        "title": "Typhoon forecast to make landfall",
                        "url": "https://news.example/ph",
                        "sourcecountry": "Philippines",
                        "domain": "news.example",
                        "seendate": "20260421T120000Z",
                        "language": "eng",
                        "tone": -3.0,
                    }
                ]
            },
        )

    client = httpx.AsyncClient(transport=MockTransport(handler))
    adapter = NewsAdapter(client=client, limit=5)
    try:
        result = await adapter.poll()
    finally:
        await client.aclose()

    assert len(result.events) == 1
    event = result.events[0]
    assert event.place.country_code == "PHL"
    assert event.place.country_name == "Philippines"
    assert event.entities and event.entities[0].entity_id == "country:PHL"
    assert "country:phl" in event.tags


async def test_news_adapter_escalates_severity_with_negative_tone() -> None:
    def handler(request: Request) -> Response:
        return Response(
            200,
            json={
                "articles": [
                    {
                        "title": "Port operations disrupted in Singapore",
                        "url": "https://news.example/sg-port",
                        "sourcecountry": "Singapore",
                        "domain": "news.example",
                        "seendate": "20260421T120000Z",
                        "tone": -6.5,
                    },
                    {
                        "title": "Port operations disrupted in Indonesia",
                        "url": "https://news.example/id-port",
                        "sourcecountry": "Indonesia",
                        "domain": "news.example",
                        "seendate": "20260421T120000Z",
                        "tone": 0.5,
                    },
                ]
            },
        )

    client = httpx.AsyncClient(transport=MockTransport(handler))
    adapter = NewsAdapter(client=client, limit=5)
    try:
        result = await adapter.poll()
    finally:
        await client.aclose()

    events_by_country = {e.place.country_code: e for e in result.events}
    assert {"SGP", "IDN"} <= set(events_by_country)
    assert (
        events_by_country["SGP"].severity_score
        > events_by_country["IDN"].severity_score
    )


async def test_news_adapter_honors_provider_config_base_url() -> None:
    visited_hosts: list[str] = []

    def handler(request: Request) -> Response:
        visited_hosts.append(request.url.host)
        if request.url.host != "gdelt.mirror.example":
            return Response(404)
        return Response(
            200,
            json={
                "articles": [
                    {
                        "title": "Test mirror hit",
                        "url": "https://news.example/mirror",
                        "sourcecountry": "Japan",
                        "seendate": "20260421T120000Z",
                    }
                ]
            },
        )

    client = httpx.AsyncClient(transport=MockTransport(handler))
    config = ProviderConfig(
        domain="news",
        enabled=True,
        provider="gdelt",
        base_url="https://gdelt.mirror.example",
    )
    adapter = NewsAdapter(client=client, limit=5, config=config)
    try:
        await adapter.poll()
    finally:
        await client.aclose()

    assert "gdelt.mirror.example" in visited_hosts
    assert "api.gdeltproject.org" not in visited_hosts


async def test_news_adapter_dedupes_repeat_articles() -> None:
    def handler(request: Request) -> Response:
        return Response(
            200,
            json={
                "articles": [
                    {
                        "title": "Same story",
                        "url": "https://news.example/same",
                        "sourcecountry": "Japan",
                        "seendate": "20260421T120000Z",
                    },
                    {
                        "title": "Same story",
                        "url": "https://news.example/same",
                        "sourcecountry": "Japan",
                        "seendate": "20260421T120000Z",
                    },
                ]
            },
        )

    client = httpx.AsyncClient(transport=MockTransport(handler))
    adapter = NewsAdapter(client=client, limit=5)
    try:
        result = await adapter.poll()
    finally:
        await client.aclose()

    assert len(result.events) == 1


# --- CurrencyAdapter ----------------------------------------------------------


def _currency_ok_handler(request: Request) -> Response:
    """Handle Frankfurter `/latest` and `/{yesterday}` endpoints for a USD basket."""

    if "frankfurter" not in request.url.host:
        return Response(404)

    path = request.url.path
    base = request.url.params.get("from", "USD")
    symbols = (request.url.params.get("to") or "").split(",")

    latest_rates = {
        "EUR": 0.9200,
        "JPY": 151.00,
        "GBP": 0.7800,
        "CNY": 7.2400,
        "CHF": 0.8800,
        "CAD": 1.3700,
    }
    prev_rates = {
        "EUR": 0.9100,
        "JPY": 150.30,
        "GBP": 0.7750,
        "CNY": 7.2200,
        "CHF": 0.8850,
        "CAD": 1.3650,
    }

    if path == "/latest":
        return Response(
            200,
            json={
                "amount": 1.0,
                "base": base,
                "date": "2026-04-21",
                "rates": {s: latest_rates[s] for s in symbols if s in latest_rates},
            },
        )
    # historic fix (yesterday)
    return Response(
        200,
        json={
            "amount": 1.0,
            "base": base,
            "date": "2026-04-20",
            "rates": {s: prev_rates[s] for s in symbols if s in prev_rates},
        },
    )


def _currency_fail_handler(request: Request) -> Response:
    return Response(500, json={"error": "offline"})


async def test_currency_adapter_happy_path_emits_fx_signals() -> None:
    client = httpx.AsyncClient(transport=MockTransport(_currency_ok_handler))
    adapter = CurrencyAdapter(client=client, pairs=(("USD", "EUR"), ("USD", "JPY")))
    try:
        result = await adapter.poll()
    finally:
        await client.aclose()

    assert result.ok is True
    assert result.error is None
    assert len(result.events) == 2

    pairs_seen = {event.properties["pair"] for event in result.events}
    assert pairs_seen == {"USDEUR", "USDJPY"}

    for event in result.events:
        assert isinstance(event, SignalEvent)
        assert event.type == "currency"
        assert event.sub_type == "fx-rate"
        assert event.sources and event.sources[0].adapter == "currency.frankfurter"
        assert event.sources[0].publisher.startswith("European Central Bank")
        assert 0.0 <= event.severity_score <= 1.0
        assert event.properties["base"] == "USD"
        assert event.properties["rate"] > 0
        assert event.properties["previous_rate"] is not None
        # change_pct must be the computed delta vs prior fix
        assert event.properties["change_pct"] != 0


async def test_currency_adapter_falls_back_when_network_fails() -> None:
    client = httpx.AsyncClient(transport=MockTransport(_currency_fail_handler))
    adapter = CurrencyAdapter(client=client, pairs=(("USD", "EUR"),))
    try:
        result = await adapter.poll()
    finally:
        await client.aclose()

    # Synthetic fallback keeps the pipeline exercisable even without a live feed.
    assert result.ok is True
    assert len(result.events) >= 1
    assert all(e.type == "currency" for e in result.events)


async def test_currency_adapter_disabled_config_short_circuits() -> None:
    """An explicitly disabled ProviderConfig must not touch the network."""

    calls: list[str] = []

    def handler(request: Request) -> Response:
        calls.append(str(request.url))
        return Response(500)

    client = httpx.AsyncClient(transport=MockTransport(handler))
    config = ProviderConfig(
        domain="currency",
        enabled=False,
        provider="frankfurter",
    )
    adapter = CurrencyAdapter(client=client, config=config)
    try:
        result = await adapter.poll()
    finally:
        await client.aclose()

    assert result.ok is True
    assert result.events == []
    assert calls == []


async def test_currency_adapter_honors_provider_config_base_url() -> None:
    visited_hosts: list[str] = []

    def mirror_handler(request: Request) -> Response:
        visited_hosts.append(request.url.host)
        if request.url.host != "frankfurter.mirror.example":
            return Response(404)
        path = request.url.path
        symbols = (request.url.params.get("to") or "").split(",")
        if path == "/latest":
            return Response(
                200,
                json={
                    "amount": 1.0,
                    "base": "USD",
                    "date": "2026-04-21",
                    "rates": {s: 1.0 for s in symbols},
                },
            )
        return Response(
            200,
            json={
                "amount": 1.0,
                "base": "USD",
                "date": "2026-04-20",
                "rates": {s: 1.0 for s in symbols},
            },
        )

    client = httpx.AsyncClient(transport=MockTransport(mirror_handler))
    config = ProviderConfig(
        domain="currency",
        enabled=True,
        provider="frankfurter",
        base_url="https://frankfurter.mirror.example",
    )
    adapter = CurrencyAdapter(
        client=client, pairs=(("USD", "EUR"),), config=config
    )
    try:
        await adapter.poll()
    finally:
        await client.aclose()

    assert "frankfurter.mirror.example" in visited_hosts
    assert "api.frankfurter.app" not in visited_hosts


# --- StocksAdapter ------------------------------------------------------------


_STOCK_FIXTURES: dict[str, tuple[str, str, str]] = {
    # symbol: (previous_close, price, "n.nnnn%")
    "AAPL": ("150.00", "151.50", "1.0000%"),
    "MSFT": ("400.00", "398.00", "-0.5000%"),
    "NVDA": ("880.00", "860.00", "-2.2727%"),
    "TSLA": ("250.00", "245.00", "-2.0000%"),
    "SPY":  ("520.00", "521.00", "0.1923%"),
}


def _alpha_vantage_ok_handler(request: Request) -> Response:
    if "alphavantage" not in request.url.host:
        return Response(404)
    symbol = request.url.params.get("symbol", "")
    prev_close, price, change_pct = _STOCK_FIXTURES.get(
        symbol, ("100.00", "100.00", "0.0000%")
    )
    change = f"{float(price) - float(prev_close):.4f}"
    return Response(
        200,
        json={
            "Global Quote": {
                "01. symbol": symbol,
                "02. open": prev_close,
                "03. high": price,
                "04. low": prev_close,
                "05. price": price,
                "06. volume": "50000000",
                "07. latest trading day": "2026-04-21",
                "08. previous close": prev_close,
                "09. change": change,
                "10. change percent": change_pct,
            }
        },
    )


def _alpha_vantage_rate_limit_handler(request: Request) -> Response:
    return Response(
        200,
        json={
            "Note": (
                "Thank you for using Alpha Vantage! Our standard API call "
                "frequency is 5 calls per minute and 25 calls per day."
            )
        },
    )


async def test_stocks_adapter_happy_path_emits_equity_quotes() -> None:
    client = httpx.AsyncClient(transport=MockTransport(_alpha_vantage_ok_handler))
    config = ProviderConfig(
        domain="stocks",
        enabled=True,
        provider="alphavantage",
        api_key="demo-key",
    )
    adapter = StocksAdapter(
        client=client,
        config=config,
        symbols=(
            ("AAPL", "Apple Inc.", "USA"),
            ("MSFT", "Microsoft Corp.", "USA"),
        ),
        request_delay_seconds=0.0,
        cache_ttl_seconds=0,
    )
    try:
        result = await adapter.poll()
    finally:
        await client.aclose()

    assert result.ok is True
    assert result.error is None
    assert len(result.events) == 2
    symbols_seen = {event.properties["symbol"] for event in result.events}
    assert symbols_seen == {"AAPL", "MSFT"}
    for event in result.events:
        assert event.type == "stocks"
        assert event.sub_type == "equity-quote"
        assert event.sources and event.sources[0].adapter == "stocks.alphavantage"
        assert event.sources[0].publisher == "Alpha Vantage"
        assert event.properties["price"] is not None
        assert event.properties["previous_close"] is not None
        assert event.properties["change_pct"] != 0
        assert event.place.country_code == "USA"
        assert 0.0 <= event.severity_score <= 1.0


async def test_stocks_adapter_missing_api_key_uses_synthetic_fallback() -> None:
    calls: list[str] = []

    def handler(request: Request) -> Response:
        calls.append(str(request.url))
        return Response(500)

    client = httpx.AsyncClient(transport=MockTransport(handler))
    config = ProviderConfig(
        domain="stocks",
        enabled=True,
        provider="alphavantage",
        api_key="",
    )
    adapter = StocksAdapter(
        client=client,
        config=config,
        symbols=(("AAPL", "Apple Inc.", "USA"),),
        request_delay_seconds=0.0,
        cache_ttl_seconds=0,
    )
    try:
        result = await adapter.poll()
    finally:
        await client.aclose()

    assert result.ok is True
    assert len(result.events) >= 1
    assert all(event.type == "stocks" for event in result.events)
    # no network calls without a key
    assert calls == []
    # adapter reports itself as not configured so health surface can warn
    assert adapter.is_configured is False


async def test_stocks_adapter_handles_rate_limit_response() -> None:
    calls: list[str] = []

    def handler(request: Request) -> Response:
        calls.append(request.url.params.get("symbol", ""))
        return _alpha_vantage_rate_limit_handler(request)

    client = httpx.AsyncClient(transport=MockTransport(handler))
    config = ProviderConfig(
        domain="stocks",
        enabled=True,
        provider="alphavantage",
        api_key="demo-key",
    )
    adapter = StocksAdapter(
        client=client,
        config=config,
        symbols=(
            ("AAPL", "Apple Inc.", "USA"),
            ("MSFT", "Microsoft Corp.", "USA"),
        ),
        request_delay_seconds=0.0,
        cache_ttl_seconds=0,
    )
    try:
        result = await adapter.poll()
    finally:
        await client.aclose()

    # First call trips the rate-limit signal so we break early.
    assert calls == ["AAPL"]
    # Pipeline stays alive via synthetic fallback
    assert result.ok is True
    assert len(result.events) >= 1
    assert all(event.type == "stocks" for event in result.events)


async def test_stocks_adapter_falls_back_when_http_fails() -> None:
    def handler(request: Request) -> Response:
        return Response(502)

    client = httpx.AsyncClient(transport=MockTransport(handler))
    config = ProviderConfig(
        domain="stocks",
        enabled=True,
        provider="alphavantage",
        api_key="demo-key",
    )
    adapter = StocksAdapter(
        client=client,
        config=config,
        symbols=(("AAPL", "Apple Inc.", "USA"),),
        request_delay_seconds=0.0,
        cache_ttl_seconds=0,
    )
    try:
        result = await adapter.poll()
    finally:
        await client.aclose()

    assert result.ok is True
    assert len(result.events) >= 1
    assert all(event.type == "stocks" for event in result.events)


async def test_stocks_adapter_honors_provider_config_base_url() -> None:
    visited_hosts: list[str] = []

    def handler(request: Request) -> Response:
        visited_hosts.append(request.url.host)
        if request.url.host != "av.mirror.example":
            return Response(404)
        return _alpha_vantage_ok_handler(request)

    client = httpx.AsyncClient(transport=MockTransport(handler))
    config = ProviderConfig(
        domain="stocks",
        enabled=True,
        provider="alphavantage",
        api_key="demo-key",
        base_url="https://av.mirror.example",
    )
    adapter = StocksAdapter(
        client=client,
        config=config,
        symbols=(("AAPL", "Apple Inc.", "USA"),),
        request_delay_seconds=0.0,
        cache_ttl_seconds=0,
    )
    try:
        await adapter.poll()
    finally:
        await client.aclose()

    assert "av.mirror.example" in visited_hosts
    assert "www.alphavantage.co" not in visited_hosts


async def test_stocks_adapter_uses_cache_on_repeat_poll() -> None:
    call_log: list[str] = []

    def handler(request: Request) -> Response:
        call_log.append(request.url.params.get("symbol", ""))
        return _alpha_vantage_ok_handler(request)

    client = httpx.AsyncClient(transport=MockTransport(handler))
    config = ProviderConfig(
        domain="stocks",
        enabled=True,
        provider="alphavantage",
        api_key="demo-key",
    )
    adapter = StocksAdapter(
        client=client,
        config=config,
        symbols=(("AAPL", "Apple Inc.", "USA"),),
        request_delay_seconds=0.0,
        cache_ttl_seconds=300,
    )
    try:
        first = await adapter.poll()
        second = await adapter.poll()
    finally:
        await client.aclose()

    assert first.ok and second.ok
    assert call_log.count("AAPL") == 1  # second poll served from cache


# --- Scaffold adapters --------------------------------------------------------


async def test_flight_adapter_emits_valid_scaffold_events() -> None:
    result = await FlightAdapter().poll()

    assert result.ok is True
    assert result.events
    for event in result.events:
        assert isinstance(event, SignalEvent)
        assert event.type == "flights"
        assert event.sources
        assert 0.0 <= event.severity_score <= 1.0


async def test_conflict_adapter_emits_valid_scaffold_events() -> None:
    result = await ConflictAdapter().poll()

    assert result.ok is True
    assert result.events
    for event in result.events:
        assert isinstance(event, SignalEvent)
        assert event.type == "conflict"
        assert event.place.country_code  # conflict signals must attach to a country
        assert 0.0 <= event.severity_score <= 1.0


async def test_mood_adapter_emits_country_level_signals() -> None:
    result = await MoodAdapter().poll()

    assert result.ok is True
    assert result.events
    # every mood signal must resolve to a known country
    for event in result.events:
        assert event.type == "mood"
        assert event.place.country_code
        assert event.place.country_name


# --- Failure isolation --------------------------------------------------------


class _BrokenAdapter(SignalAdapter):
    adapter_id = "test.broken"
    category = "other"
    max_retries = 1

    async def fetch(self) -> Any:
        raise RuntimeError("boom")

    def validate(self, raw: Any) -> Any:
        return raw

    def normalize(self, validated: Any) -> Sequence[SignalEvent]:
        return []


async def test_adapter_failure_reports_unhealthy_result() -> None:
    adapter = _BrokenAdapter()
    result = await adapter.poll()

    assert result.ok is False
    assert result.events == []
    assert result.error is not None
    assert adapter.health.stale is True
    assert adapter.health.consecutive_failures == 1
    assert adapter.health.last_error and "boom" in adapter.health.last_error


@pytest.mark.parametrize(
    "factory",
    [FlightAdapter, ConflictAdapter, MoodAdapter],
)
async def test_scaffold_adapters_have_stable_ids_and_categories(factory) -> None:
    adapter = factory()
    assert adapter.adapter_id
    assert adapter.category in {"flights", "conflict", "mood"}
    assert adapter.health.adapter_id == adapter.adapter_id
