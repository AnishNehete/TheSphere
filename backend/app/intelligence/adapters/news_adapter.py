"""News adapter backed by GDELT's keyless public feed.

GDELT's DOC 2.0 API (https://api.gdeltproject.org/api/v2/doc/doc) returns
near-real-time article metadata without API keys, which is ideal for the
operational-risk wedge. When the network is unreachable a deterministic
synthetic set keeps the rest of the pipeline exercisable.

The adapter:

* honours :class:`ProviderConfig.base_url` so self-hosted mirrors work
* resolves ``sourcecountry`` back to a canonical :class:`CountryMeta`
  (handles full names, ISO-2 and ISO-3 codes)
* blends GDELT ``tone`` and article recency into the severity score
* dedupes articles by URL hash before normalization
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, Sequence
from urllib.parse import urlparse

import httpx

from app.intelligence.adapters.base import SignalAdapter
from app.intelligence.adapters.country_lookup import (
    CountryMeta,
    list_countries,
    lookup_by_alpha2,
    lookup_by_alpha3,
    lookup_by_name,
)
from app.intelligence.schemas import (
    EventEntity,
    Place,
    SignalEvent,
    SignalSeverity,
    SourceRef,
)
from app.settings import ProviderConfig


logger = logging.getLogger(__name__)

GDELT_DEFAULT_BASE = "https://api.gdeltproject.org"
GDELT_DOC_PATH = "/api/v2/doc/doc"
OPERATIONAL_RISK_QUERY = (
    '(flood OR storm OR hurricane OR typhoon OR earthquake OR "supply chain" '
    'OR "port closure" OR airport OR airspace OR sanctions OR embargo OR '
    'conflict OR outbreak OR strike)'
)


class NewsAdapter(SignalAdapter):
    adapter_id = "news.gdelt"
    category = "news"
    domain = "news"
    poll_interval_seconds = 240

    def __init__(
        self,
        *,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 10.0,
        limit: int = 40,
        config: ProviderConfig | None = None,
    ) -> None:
        super().__init__(config=config)
        self._client = client
        self._owns_client = client is None
        self._timeout = timeout_seconds
        self._limit = limit

    @property
    def _endpoint(self) -> str:
        base = (
            self._config.base_url.rstrip("/")
            if self._config and self._config.base_url
            else GDELT_DEFAULT_BASE
        )
        return f"{base}{GDELT_DOC_PATH}"

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
        params = {
            "query": OPERATIONAL_RISK_QUERY,
            "mode": "ArtList",
            "maxrecords": self._limit,
            "format": "json",
            "sort": "DateDesc",
        }

        articles: list[dict[str, Any]] = []
        try:
            response = await client.get(self._endpoint, params=params)
            response.raise_for_status()
            payload = response.json()
            if isinstance(payload, dict):
                raw_articles = payload.get("articles") or []
                if isinstance(raw_articles, list):
                    articles = raw_articles
        except Exception as exc:
            logger.warning("news adapter: GDELT fetch failed: %s", exc)
            articles = []

        if not articles:
            articles = _synthetic_news_articles()

        return {
            "articles": articles,
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }

    def validate(self, raw: Any) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise ValueError("news adapter expected dict payload")
        if not isinstance(raw.get("articles"), list):
            raise ValueError("news adapter expected articles list")
        return raw

    def normalize(self, validated: dict[str, Any]) -> Sequence[SignalEvent]:
        now = datetime.now(timezone.utc)
        seen_keys: set[str] = set()
        out: list[SignalEvent] = []
        for article in validated["articles"][: self._limit]:
            event = _normalize_gdelt_article(article, now=now)
            if event is None:
                continue
            if event.dedupe_key in seen_keys:
                continue
            seen_keys.add(event.dedupe_key)
            out.append(event)
        return out


def _normalize_gdelt_article(
    article: dict[str, Any], *, now: datetime
) -> SignalEvent | None:
    title = str(article.get("title") or "").strip()
    if not title:
        return None

    url = str(article.get("url") or "").strip() or None
    domain = str(article.get("domain") or "").strip() or _domain_of(url)
    seen_date = article.get("seendate")
    source_timestamp = _parse_gdelt_date(seen_date) or now

    tone = _as_float(article.get("tone"))
    language = article.get("language")

    country_meta = _infer_country_from_article(article)

    severity, severity_score = _severity_from_article(
        title=title, tone=tone, now=now, source_timestamp=source_timestamp
    )

    provider_id = url or title
    dedupe_key = _dedupe("gdelt", provider_id)

    summary = _compose_summary(
        title=title, tone=tone, domain=domain, country=country_meta
    )

    entities: list[EventEntity] = []
    if country_meta is not None:
        entities.append(
            EventEntity(
                entity_id=f"country:{country_meta.code}",
                entity_type="country",
                name=country_meta.name,
                country_code=country_meta.code,
                score=0.9,
            )
        )

    tags: list[str] = ["news"]
    if language:
        tags.append(f"lang:{str(language).lower()[:3]}")
    if country_meta is not None:
        tags.append(f"country:{country_meta.code.lower()}")

    return SignalEvent(
        id=f"news-{_short_hash(provider_id)}",
        dedupe_key=dedupe_key,
        type="news",
        sub_type="article",
        title=title,
        summary=summary,
        description=None,
        severity=severity,
        severity_score=severity_score,
        confidence=_confidence_from_source(domain, country_meta is not None),
        status="active",
        place=Place(
            latitude=country_meta.latitude if country_meta else None,
            longitude=country_meta.longitude if country_meta else None,
            country_code=country_meta.code if country_meta else None,
            country_name=country_meta.name if country_meta else None,
            region=country_meta.region if country_meta else None,
        ),
        source_timestamp=source_timestamp,
        ingested_at=now,
        sources=[
            SourceRef(
                adapter="news.gdelt",
                provider="gdelt",
                provider_event_id=provider_id,
                url=url,
                retrieved_at=now,
                source_timestamp=source_timestamp,
                publisher=domain or "GDELT",
                reliability=0.55,
            )
        ],
        tags=tags,
        entities=entities,
        properties={
            "language": language,
            "tone": tone,
            "domain": domain,
            "sourcecountry": article.get("sourcecountry"),
        },
    )


def _infer_country_from_article(article: dict[str, Any]) -> CountryMeta | None:
    """Resolve ``sourcecountry`` to a canonical country.

    GDELT's DOC 2.0 API sends the source country as a full English name
    (``"Japan"``), sometimes as a 2-letter code. Fall back to scanning the
    title for a known country name when neither lookup hits.
    """

    raw = article.get("sourcecountry")
    if isinstance(raw, str):
        candidate = raw.strip()
        if candidate:
            if len(candidate) == 2:
                meta = lookup_by_alpha2(candidate)
                if meta is not None:
                    return meta
            if len(candidate) == 3:
                meta = lookup_by_alpha3(candidate)
                if meta is not None:
                    return meta
            meta = lookup_by_name(candidate)
            if meta is not None:
                return meta

    title = str(article.get("title") or "").lower()
    if title:
        for country in list_countries():
            if country.name.lower() in title:
                return country
    return None


def _severity_from_article(
    *,
    title: str,
    tone: float | None,
    now: datetime,
    source_timestamp: datetime,
) -> tuple[SignalSeverity, float]:
    """Blend title-term matching with GDELT tone and recency."""

    lowered = title.lower()
    critical_terms = (
        "killed", "dead", "casualt", "catastroph", "disaster", "tsunami",
        "airstrike", "evacuat", "massacre",
    )
    elevated_terms = (
        "flood", "storm", "hurricane", "typhoon", "earthquake", "strike",
        "conflict", "sanction", "outbreak", "explosion",
    )
    watch_terms = (
        "delay", "warning", "threat", "dispute", "closure", "tariff",
        "protest", "shortage",
    )

    if any(term in lowered for term in critical_terms):
        base_score = 0.85
    elif any(term in lowered for term in elevated_terms):
        base_score = 0.65
    elif any(term in lowered for term in watch_terms):
        base_score = 0.48
    else:
        base_score = 0.32

    # GDELT tone ranges roughly [-10, 10]; strongly negative news lifts severity.
    if tone is not None:
        if tone < -2.0:
            base_score = min(1.0, base_score + min(0.2, abs(tone) / 50.0))
        elif tone > 4.0:
            base_score = max(0.1, base_score - 0.05)

    # Slight recency bump for articles less than 2 hours old.
    age_seconds = max(0.0, (now - source_timestamp).total_seconds())
    if age_seconds < 2 * 3600:
        base_score = min(1.0, base_score + 0.03)

    score = round(base_score, 3)
    if score >= 0.75:
        return "critical", score
    if score >= 0.55:
        return "elevated", score
    if score >= 0.4:
        return "watch", score
    return "info", score


def _confidence_from_source(domain: str | None, has_country: bool) -> float:
    score = 0.5
    if domain:
        score += 0.05
    if has_country:
        score += 0.05
    return round(min(score, 0.9), 3)


def _compose_summary(
    *,
    title: str,
    tone: float | None,
    domain: str | None,
    country: CountryMeta | None,
) -> str:
    prefix = f"[{country.name}] " if country is not None else ""
    trailing_bits: list[str] = []
    if tone is not None:
        trailing_bits.append(f"tone {tone:+.1f}")
    if domain:
        trailing_bits.append(domain)
    trailing = f" ({', '.join(trailing_bits)})" if trailing_bits else ""
    summary = f"{prefix}{title}{trailing}"
    return summary[:320]


def _parse_gdelt_date(value: Any) -> datetime | None:
    if value is None:
        return None
    text = str(value)
    if len(text) == 16 and text.endswith("Z"):
        try:
            return datetime.strptime(text, "%Y%m%dT%H%M%SZ").replace(
                tzinfo=timezone.utc
            )
        except ValueError:
            return None
    try:
        stamp = datetime.fromisoformat(text)
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return stamp
    except ValueError:
        return None


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _domain_of(url: str | None) -> str | None:
    if not url:
        return None
    try:
        return urlparse(url).netloc or None
    except ValueError:
        return None


def _short_hash(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:10]


def _dedupe(*parts: Any) -> str:
    token = "|".join(str(p) for p in parts)
    return hashlib.sha1(token.encode("utf-8")).hexdigest()[:16]


def _synthetic_news_articles() -> list[dict[str, Any]]:
    """Deterministic offline fallback used when GDELT is unreachable."""

    base = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return [
        {
            "title": "Port operations disrupted in Singapore after container backlog widens",
            "url": "https://example.com/news/sin-port-delay",
            "sourcecountry": "Singapore",
            "domain": "example.com",
            "seendate": base,
            "language": "eng",
            "tone": -3.2,
        },
        {
            "title": "Severe storm warning issued across southern Japan ahead of landfall",
            "url": "https://example.com/news/jp-storm-warning",
            "sourcecountry": "Japan",
            "domain": "example.com",
            "seendate": base,
            "language": "eng",
            "tone": -2.8,
        },
        {
            "title": "Airspace closure near eastern Ukraine prompts airline rerouting",
            "url": "https://example.com/news/ua-airspace",
            "sourcecountry": "Ukraine",
            "domain": "example.com",
            "seendate": base,
            "language": "eng",
            "tone": -4.1,
        },
        {
            "title": "Drought tariff dispute escalates between Morocco and EU importers",
            "url": "https://example.com/news/ma-tariff",
            "sourcecountry": "Morocco",
            "domain": "example.com",
            "seendate": base,
            "language": "eng",
            "tone": -1.4,
        },
        {
            "title": "Red Sea shipping delays continue as carriers reroute around Cape",
            "url": "https://example.com/news/red-sea",
            "sourcecountry": "Egypt",
            "domain": "example.com",
            "seendate": base,
            "language": "eng",
            "tone": -2.1,
        },
    ]


__all__ = ["NewsAdapter"]
