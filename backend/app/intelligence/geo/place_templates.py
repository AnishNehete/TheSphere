"""Place-driven dependency templates.

The existing :mod:`app.intelligence.services.dependency_service` generates
event-driven templates (``seismic → logistics → equities``). These
place-driven templates complement those: given a resolved place plus its
macro profile, we emit reasoning paths along four deterministic axes:

* ``place → currency``    — the country's ISO currency
* ``place → commodities`` — dominant import / export sensitivities
* ``place → logistics``   — chokepoint / port / hub exposure
* ``place → sectors``     — sector transmission paths

Everything is rule-based. Each edge declares its rationale and a confidence
derived from the macro profile's exposure scores — no free-floating numbers.
Evidence IDs are only attached to the first edge of a chain when a specific
focal event grounded the reasoning (matching the convention in
``dependency_service._chain``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from app.intelligence.geo.gazetteer import Place
from app.intelligence.geo.macro_profiles import MacroProfile
from app.intelligence.geo.resolver import ResolvedPlace
from app.intelligence.schemas import DependencyEdge, DependencyNode, DependencyPath


@dataclass(frozen=True, slots=True)
class PlaceTemplate:
    """Intermediate representation of a place-driven reasoning path."""

    id_suffix: str
    title: str
    rationale: str
    overall_confidence: float
    nodes: tuple[DependencyNode, ...]
    edges: tuple[DependencyEdge, ...]

    def to_path(
        self,
        *,
        focal_event_id: str | None,
        focal_country_code: str | None,
    ) -> DependencyPath:
        return DependencyPath(
            id=f"place-{self.id_suffix}",
            title=self.title,
            nodes=list(self.nodes),
            edges=list(self.edges),
            focal_event_id=focal_event_id,
            focal_country_code=focal_country_code,
            overall_confidence=round(self.overall_confidence, 3),
            rationale=self.rationale,
        )


def build_place_templates(
    resolved: ResolvedPlace,
    *,
    focal_event_id: str | None = None,
    evidence_ids: Sequence[str] = (),
) -> list[PlaceTemplate]:
    """Build every place-driven template that applies to ``resolved``.

    Returns an empty list if the place didn't resolve or has no macro profile
    — callers should still check ``resolved.fallback_level`` if they want to
    gate templates behind a minimum resolution quality.
    """

    place = resolved.place
    macro = resolved.macro_profile
    country = resolved.country
    if place is None or macro is None or country is None:
        return []

    country_label = country.name
    templates: list[PlaceTemplate] = []

    currency_template = _currency_template(
        place=place,
        country=country,
        country_label=country_label,
        macro=macro,
        focal_evidence=list(evidence_ids),
    )
    if currency_template is not None:
        templates.append(currency_template)

    commodity_template = _commodity_template(
        place=place,
        country=country,
        country_label=country_label,
        macro=macro,
        focal_evidence=list(evidence_ids),
    )
    if commodity_template is not None:
        templates.append(commodity_template)

    logistics_template = _logistics_template(
        place=place,
        country=country,
        country_label=country_label,
        macro=macro,
        focal_evidence=list(evidence_ids),
    )
    if logistics_template is not None:
        templates.append(logistics_template)

    sector_template = _sector_template(
        place=place,
        country=country,
        country_label=country_label,
        macro=macro,
        focal_evidence=list(evidence_ids),
    )
    if sector_template is not None:
        templates.append(sector_template)

    return templates


# -----------------------------------------------------------------------------
# Individual templates
# -----------------------------------------------------------------------------


def _currency_template(
    *,
    place: Place,
    country: Place,
    country_label: str,
    macro: MacroProfile,
    focal_evidence: list[str],
) -> PlaceTemplate | None:
    if not macro.currency_code:
        return None

    trade_exposure = max(0.2, min(0.95, macro.trade_dependence_score))
    fx_conf = round(0.45 + 0.35 * trade_exposure, 3)
    trade_conf = round(0.30 + 0.45 * trade_exposure, 3)

    nodes = _make_nodes(
        (
            _node_spec("place", f"{place.name} ({place.type})", country.country_code, place.id),
            _node_spec("currency", f"{macro.currency_code} reference rate", country.country_code, None),
            _node_spec("fx", "Cross-border trade flows", country.country_code, None),
            _node_spec("equities", f"{country_label} exporter / importer equities", country.country_code, None),
        )
    )
    edges = _make_edges(
        nodes,
        (
            (
                "prices_in",
                f"{country_label}-linked activity repriced via {macro.currency_code}.",
                fx_conf,
                focal_evidence,
            ),
            (
                "rebalances",
                f"{macro.currency_code} moves reprice cross-border trade in real time "
                f"(trade-dependence {int(trade_exposure * 100)}%).",
                trade_conf,
                [],
            ),
            (
                "pressures",
                "Exporter / importer P&L migrates to the new fix.",
                round(trade_conf * 0.85, 3),
                [],
            ),
        ),
    )
    return PlaceTemplate(
        id_suffix=f"{place.id}:currency",
        title=f"{country_label} → {macro.currency_code} → trade flows",
        rationale=(
            f"Place → currency template. {country_label} transmits local shocks "
            f"through {macro.currency_code}; trade-dependence {macro.trade_dependence_score:.2f}."
        ),
        overall_confidence=round((fx_conf + trade_conf) / 2, 3),
        nodes=nodes,
        edges=edges,
    )


def _commodity_template(
    *,
    place: Place,
    country: Place,
    country_label: str,
    macro: MacroProfile,
    focal_evidence: list[str],
) -> PlaceTemplate | None:
    top_import = _top_sensitivity(macro.commodity_import_sensitivity)
    top_export = _top_sensitivity(macro.commodity_export_sensitivity)
    # Nothing to say if the country has no notable commodity exposure.
    if top_import is None and top_export is None:
        return None

    if top_export and (top_import is None or top_export[1] >= top_import[1]):
        commodity, exposure = top_export
        direction = "export"
        rationale_tail = (
            f"{country_label} is a key {commodity} exporter (sensitivity "
            f"{exposure:.2f}); disruption tightens global supply."
        )
    else:
        commodity, exposure = top_import  # type: ignore[misc]
        direction = "import"
        rationale_tail = (
            f"{country_label} depends on {commodity} imports (sensitivity "
            f"{exposure:.2f}); supply shocks hit domestic margins first."
        )

    commodity_label = commodity.replace("_", " ")
    channel_conf = round(0.35 + 0.45 * exposure, 3)

    nodes = _make_nodes(
        (
            _node_spec("place", f"{place.name} ({place.type})", country.country_code, place.id),
            _node_spec(
                "commodities",
                f"{commodity_label.title()} ({direction} channel)",
                None,
                None,
            ),
            _node_spec("equities", "Producer / consumer equities", None, None),
        )
    )
    edges = _make_edges(
        nodes,
        (
            (
                "transmits",
                rationale_tail,
                channel_conf,
                focal_evidence,
            ),
            (
                "pressures",
                f"{commodity_label.title()} moves reset producer / consumer margin outlook.",
                round(channel_conf * 0.85, 3),
                [],
            ),
        ),
    )
    return PlaceTemplate(
        id_suffix=f"{place.id}:commodity:{commodity}",
        title=f"{country_label} → {commodity_label} → equities",
        rationale=(
            f"Place → commodity template ({direction}). " + rationale_tail
        ),
        overall_confidence=channel_conf,
        nodes=nodes,
        edges=edges,
    )


def _logistics_template(
    *,
    place: Place,
    country: Place,
    country_label: str,
    macro: MacroProfile,
    focal_evidence: list[str],
) -> PlaceTemplate | None:
    # Strongest template when the place itself is a chokepoint / port / hub
    # country, or when the place sits inside a hub country.
    is_chokepoint = place.type == "chokepoint"
    is_port = place.type == "port"
    is_hub = macro.logistics_hub or macro.shipping_exposure >= 0.7
    if not (is_chokepoint or is_port or is_hub):
        return None

    if is_chokepoint:
        label = f"Transit through {place.name}"
        channel_conf = 0.78
        rationale = (
            f"{place.name} is a named shipping chokepoint; disruption forces "
            "vessel rerouting and inflates freight rates."
        )
    elif is_port:
        label = f"{place.name} throughput"
        channel_conf = round(0.55 + 0.3 * macro.shipping_exposure, 3)
        rationale = (
            f"{place.name} is a major container port; dwell times propagate "
            f"into regional supply chains (country shipping-exposure "
            f"{macro.shipping_exposure:.2f})."
        )
    else:
        label = f"{country_label} logistics throughput"
        channel_conf = round(0.40 + 0.4 * macro.shipping_exposure, 3)
        rationale = (
            f"{country_label} is a regional logistics hub "
            f"(shipping-exposure {macro.shipping_exposure:.2f}); local "
            "shocks propagate along global trade lanes."
        )

    nodes = _make_nodes(
        (
            _node_spec(
                "place",
                f"{place.name} ({place.type})",
                country.country_code,
                place.id,
            ),
            _node_spec("logistics", label, country.country_code, None),
            _node_spec("supply_chain", "Downstream supply chains", country.country_code, None),
            _node_spec("equities", "Exposed shipper / manufacturer equities", None, None),
        )
    )
    edges = _make_edges(
        nodes,
        (
            ("disrupts", rationale, channel_conf, focal_evidence),
            (
                "delays",
                "Throughput drops feed downstream supply chains within days.",
                round(channel_conf * 0.85, 3),
                [],
            ),
            (
                "pressures",
                "Supply constraint compresses exposed equity margins.",
                round(channel_conf * 0.75, 3),
                [],
            ),
        ),
    )
    return PlaceTemplate(
        id_suffix=f"{place.id}:logistics",
        title=f"{place.name} → logistics → supply chains",
        rationale=f"Place → logistics template. {rationale}",
        overall_confidence=channel_conf,
        nodes=nodes,
        edges=edges,
    )


def _sector_template(
    *,
    place: Place,
    country: Place,
    country_label: str,
    macro: MacroProfile,
    focal_evidence: list[str],
) -> PlaceTemplate | None:
    if not macro.sector_tags:
        return None
    sector = macro.sector_tags[0]
    sector_label = sector.replace("-", " ").replace("_", " ").title()
    # Sector confidence scales with export sensitivity when that sector is
    # also a listed export.
    export_hit = _sensitivity_for_sector(macro.commodity_export_sensitivity, sector)
    base_conf = 0.45 + 0.35 * (export_hit or macro.trade_dependence_score / 2)
    base_conf = round(min(0.80, base_conf), 3)

    nodes = _make_nodes(
        (
            _node_spec("place", f"{place.name} ({place.type})", country.country_code, place.id),
            _node_spec("equities", f"{country_label} {sector_label} cluster", country.country_code, None),
            _node_spec("equities", "Global peers & ETFs", None, None),
        )
    )
    edges = _make_edges(
        nodes,
        (
            (
                "transmits",
                f"{country_label}'s dominant cluster is {sector_label}; local "
                "activity moves cluster sentiment first.",
                base_conf,
                focal_evidence,
            ),
            (
                "spills",
                f"Global {sector_label} peers and sector ETFs track the move.",
                round(base_conf * 0.7, 3),
                [],
            ),
        ),
    )
    return PlaceTemplate(
        id_suffix=f"{place.id}:sector:{sector}",
        title=f"{country_label} → {sector_label} cluster → global peers",
        rationale=(
            f"Place → sector template. {country_label} cluster = "
            f"{', '.join(macro.sector_tags[:3])}."
        ),
        overall_confidence=base_conf,
        nodes=nodes,
        edges=edges,
    )


# -----------------------------------------------------------------------------
# helpers
# -----------------------------------------------------------------------------


def _node_spec(
    domain: str,
    label: str,
    country_code: str | None,
    event_id: str | None,
) -> tuple[str, str, str | None, str | None]:
    return (domain, label, country_code, event_id)


def _make_nodes(
    specs: Sequence[tuple[str, str, str | None, str | None]],
) -> tuple[DependencyNode, ...]:
    nodes: list[DependencyNode] = []
    for idx, (domain, label, country, event_id) in enumerate(specs):
        nodes.append(
            DependencyNode(
                id=f"n{idx}",
                domain=domain,  # type: ignore[arg-type]
                label=label,
                country_code=country,
                event_id=event_id,
            )
        )
    return tuple(nodes)


def _make_edges(
    nodes: Sequence[DependencyNode],
    rules: Sequence[tuple[str, str, float, Sequence[str]]],
) -> tuple[DependencyEdge, ...]:
    edges: list[DependencyEdge] = []
    for idx, (relation, rationale, conf, evidence) in enumerate(rules):
        if idx + 1 >= len(nodes):
            break
        edges.append(
            DependencyEdge(
                from_id=nodes[idx].id,
                to_id=nodes[idx + 1].id,
                relation=relation,
                rationale=rationale,
                confidence=round(max(0.0, min(1.0, conf)), 3),
                evidence_ids=list(evidence),
            )
        )
    return tuple(edges)


def _top_sensitivity(weights: dict[str, float]) -> tuple[str, float] | None:
    if not weights:
        return None
    name, value = max(weights.items(), key=lambda item: item[1])
    if value <= 0:
        return None
    return name, float(value)


def _sensitivity_for_sector(weights: dict[str, float], sector: str) -> float | None:
    """Return export sensitivity value for a sector-like key, if present."""

    for key, value in weights.items():
        if key.lower() == sector.lower():
            return float(value)
    return None


__all__ = [
    "PlaceTemplate",
    "build_place_templates",
]
