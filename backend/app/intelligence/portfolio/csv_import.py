"""CSV → :class:`HoldingInput` parser.

Supports the smallest reasonable CSV that an analyst will actually paste:

    symbol,quantity,average_cost,currency,sector,country_code,notes

Header row is required. Whitespace and case are normalized. Unknown
columns are ignored, missing optional columns are tolerated. Errors are
collected per-row so the API can return a useful 400 instead of failing
on the first bad row.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from typing import Iterable

from app.intelligence.portfolio.schemas import HoldingInput


REQUIRED_COLUMNS = ("symbol",)
KNOWN_COLUMNS = (
    "symbol",
    "quantity",
    "average_cost",
    "avg_cost",
    "cost",
    "price",
    "currency",
    "sector",
    "country",
    "country_code",
    "asset_type",
    "exchange",
    "notes",
)


class CsvImportError(ValueError):
    """Raised when the CSV header is malformed."""


@dataclass(slots=True)
class CsvImportResult:
    holdings: list[HoldingInput] = field(default_factory=list)
    skipped_rows: list[tuple[int, str]] = field(default_factory=list)


def parse_holdings_csv(text: str) -> CsvImportResult:
    """Parse a CSV string into a :class:`CsvImportResult`.

    Raises :class:`CsvImportError` only when the header is missing or has
    no ``symbol`` column. Per-row errors are collected into
    ``skipped_rows`` so callers can render a "imported X, skipped Y" hint
    in the UI rather than dying on a single typo.
    """

    if not text or not text.strip():
        raise CsvImportError("CSV body is empty")

    reader = csv.DictReader(io.StringIO(text))
    fieldnames = [(f or "").strip().lower() for f in (reader.fieldnames or [])]
    if not fieldnames or "symbol" not in fieldnames:
        raise CsvImportError(
            "CSV header must include a 'symbol' column. "
            f"Known columns: {', '.join(KNOWN_COLUMNS)}"
        )

    result = CsvImportResult()
    for index, raw_row in enumerate(reader, start=2):  # 1 = header line
        row = {(k or "").strip().lower(): (v or "").strip() for k, v in raw_row.items()}
        symbol = row.get("symbol", "")
        if not symbol:
            result.skipped_rows.append((index, "missing symbol"))
            continue
        try:
            holding = _row_to_input(row)
        except ValueError as exc:
            result.skipped_rows.append((index, str(exc)))
            continue
        result.holdings.append(holding)

    return result


def _row_to_input(row: dict[str, str]) -> HoldingInput:
    quantity = _to_float(row.get("quantity", ""), default=0.0)
    if quantity < 0:
        raise ValueError("quantity must be non-negative")

    cost_raw = (
        row.get("average_cost")
        or row.get("avg_cost")
        or row.get("cost")
        or row.get("price")
        or ""
    )
    average_cost = _to_optional_float(cost_raw)
    if average_cost is not None and average_cost < 0:
        raise ValueError("average_cost must be non-negative")

    country = (row.get("country_code") or row.get("country") or "").upper() or None
    asset_type_raw = (row.get("asset_type") or "").lower().strip() or None
    if asset_type_raw and asset_type_raw not in {
        "equity", "etf", "adr", "bond", "fund", "commodity", "fx", "crypto", "cash", "other"
    }:
        # tolerate unknown asset_type rather than failing — fall back to default
        asset_type_raw = None

    return HoldingInput(
        symbol=row["symbol"].upper(),
        quantity=quantity,
        average_cost=average_cost,
        currency=(row.get("currency") or "").upper() or None,
        sector=row.get("sector") or None,
        country_code=country,
        asset_type=asset_type_raw,  # type: ignore[arg-type]
        exchange=row.get("exchange") or None,
        notes=row.get("notes") or None,
    )


def _to_float(value: str, *, default: float) -> float:
    cleaned = (value or "").replace(",", "").strip()
    if not cleaned:
        return default
    try:
        return float(cleaned)
    except ValueError as exc:
        raise ValueError(f"could not parse number: {value!r}") from exc


def _to_optional_float(value: str) -> float | None:
    cleaned = (value or "").replace(",", "").strip()
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError as exc:
        raise ValueError(f"could not parse number: {value!r}") from exc


__all__ = ["CsvImportError", "CsvImportResult", "parse_holdings_csv"]
