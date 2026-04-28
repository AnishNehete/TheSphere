"""Async orchestrator: deterministic posture → bounded narrative.

This service depends on the existing ``MarketPostureService`` to produce
the typed envelope, then layers the (optional) Anthropic narrative on
top. When ``ANTHROPIC_API_KEY`` is unset or any guardrail trips, the
deterministic narrative is returned with ``source="deterministic"``.
"""

from __future__ import annotations

import logging
from datetime import datetime

from app.intelligence.portfolio.posture.narrative import (
    NarrativeResponse,
    build_narrative_deterministic,
    build_narrative_with_anthropic,
)
from app.intelligence.portfolio.posture.schemas import AssetClass
from app.intelligence.portfolio.posture.service import MarketPostureService


logger = logging.getLogger(__name__)


class MarketNarrativeService:
    """Wraps the posture service with an explanation layer."""

    def __init__(
        self,
        *,
        posture_service: MarketPostureService,
        anthropic_api_key: str,
        anthropic_model: str,
        anthropic_base_url: str,
        anthropic_timeout_seconds: float,
    ) -> None:
        self._posture_service = posture_service
        self._api_key = anthropic_api_key
        self._model = anthropic_model
        self._base_url = anthropic_base_url
        self._timeout = anthropic_timeout_seconds

    async def build_for_symbol(
        self,
        symbol: str,
        *,
        asset_class: AssetClass = "unknown",
        as_of: datetime | None = None,
    ) -> NarrativeResponse:
        posture = await self._posture_service.build_for_symbol(
            symbol, asset_class=asset_class, as_of=as_of,
        )
        if not self._api_key:
            narrative = build_narrative_deterministic(posture)
        else:
            narrative = await build_narrative_with_anthropic(
                posture,
                api_key=self._api_key,
                model=self._model,
                base_url=self._base_url,
                timeout_seconds=self._timeout,
            )
        return NarrativeResponse(posture=posture, narrative=narrative)


__all__ = ["MarketNarrativeService"]
