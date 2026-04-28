"""Phase 18D — Causal Chain Intelligence Engine.

Turns a typed :class:`EvidenceBundle` into structured, evidence-backed
causal chains:

    signal -> mechanism -> affected domain -> downstream impact
        + direction + strength + confidence + caveats

Everything in this package is deterministic and side-effect free: no LLM,
no network, no agent framework. The bundle remains the single source of
truth — the chain builder *interprets* it through a rule registry; it
never invents facts.

Import policy
-------------
Only :mod:`app.intelligence.causal.model` is imported eagerly here — it
has no project-internal dependencies and can be safely loaded by any
schema module. :mod:`builder` and :mod:`rules` pull in the retrieval
package (entity resolver + evidence bundle), so they stay lazy to break
the schemas → causal → retrieval → schemas cycle.
"""

from app.intelligence.causal.model import (
    CausalChain,
    CausalChainSet,
    CausalDriver,
    CausalEdge,
    CausalMechanism,
    CausalNode,
    CausalNodeKind,
    ImpactDirection,
    ImpactDomain,
    ImpactStrength,
)


def __getattr__(name: str):
    """Lazy attribute access for the heavyweight builder + rules modules."""

    if name in ("CausalChainBuilder", "build_chain_set"):
        from app.intelligence.causal import builder as _builder

        return getattr(_builder, name)
    if name in ("CAUSAL_RULES", "CausalRule", "rules_for_entity"):
        from app.intelligence.causal import rules as _rules

        return getattr(_rules, name)
    if name in (
        "ExposureType",
        "ImpactedHolding",
        "PortfolioImpact",
        "build_portfolio_impact",
        "is_demo_portfolio",
    ):
        from app.intelligence.causal import portfolio_impact as _impact

        return getattr(_impact, name)
    raise AttributeError(f"module 'app.intelligence.causal' has no attribute {name!r}")


__all__ = [
    "CAUSAL_RULES",
    "CausalChain",
    "CausalChainBuilder",
    "CausalChainSet",
    "CausalDriver",
    "CausalEdge",
    "CausalMechanism",
    "CausalNode",
    "CausalNodeKind",
    "CausalRule",
    "ExposureType",
    "ImpactDirection",
    "ImpactDomain",
    "ImpactStrength",
    "ImpactedHolding",
    "PortfolioImpact",
    "build_chain_set",
    "build_portfolio_impact",
    "is_demo_portfolio",
    "rules_for_entity",
]
