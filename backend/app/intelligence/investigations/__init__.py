"""Saved Investigations module (Phase 17B).

Persists snapshots of the canonical investigation workspace state so an
analyst can reopen a grounded investigation later or share it read-only
through an unguessable token. The persistence layer is in-memory for
17B; the repository protocol is pinned so a Postgres-backed swap can land
in a later phase without touching service or route code.

Hard rules from the phase brief:

* No new canonical state model — snapshots are composed from the typed
  shapes the rest of the system already exposes (``MarketPosture``,
  ``MarketNarrative``, ``CompareTargetSnapshot``, etc.).
* The deterministic posture + bounded narrative contracts are preserved
  verbatim — saved snapshots freeze the typed envelope, never re-run
  the engines on restore.
* Honest freshness: ``captured_at`` and ``provider_health_at_capture``
  travel with every saved investigation so the UI can label restored
  views accurately and never silently pretend a snapshot is live.
"""

from app.intelligence.investigations.repository import (
    InMemoryInvestigationRepository,
    InvestigationNotFoundError,
    InvestigationRepository,
)
from app.intelligence.investigations.sql_repository import (
    SqlAlchemyInvestigationRepository,
)
from app.intelligence.investigations.schemas import (
    CompareTargetSnapshot,
    SavedInvestigation,
    SavedInvestigationCreate,
    SavedInvestigationListItem,
    SavedInvestigationSnapshot,
    SavedWorkspaceMode,
    WorkspaceSelectionSnapshot,
)
from app.intelligence.investigations.service import (
    InvestigationService,
    SavedInvestigationLimitError,
)

__all__ = [
    "CompareTargetSnapshot",
    "InMemoryInvestigationRepository",
    "InvestigationNotFoundError",
    "InvestigationRepository",
    "InvestigationService",
    "SavedInvestigation",
    "SavedInvestigationCreate",
    "SavedInvestigationLimitError",
    "SavedInvestigationListItem",
    "SavedInvestigationSnapshot",
    "SavedWorkspaceMode",
    "SqlAlchemyInvestigationRepository",
    "WorkspaceSelectionSnapshot",
]
