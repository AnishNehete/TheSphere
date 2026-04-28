"""Central backend settings for TheSphere.

Defines two pydantic settings classes:

* :class:`Settings` — legacy ``SPHERE_*`` envelope for the globe/simulator stack.
* :class:`IntelligenceSettings` — the Phase-11 intelligence backbone config,
  keyed under ``INTELLIGENCE_*``. Adapters pull per-domain
  :class:`ProviderConfig` snapshots via :meth:`IntelligenceSettings.provider_config`
  so they can decide at runtime whether to hit a live provider, fall back to
  the offline synthetic path, or stay dormant.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


IntelligenceDomain = Literal[
    "weather",
    "flight",
    "news",
    "conflict",
    "disease",
    "mood",
    "stocks",
    "commodities",
    "currency",
]

INTELLIGENCE_DOMAINS: tuple[IntelligenceDomain, ...] = (
    "weather",
    "flight",
    "news",
    "conflict",
    "disease",
    "mood",
    "stocks",
    "commodities",
    "currency",
)


@dataclass(frozen=True, slots=True)
class ProviderConfig:
    """Per-domain provider configuration snapshot.

    Passed into adapters at construction time. Always immutable so it can be
    safely shared across adapters, health checks, and tests. ``api_key`` is
    held here but is NEVER serialized back into responses; the public view
    exposes only :attr:`has_api_key`.
    """

    domain: IntelligenceDomain
    enabled: bool = True
    provider: str = ""
    api_key: str = ""
    base_url: str = ""

    @property
    def has_api_key(self) -> bool:
        return bool(self.api_key and self.api_key.strip())

    @property
    def is_configured(self) -> bool:
        """Adapter has the minimum it needs to run against its provider.

        Default heuristic: enabled + a provider name is present. Individual
        adapters may tighten this (e.g. require ``has_api_key``) by inspecting
        the config in their ``fetch`` path.
        """

        return bool(self.enabled and self.provider)

    def to_public_dict(self) -> dict[str, object]:
        """Representation safe to return over HTTP (no secrets)."""

        return {
            "domain": self.domain,
            "enabled": self.enabled,
            "provider": self.provider or None,
            "baseUrl": self.base_url or None,
            "hasApiKey": self.has_api_key,
            "configured": self.is_configured,
        }


class Settings(BaseSettings):
    """Legacy ``SPHERE_*`` settings used by the globe + simulator stack."""

    app_name: str = "THE SPHERE API"
    frontend_origin: str = "http://localhost:3000"
    frontend_origins: str | None = None
    postgres_dsn: str | None = None
    redis_url: str | None = None
    enable_simulator: bool = True
    simulation_interval_ms: int = 2500
    local_dev_origin_regex: str = r"https?://(localhost|127\.0\.0\.1)(:\d+)?"

    model_config = SettingsConfigDict(env_prefix="SPHERE_", extra="ignore")

    @property
    def cors_origins(self) -> list[str]:
        origins = [
            self.frontend_origin,
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:3001",
            "http://127.0.0.1:3001",
        ]

        if self.frontend_origins:
            origins.extend(
                origin.strip()
                for origin in self.frontend_origins.split(",")
                if origin.strip()
            )

        return list(dict.fromkeys(origins))


class IntelligenceSettings(BaseSettings):
    """Typed configuration for the live intelligence backbone.

    All fields map 1:1 to environment variables under ``INTELLIGENCE_*``.
    Adapters consume domain-specific configuration through
    :meth:`provider_config`, which bundles enable/provider/api_key/base_url
    into a single :class:`ProviderConfig`.
    """

    env: str = "development"
    database_url: str | None = None
    redis_url: str | None = None

    ingest_poll_seconds: int = 60
    request_timeout_seconds: int = 15
    enable_offline_fallback: bool = True
    max_items_per_source: int = 200
    cache_ttl_seconds: int = 300

    enable_weather: bool = True
    enable_news: bool = True
    enable_flight: bool = True
    enable_conflict: bool = True
    enable_disease: bool = True
    enable_mood: bool = True
    enable_stocks: bool = True
    enable_commodities: bool = True
    enable_currency: bool = True

    weather_provider: str = "open-meteo"
    weather_api_key: str = ""
    weather_base_url: str = ""

    flight_provider: str = "aviationstack"
    flight_api_key: str = ""
    flight_base_url: str = ""

    news_provider: str = "gdelt"
    news_api_key: str = ""
    news_base_url: str = ""

    conflict_provider: str = "acled"
    conflict_api_key: str = ""
    conflict_base_url: str = ""

    disease_provider: str = "healthmap"
    disease_api_key: str = ""
    disease_base_url: str = ""

    mood_provider: str = "sentiment_proxy"
    mood_api_key: str = ""
    mood_base_url: str = ""

    stocks_provider: str = "alphavantage"
    stocks_api_key: str = ""
    stocks_base_url: str = ""

    commodities_provider: str = "alphavantage"
    commodities_api_key: str = ""
    commodities_base_url: str = ""

    currency_provider: str = "frankfurter"
    currency_api_key: str = ""
    currency_base_url: str = ""

    # ---- Phase 17A.2: live market-data provider locked to Alpha Vantage ----
    # ``polygon`` parses for backwards compatibility with old deployments
    # but the builder routes it through Alpha Vantage with a logged warning.
    # Fresh installs should set ``alphavantage`` (or ``synthetic`` for offline).
    market_data_provider: Literal["alphavantage", "synthetic", "polygon"] = (
        "alphavantage"
    )
    polygon_api_key: str = ""
    polygon_base_url: str = "https://api.polygon.io"
    alpha_vantage_api_key: str = ""
    alpha_vantage_base_url: str = "https://www.alphavantage.co"

    # ---- Phase 17A.3: bounded agentic market narrative -------------------
    # Optional. When ``anthropic_api_key`` is empty the narrative endpoint
    # returns a deterministic explanation built only from the typed posture
    # envelope — no external call, no fabricated language. When the key is
    # set, Claude generates 2-3 sentences of bounded prose under strict
    # citation/numeric guardrails; any guardrail violation falls back to
    # the deterministic path.
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-haiku-4-5-20251001"
    anthropic_base_url: str = "https://api.anthropic.com"
    anthropic_request_timeout_seconds: float = 12.0

    openai_api_key: str = ""
    openai_model: str = "gpt-5.4"
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = ""
    embedding_provider: str = "openai"
    embedding_model: str = "text-embedding-3-large"

    log_level: str = "INFO"
    enable_metrics: bool = True
    enable_trace_logging: bool = False

    # Phase 17C beta-hardening — in-memory rate limits. Both default to
    # generous closed-beta numbers and can be tightened from env without
    # a code change.
    share_read_rate_per_hour: int = 60
    investigation_save_rate_per_hour: int = 30
    alert_rule_create_rate_per_hour: int = 30

    model_config = SettingsConfigDict(env_prefix="INTELLIGENCE_", extra="ignore")

    def provider_config(self, domain: IntelligenceDomain) -> ProviderConfig:
        return ProviderConfig(
            domain=domain,
            enabled=bool(getattr(self, f"enable_{domain}")),
            provider=str(getattr(self, f"{domain}_provider") or ""),
            api_key=str(getattr(self, f"{domain}_api_key") or ""),
            base_url=str(getattr(self, f"{domain}_base_url") or ""),
        )

    def all_provider_configs(self) -> tuple[ProviderConfig, ...]:
        return tuple(self.provider_config(domain) for domain in INTELLIGENCE_DOMAINS)


def get_settings() -> Settings:
    return Settings()


def get_intelligence_settings() -> IntelligenceSettings:
    return IntelligenceSettings()


__all__ = [
    "INTELLIGENCE_DOMAINS",
    "IntelligenceDomain",
    "IntelligenceSettings",
    "ProviderConfig",
    "Settings",
    "get_intelligence_settings",
    "get_settings",
]
