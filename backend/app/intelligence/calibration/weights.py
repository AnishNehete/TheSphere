"""Reloadable ranking weights config (Phase 18B, Part 6).

The weights file is a tiny YAML document at ``ranking_weights.yaml``.
Both the reranker and the confidence calibrator consume the same loaded
:class:`RankingWeights` instance, so analysts can tune ranking + trust in
lockstep without restarting the service.

Reload semantics:

* :class:`WeightsLoader` keeps the file path and the last-known mtime.
* :meth:`WeightsLoader.current` re-reads the file if mtime changed since
  the last call. Otherwise the cached instance is returned.
* The file may go missing — a :class:`RankingWeights` default falls back
  to the defaults baked into this module, never raises.
* Invalid YAML or out-of-range values fall back to defaults with a
  warning log; we never serve a half-tuned config that could surprise
  analysts mid-investigation.

Validation:

* All weights are ``[0.0, 1.0]``.
* The four ranking weights (freshness/severity/geo/diversity/semantic)
  are *not* required to sum to 1 — the reranker normalises by their sum
  internally so analysts can express preferences in absolute terms.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field, replace
from pathlib import Path
from threading import Lock
from typing import Any, Mapping


logger = logging.getLogger(__name__)


_DEFAULT_FRESHNESS_WEIGHT = 0.35
_DEFAULT_SEVERITY_WEIGHT = 0.25
_DEFAULT_GEO_WEIGHT = 0.20
_DEFAULT_DIVERSITY_WEIGHT = 0.10
_DEFAULT_SEMANTIC_WEIGHT = 0.10
_DEFAULT_RECENCY_HALF_LIFE_HOURS = 6.0


@dataclass(frozen=True, slots=True)
class RankingWeights:
    """Knobs that control rerank() and confidence calibration."""

    freshness_weight: float = _DEFAULT_FRESHNESS_WEIGHT
    severity_weight: float = _DEFAULT_SEVERITY_WEIGHT
    geo_weight: float = _DEFAULT_GEO_WEIGHT
    diversity_weight: float = _DEFAULT_DIVERSITY_WEIGHT
    semantic_weight: float = _DEFAULT_SEMANTIC_WEIGHT
    recency_half_life_hours: float = _DEFAULT_RECENCY_HALF_LIFE_HOURS
    # Confidence calibration knobs — all 0..1
    confidence_evidence_weight: float = 0.30
    confidence_agreement_weight: float = 0.20
    confidence_recency_weight: float = 0.20
    confidence_diversity_weight: float = 0.15
    confidence_resolution_weight: float = 0.15

    @property
    def ranking_weight_sum(self) -> float:
        return (
            self.freshness_weight
            + self.severity_weight
            + self.geo_weight
            + self.diversity_weight
            + self.semantic_weight
        ) or 1.0

    @property
    def confidence_weight_sum(self) -> float:
        return (
            self.confidence_evidence_weight
            + self.confidence_agreement_weight
            + self.confidence_recency_weight
            + self.confidence_diversity_weight
            + self.confidence_resolution_weight
        ) or 1.0

    def to_dict(self) -> dict[str, float]:
        return {
            "freshness_weight": self.freshness_weight,
            "severity_weight": self.severity_weight,
            "geo_weight": self.geo_weight,
            "diversity_weight": self.diversity_weight,
            "semantic_weight": self.semantic_weight,
            "recency_half_life_hours": self.recency_half_life_hours,
            "confidence_evidence_weight": self.confidence_evidence_weight,
            "confidence_agreement_weight": self.confidence_agreement_weight,
            "confidence_recency_weight": self.confidence_recency_weight,
            "confidence_diversity_weight": self.confidence_diversity_weight,
            "confidence_resolution_weight": self.confidence_resolution_weight,
        }


def default_weights() -> RankingWeights:
    return RankingWeights()


def _coerce_float(value: Any, fallback: float, *, low: float, high: float) -> float:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return fallback
    if f < low or f > high:
        return fallback
    return f


def _from_mapping(payload: Mapping[str, Any]) -> RankingWeights:
    base = default_weights()
    return RankingWeights(
        freshness_weight=_coerce_float(
            payload.get("freshness_weight"),
            base.freshness_weight,
            low=0.0,
            high=1.0,
        ),
        severity_weight=_coerce_float(
            payload.get("severity_weight"),
            base.severity_weight,
            low=0.0,
            high=1.0,
        ),
        geo_weight=_coerce_float(
            payload.get("geo_weight"), base.geo_weight, low=0.0, high=1.0
        ),
        diversity_weight=_coerce_float(
            payload.get("diversity_weight"),
            base.diversity_weight,
            low=0.0,
            high=1.0,
        ),
        semantic_weight=_coerce_float(
            payload.get("semantic_weight"),
            base.semantic_weight,
            low=0.0,
            high=1.0,
        ),
        recency_half_life_hours=_coerce_float(
            payload.get("recency_half_life_hours"),
            base.recency_half_life_hours,
            low=0.1,
            high=24.0 * 30,
        ),
        confidence_evidence_weight=_coerce_float(
            payload.get("confidence_evidence_weight"),
            base.confidence_evidence_weight,
            low=0.0,
            high=1.0,
        ),
        confidence_agreement_weight=_coerce_float(
            payload.get("confidence_agreement_weight"),
            base.confidence_agreement_weight,
            low=0.0,
            high=1.0,
        ),
        confidence_recency_weight=_coerce_float(
            payload.get("confidence_recency_weight"),
            base.confidence_recency_weight,
            low=0.0,
            high=1.0,
        ),
        confidence_diversity_weight=_coerce_float(
            payload.get("confidence_diversity_weight"),
            base.confidence_diversity_weight,
            low=0.0,
            high=1.0,
        ),
        confidence_resolution_weight=_coerce_float(
            payload.get("confidence_resolution_weight"),
            base.confidence_resolution_weight,
            low=0.0,
            high=1.0,
        ),
    )


def load_weights_from_path(path: Path) -> RankingWeights:
    """Best-effort YAML load. Missing / invalid file ⇒ defaults."""

    if not path.exists():
        return default_weights()
    try:
        import yaml  # type: ignore[import-untyped]
    except ImportError:  # pragma: no cover - dependency pinned in pyproject
        logger.warning(
            "calibration.weights pyyaml not installed; using defaults"
        )
        return default_weights()
    try:
        text = path.read_text(encoding="utf-8")
        payload = yaml.safe_load(text) or {}
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(
            "calibration.weights failed to read %s: %s; using defaults",
            path,
            exc,
        )
        return default_weights()
    if not isinstance(payload, Mapping):
        logger.warning(
            "calibration.weights %s is not a mapping; using defaults", path
        )
        return default_weights()
    return _from_mapping(payload)


@dataclass(slots=True)
class _WeightsCache:
    weights: RankingWeights
    mtime: float | None


class WeightsLoader:
    """Hot-reloads :class:`RankingWeights` from a YAML file.

    Calling :meth:`current` re-reads the file when its mtime advances.
    Concurrent reads are serialised with a lock so a partial reload
    cannot expose half-applied weights.
    """

    def __init__(
        self,
        *,
        path: str | os.PathLike[str] | None = None,
        initial: RankingWeights | None = None,
    ) -> None:
        self._path = Path(path) if path else None
        self._lock = Lock()
        self._cache = _WeightsCache(
            weights=initial or default_weights(),
            mtime=None,
        )
        if self._path is not None and self._path.exists():
            try:
                self._cache.mtime = self._path.stat().st_mtime
                self._cache.weights = load_weights_from_path(self._path)
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning(
                    "calibration.weights initial load failed: %s; using defaults",
                    exc,
                )

    @property
    def path(self) -> Path | None:
        return self._path

    def current(self) -> RankingWeights:
        if self._path is None:
            return self._cache.weights
        try:
            mtime = self._path.stat().st_mtime if self._path.exists() else None
        except OSError as exc:  # pragma: no cover - defensive
            logger.warning(
                "calibration.weights stat failed: %s; using cached weights",
                exc,
            )
            return self._cache.weights
        if mtime is None:
            return self._cache.weights
        if self._cache.mtime is not None and mtime <= self._cache.mtime:
            return self._cache.weights
        with self._lock:
            # Re-check inside the lock so concurrent callers don't double-load.
            if self._cache.mtime is not None and mtime <= self._cache.mtime:
                return self._cache.weights
            new_weights = load_weights_from_path(self._path)
            self._cache = _WeightsCache(weights=new_weights, mtime=mtime)
            logger.info(
                "calibration.weights reloaded from %s", self._path
            )
            return new_weights

    def override(self, weights: RankingWeights) -> None:
        """Replace the in-memory weights without touching the YAML file.

        Used by the admin ``/tune`` simulation path so a tentative
        weight set can be evaluated against the query log without
        committing it to disk.
        """

        with self._lock:
            self._cache = replace(self._cache, weights=weights)


__all__ = [
    "RankingWeights",
    "WeightsLoader",
    "default_weights",
    "load_weights_from_path",
]
