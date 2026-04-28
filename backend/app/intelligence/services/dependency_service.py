"""Dependency reasoning service.

Phase 12C — given a focal country or event, emit ranked downstream paths with
explicit rationale and evidence links. The whole service is rule-based: every
edge comes from a named template so the UI (and any later LLM) can inspect
why a path was proposed. No opaque graph model; adding a new template is a
single list append.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Sequence

from app.intelligence.adapters.country_lookup import lookup_by_alpha3
from app.intelligence.geo.place_templates import build_place_templates
from app.intelligence.geo.resolver import (
    PlaceResolver,
    ResolvedPlace,
    place_resolver as default_place_resolver,
)
from app.intelligence.repositories.event_repository import EventRepository
from app.intelligence.schemas import (
    DependencyEdge,
    DependencyNode,
    DependencyPath,
    DependencyResponse,
    SignalEvent,
)


logger = logging.getLogger(__name__)


@dataclass(slots=True, frozen=True)
class _TemplateHit:
    title: str
    nodes: list[DependencyNode]
    edges: list[DependencyEdge]
    confidence: float
    rationale: str


class DependencyService:
    """Build dependency paths from rule-based templates."""

    def __init__(
        self,
        *,
        repository: EventRepository,
        max_paths: int = 4,
        place_resolver: PlaceResolver | None = None,
    ) -> None:
        self._repository = repository
        self._max_paths = max_paths
        self._place_resolver = place_resolver or default_place_resolver

    async def for_country(self, code: str) -> DependencyResponse:
        code_upper = code.upper()
        meta = lookup_by_alpha3(code_upper)
        events = await self._repository.by_country(code_upper, limit=40)
        events = [e for e in events if e.severity_score >= 0.35]
        events.sort(key=lambda e: e.severity_score, reverse=True)

        paths: list[DependencyPath] = []
        for event in events[:6]:
            template = _template_for(event, focal_country=code_upper)
            if template is None:
                continue
            paths.append(
                DependencyPath(
                    id=f"dep-{event.id}",
                    title=template.title,
                    nodes=template.nodes,
                    edges=template.edges,
                    focal_event_id=event.id,
                    focal_country_code=code_upper,
                    overall_confidence=round(template.confidence, 3),
                    rationale=template.rationale,
                )
            )
            if len(paths) >= self._max_paths:
                break

        # Layer place-driven templates (currency / commodities / logistics /
        # sectors) on top — these don't require a focal event, so they
        # surface even when the event feed is quiet.
        resolved = self._place_resolver.resolve(meta.name if meta else code_upper)
        if resolved.place is not None:
            for place_template in build_place_templates(resolved):
                if len(paths) >= self._max_paths * 2:
                    break
                paths.append(
                    place_template.to_path(
                        focal_event_id=None,
                        focal_country_code=code_upper,
                    )
                )

        return DependencyResponse(
            generated_at=datetime.now(timezone.utc),
            focal_country_code=code_upper,
            paths=paths,
        )

    async def for_place(
        self,
        query_or_resolved: str | ResolvedPlace,
    ) -> DependencyResponse:
        """Build place-driven dependency paths for a free-text query.

        Callers can pass either a raw query string (``"Tokyo"``, ``"Red Sea"``)
        or a pre-resolved :class:`ResolvedPlace`. The response surfaces the
        ``fallback_level`` so UI / analyst tools know whether the answer is
        grounded on an exact match or a country / region fallback.
        """

        if isinstance(query_or_resolved, ResolvedPlace):
            resolved = query_or_resolved
        else:
            resolved = self._place_resolver.resolve(query_or_resolved)

        country_code = resolved.country_code

        # Pull a small slab of severity-ranked events for the country so we
        # can attach real evidence IDs to the first edge of each chain when
        # the country has active signal.
        focal_event_id: str | None = None
        evidence_ids: list[str] = []
        if country_code:
            events = await self._repository.by_country(country_code, limit=25)
            events = [e for e in events if e.severity_score >= 0.4]
            events.sort(key=lambda e: e.severity_score, reverse=True)
            top = events[:3]
            if top:
                focal_event_id = top[0].id
                evidence_ids = [e.id for e in top]

        templates = build_place_templates(
            resolved,
            focal_event_id=focal_event_id,
            evidence_ids=evidence_ids,
        )
        paths = [
            template.to_path(
                focal_event_id=focal_event_id,
                focal_country_code=country_code,
            )
            for template in templates[: self._max_paths * 2]
        ]

        return DependencyResponse(
            generated_at=datetime.now(timezone.utc),
            focal_country_code=country_code,
            focal_event_id=focal_event_id,
            paths=paths,
        )

    async def for_event(self, event_id: str) -> DependencyResponse:
        event = await self._repository.get(event_id)
        if event is None:
            return DependencyResponse(
                generated_at=datetime.now(timezone.utc),
                focal_event_id=event_id,
                paths=[],
            )
        focal_country = event.place.country_code
        template = _template_for(event, focal_country=focal_country)
        paths: list[DependencyPath] = []
        if template is not None:
            paths.append(
                DependencyPath(
                    id=f"dep-{event.id}",
                    title=template.title,
                    nodes=template.nodes,
                    edges=template.edges,
                    focal_event_id=event.id,
                    focal_country_code=focal_country,
                    overall_confidence=round(template.confidence, 3),
                    rationale=template.rationale,
                )
            )
        return DependencyResponse(
            generated_at=datetime.now(timezone.utc),
            focal_event_id=event.id,
            focal_country_code=focal_country,
            paths=paths,
        )


def _template_for(
    event: SignalEvent, *, focal_country: str | None
) -> _TemplateHit | None:
    title = event.title.lower()
    sub_type = (event.sub_type or "").lower()
    country = focal_country or event.place.country_code
    country_label = event.place.country_name or country or "focal region"
    evidence = [event.id]

    # ---- WEATHER -------------------------------------------------------------
    if event.type == "weather":
        if sub_type == "seismic" or "earthquake" in title:
            return _chain(
                title=f"Seismic activity → logistics → equities ({country_label})",
                nodes_spec=[
                    ("weather", f"Seismic event · {country_label}", country, event.id),
                    ("logistics", "Port & overland logistics", country, None),
                    ("supply_chain", "Regional supply chain", country, None),
                    ("equities", "Exposed equities", None, None),
                ],
                edge_rules=[
                    ("impacts", "Seismic events physically disrupt port handling and road throughput.", 0.75),
                    ("delays", "Container backlogs propagate up regional supply chains.", 0.55),
                    ("pressures", "Supply constraint compresses margins for exposed listed names.", 0.45),
                ],
                overall=0.6,
                rationale="Seismic → logistics template. Matched event sub_type=seismic.",
                evidence=evidence,
            )
        if any(k in title for k in ("storm", "typhoon", "hurricane", "flood")):
            return _chain(
                title=f"Severe weather → flight ops → tourism ({country_label})",
                nodes_spec=[
                    ("weather", f"Severe weather · {country_label}", country, event.id),
                    ("flights", "Regional flight operations", country, None),
                    ("tourism", "Inbound tourism demand", country, None),
                ],
                edge_rules=[
                    ("disrupts", "Severe weather forces airspace restrictions and airport closures.", 0.72),
                    ("dampens", "Flight disruption compresses short-window travel & hospitality demand.", 0.5),
                ],
                overall=0.55,
                rationale="Severe-weather template. Matched storm/typhoon/hurricane/flood keywords.",
                evidence=evidence,
            )

    # ---- CONFLICT ------------------------------------------------------------
    if event.type == "conflict":
        return _chain(
            title=f"Conflict activity → shipping → oil → FX ({country_label})",
            nodes_spec=[
                ("conflict", f"Conflict · {country_label}", country, event.id),
                ("logistics", "Shipping lanes / airspace", country, None),
                ("oil", "Brent / regional crude", None, None),
                ("fx", "Safe-haven FX flows", None, None),
            ],
            edge_rules=[
                ("reroutes", "Conflict activity reshapes shipping lanes and airspace posture.", 0.68),
                ("tightens", "Rerouting lengthens supply, supporting crude prices.", 0.55),
                ("rotates", "Risk-off sentiment rotates capital into USD/CHF/JPY.", 0.45),
            ],
            overall=0.55,
            rationale="Conflict template. Route → oil → FX rotation.",
            evidence=evidence,
        )

    # ---- NEWS: severe-weather / shipping / aviation --------------------------
    if event.type == "news":
        if any(k in title for k in ("storm", "typhoon", "hurricane", "flood", "earthquake")):
            return _chain(
                title=f"Weather-shock news → flights → tourism ({country_label})",
                nodes_spec=[
                    ("news", f"Weather news · {country_label}", country, event.id),
                    ("flights", "Regional flight operations", country, None),
                    ("tourism", "Inbound travel demand", country, None),
                ],
                edge_rules=[
                    ("disrupts", "Severe-weather reporting presages airspace and airport restrictions.", 0.58),
                    ("dampens", "Reduced flight throughput compresses near-term travel & hospitality.", 0.45),
                ],
                overall=0.5,
                rationale="Severe-weather-in-news template.",
                evidence=evidence,
            )
        if any(k in title for k in ("port", "shipping", "container", "cargo", "strike")):
            return _chain(
                title=f"Logistics shock → commodities → exporter equities ({country_label})",
                nodes_spec=[
                    ("news", f"Logistics news · {country_label}", country, event.id),
                    ("supply_chain", "Cross-border container flow", country, None),
                    ("commodities", "Benchmark commodities", None, None),
                    ("equities", "Exporter equities", None, None),
                ],
                edge_rules=[
                    ("constrains", "Port or cargo disruption restricts physical throughput.", 0.6),
                    ("tightens", "Physical tightness transmits into spot commodity prices.", 0.5),
                    ("pressures", "Commodity spikes hit exporter input costs and guidance.", 0.4),
                ],
                overall=0.5,
                rationale="Logistics-shock news template.",
                evidence=evidence,
            )
        if any(k in title for k in ("airspace", "airport", "airline", "aviation")):
            return _chain(
                title=f"Aviation disruption → tourism → airline equities ({country_label})",
                nodes_spec=[
                    ("news", f"Aviation news · {country_label}", country, event.id),
                    ("flights", "Flight operations", country, None),
                    ("tourism", "Inbound travel demand", country, None),
                    ("equities", "Airline equities", None, None),
                ],
                edge_rules=[
                    ("disrupts", "Airspace/airport events reduce scheduled throughput.", 0.65),
                    ("dampens", "Flight caps depress near-term travel demand.", 0.5),
                    ("pressures", "Lower utilisation weighs on airline revenue.", 0.45),
                ],
                overall=0.52,
                rationale="Aviation-disruption news template.",
                evidence=evidence,
            )

    # ---- CURRENCY ------------------------------------------------------------
    if event.type == "currency":
        base = event.properties.get("base")
        quote = event.properties.get("quote")
        pair = event.properties.get("pair") or f"{base}/{quote}"
        return _chain(
            title=f"FX move {pair} → trade flows → equities",
            nodes_spec=[
                ("currency", f"FX · {pair}", None, event.id),
                ("fx", "Cross-border trade flows", None, None),
                ("equities", "Exporter / importer equities", None, None),
            ],
            edge_rules=[
                ("rebalances", "FX moves reprice cross-border trade flows in real time.", 0.6),
                ("pressures", "Exporters / importers see margin pressure on new fix.", 0.45),
            ],
            overall=0.48,
            rationale="FX-transmission template.",
            evidence=evidence,
        )

    # ---- STOCKS --------------------------------------------------------------
    if event.type == "stocks":
        symbol = event.properties.get("symbol") or "Equity"
        return _chain(
            title=f"{symbol} move → portfolio vol → hedge surface",
            nodes_spec=[
                ("stocks", f"{symbol}", None, event.id),
                ("equities", "Broader equity beta", None, None),
                ("fx", "Cross-asset vol / FX beta", None, None),
            ],
            edge_rules=[
                ("lifts", "Single-name moves raise portfolio realised vol.", 0.5),
                ("spills", "Vol spills into FX beta and hedge demand.", 0.35),
            ],
            overall=0.4,
            rationale="Single-name-vol template.",
            evidence=evidence,
        )

    # ---- COMMODITIES ---------------------------------------------------------
    if event.type == "commodities":
        return _chain(
            title="Commodity move → producer margins → equities",
            nodes_spec=[
                ("commodities", event.title, None, event.id),
                ("equities", "Producer / consumer equities", None, None),
            ],
            edge_rules=[
                ("pressures", "Commodity moves reset producer and consumer margin outlook.", 0.45),
            ],
            overall=0.42,
            rationale="Commodity-transmission template.",
            evidence=evidence,
        )

    return None


def _chain(
    *,
    title: str,
    nodes_spec: Sequence[tuple[str, str, str | None, str | None]],
    edge_rules: Sequence[tuple[str, str, float]],
    overall: float,
    rationale: str,
    evidence: Sequence[str],
) -> _TemplateHit:
    nodes: list[DependencyNode] = []
    for idx, (domain, label, country, event_id) in enumerate(nodes_spec):
        nodes.append(
            DependencyNode(
                id=f"n{idx}",
                domain=domain,  # type: ignore[arg-type]
                label=label,
                country_code=country,
                event_id=event_id,
            )
        )
    edges: list[DependencyEdge] = []
    for idx, (relation, edge_rationale, edge_conf) in enumerate(edge_rules):
        if idx + 1 >= len(nodes):
            break
        edges.append(
            DependencyEdge(
                from_id=nodes[idx].id,
                to_id=nodes[idx + 1].id,
                relation=relation,
                rationale=edge_rationale,
                confidence=round(edge_conf, 3),
                # only the first edge is directly grounded on the focal event;
                # subsequent edges are template inferences, so they don't claim
                # authorship of that specific evidence.
                evidence_ids=list(evidence) if idx == 0 else [],
            )
        )
    return _TemplateHit(
        title=title,
        nodes=nodes,
        edges=edges,
        confidence=round(overall, 3),
        rationale=rationale,
    )


__all__ = ["DependencyService"]
