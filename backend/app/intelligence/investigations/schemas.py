"""Frozen pydantic shapes for the Saved Investigations module (Phase 17B).

A :class:`SavedInvestigation` is a snapshot of the canonical workspace
state at one instant in time. The snapshot composes typed shapes that
already exist elsewhere — :class:`MarketPosture`, :class:`MarketNarrative`,
compare targets, etc. — so this module never invents a new canonical
state model. On restore the frontend hydrates the existing canonical
stores; nothing new is added to the state contract.

Honest-data rules enforced here:

* ``captured_at`` is mandatory and is the source of truth for "how old is
  this snapshot" on restore.
* ``provider_health_at_capture`` and ``freshness_seconds_at_capture``
  freeze the conditions under which the snapshot was taken so the share
  / restore surface can be labeled honestly.
* The frozen envelope means restoring a snapshot is *deterministic* —
  the snapshot is never silently re-derived from live data. A separate
  "Refresh live" action (frontend) re-fetches the live posture / narrative
  and the UI labels both copies.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.intelligence.portfolio.posture.narrative import MarketNarrative
from app.intelligence.portfolio.posture.schemas import (
    AssetClass,
    MarketPosture,
    ProviderHealth,
)


SavedWorkspaceMode = Literal["investigate", "compare", "portfolio", "replay"]


class CompareTargetSnapshot(BaseModel):
    """Frozen mirror of the frontend ``CompareTargetSelection`` shape.

    Kept here (rather than imported from a frontend type) so the backend
    has a typed contract for the persisted compare set.
    """

    model_config = ConfigDict(frozen=True)

    kind: Literal["country", "event"]
    id: str
    label: str
    country_code: str | None = None


class WorkspaceSelectionSnapshot(BaseModel):
    """Captures which canonical entity the workspace was focused on.

    All fields are optional so a snapshot can describe a Portfolio-mode
    or Compare-mode investigation that has no single country / event /
    market focus. The frontend snapshot builder fills in only what the
    canonical store actually held at save time.
    """

    model_config = ConfigDict(frozen=True)

    country_code: str | None = None
    country_name: str | None = None
    event_id: str | None = None
    event_summary: str | None = None
    market_symbol: str | None = None
    market_asset_class: AssetClass | None = None


class SavedInvestigationSnapshot(BaseModel):
    """The body of a saved investigation — the frozen workspace state.

    Composed of typed shapes from elsewhere in the system. The snapshot
    is intentionally tolerant of missing pieces (e.g. ``market_posture``
    is ``None`` for a country-only investigation). What *is* mandatory:
    ``workspace_mode``, ``selection``, ``captured_at``,
    ``provider_health_at_capture``.
    """

    model_config = ConfigDict(frozen=True)

    workspace_mode: SavedWorkspaceMode
    selection: WorkspaceSelectionSnapshot

    market_posture: MarketPosture | None = None
    market_narrative: MarketNarrative | None = None

    portfolio_id: str | None = None
    portfolio_as_of: datetime | None = None

    compare_targets: list[CompareTargetSnapshot] = Field(default_factory=list)

    caveats: list[str] = Field(default_factory=list)
    provider_health_at_capture: ProviderHealth = "unconfigured"
    freshness_seconds_at_capture: int | None = None

    captured_at: datetime


class SavedInvestigationCreate(BaseModel):
    """User-supplied save request body."""

    model_config = ConfigDict(frozen=True)

    name: str = Field(..., min_length=1, max_length=120)
    snapshot: SavedInvestigationSnapshot


class SavedInvestigation(BaseModel):
    """Persisted record returned by the repository / service."""

    model_config = ConfigDict(frozen=False)

    id: str
    name: str
    created_at: datetime
    snapshot: SavedInvestigationSnapshot
    share_token: str | None = None


class SavedInvestigationListItem(BaseModel):
    """Lightweight list view used by the saved-investigations menu.

    Strips heavy snapshot fields (posture, narrative) so a long list of
    saved investigations does not bloat every listing response. The
    detail endpoint returns the full :class:`SavedInvestigation`.
    """

    model_config = ConfigDict(frozen=True)

    id: str
    name: str
    created_at: datetime
    captured_at: datetime
    workspace_mode: SavedWorkspaceMode
    primary_label: str
    has_share: bool


__all__ = [
    "CompareTargetSnapshot",
    "SavedInvestigation",
    "SavedInvestigationCreate",
    "SavedInvestigationListItem",
    "SavedInvestigationSnapshot",
    "SavedWorkspaceMode",
    "WorkspaceSelectionSnapshot",
]
