"""Sphere live intelligence backbone.

Owns live source ingestion, canonical normalization, deduplication, storage, and
analyst-facing query/aggregation services. The frontend consumes only the
normalized schemas exposed via :mod:`app.intelligence.routes` — raw provider
schemas never leak past the adapter layer.
"""
