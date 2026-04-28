"""Bridge from :class:`ResolvedPlace` to the wire-shape :class:`PlaceScope`.

Phase 12.3 — the ``PlaceScope`` model is the single canonical place contract
shared by:

* the agent service (``AgentQueryService``) — to scope retrieval / ranking
* the analyst UI (``QueryPanel``) — to show resolved place + fallback notice
* future portfolio + graph layers (Phase 13+) — every node anchors here

Keeping the converter free of service / route imports avoids circular deps
and lets tests instantiate ``PlaceScope`` from a ``ResolvedPlace`` directly.
"""

from __future__ import annotations

from app.intelligence.geo.resolver import ResolvedPlace
from app.intelligence.schemas import MacroContext, PlaceScope


def macro_context_from_resolved(resolved: ResolvedPlace) -> MacroContext | None:
    """Project the resolver's :class:`MacroProfile` onto the wire shape."""

    macro = resolved.macro_profile
    if macro is None:
        return None

    top_export = _top_pair(macro.commodity_export_sensitivity)
    top_import = _top_pair(macro.commodity_import_sensitivity)

    return MacroContext(
        country_code=macro.country_code,
        currency_code=macro.currency_code,
        logistics_hub=macro.logistics_hub,
        sector_tags=list(macro.sector_tags[:4]),
        top_export_commodity=top_export[0] if top_export else None,
        top_export_sensitivity=top_export[1] if top_export else None,
        top_import_commodity=top_import[0] if top_import else None,
        top_import_sensitivity=top_import[1] if top_import else None,
        trade_dependence_score=round(macro.trade_dependence_score, 3),
        shipping_exposure=round(macro.shipping_exposure, 3),
    )


def place_scope_from_resolved(resolved: ResolvedPlace) -> PlaceScope:
    """Convert a :class:`ResolvedPlace` into the wire-shape :class:`PlaceScope`.

    Always returns a ``PlaceScope`` — even for ``fallback_level == "none"`` so
    the UI can render a uniform "we couldn't resolve this" state.
    """

    place = resolved.place
    parent = resolved.parent
    macro = macro_context_from_resolved(resolved)

    return PlaceScope(
        query=resolved.query,
        place_id=place.id if place else None,
        name=place.name if place else None,
        type=place.type if place else None,
        country_code=resolved.country_code,
        country_name=resolved.country_name,
        parent_id=parent.id if parent else None,
        parent_name=parent.name if parent else None,
        latitude=resolved.latitude,
        longitude=resolved.longitude,
        bbox=place.bbox if place else None,
        aliases=list(place.aliases) if place else [],
        tags=list(place.tags) if place else [],
        fallback_level=resolved.fallback_level,
        is_fallback=resolved.is_fallback,
        confidence=round(resolved.confidence, 3),
        macro_context=macro,
        source="place_resolver",
    )


def _top_pair(weights: dict[str, float]) -> tuple[str, float] | None:
    if not weights:
        return None
    name, value = max(weights.items(), key=lambda item: item[1])
    if value <= 0:
        return None
    return name, round(float(value), 3)


__all__ = [
    "macro_context_from_resolved",
    "place_scope_from_resolved",
]
