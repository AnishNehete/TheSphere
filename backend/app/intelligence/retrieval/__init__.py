"""Retrieval planning + orchestration (Phase 18A.1).

This package owns the deterministic substrate underneath the agent answer:

* :mod:`time_window`     — parse natural-language time hints into a typed window
* :mod:`compare_planner` — detect multi-entity compare intent and resolve legs
* :mod:`query_planner`   — combine intent + time + compare into a typed plan
* :mod:`evidence_bundle` — typed bundle the agent answer composer consumes
* :mod:`workers`         — bounded worker dispatch around existing services
* :mod:`orchestrator`    — runs the workers in order and assembles the bundle

The agent service is responsible for *prose* only; everything that needs
to be true (entities, time, evidence, compare snapshots, fallback notice)
lives in the bundle.
"""

from app.intelligence.retrieval.compare_planner import (
    ComparePlan,
    CompareTargetSpec,
    plan_compare,
)
from app.intelligence.retrieval.evidence_bundle import (
    CompareTargetSnapshot,
    EvidenceBundle,
    TimeContext,
)
from app.intelligence.retrieval.orchestrator import RetrievalOrchestrator
from app.intelligence.retrieval.query_planner import QueryPlan, QueryPlanner
from app.intelligence.retrieval.time_window import TimeWindow, parse_time_window

__all__ = [
    "ComparePlan",
    "CompareTargetSnapshot",
    "CompareTargetSpec",
    "EvidenceBundle",
    "QueryPlan",
    "QueryPlanner",
    "RetrievalOrchestrator",
    "TimeContext",
    "TimeWindow",
    "parse_time_window",
    "plan_compare",
]
