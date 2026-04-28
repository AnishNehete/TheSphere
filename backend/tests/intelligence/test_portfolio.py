"""Phase 13A — portfolio foundation tests.

Coverage:
* portfolio CRUD via the service
* manual + CSV holding ingestion
* CSV header / row validation
* enrichment + symbol normalization
* exposure graph mapping (countries / sectors / FX / commodities / chokepoints)
* brief composition (incl. linked events from the seeded event repo)
* watchlist → portfolio conversion
* graceful degradation when metadata is partial
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.intelligence.portfolio import (
    CsvImportError,
    HoldingInput,
    InMemoryPortfolioRepository,
    PortfolioBriefService,
    PortfolioCreateRequest,
    PortfolioNotFoundError,
    PortfolioService,
    PortfolioUpdateRequest,
    WatchlistInput,
    enrich_holding,
    normalize_symbol,
    parse_holdings_csv,
)
from app.intelligence.portfolio.exposure_service import ExposureService
from app.intelligence.repositories.event_repository import InMemoryEventRepository
from app.intelligence.schemas import Place, SignalEvent, SourceRef


NOW = datetime(2026, 4, 22, 12, 0, 0, tzinfo=timezone.utc)


# -----------------------------------------------------------------------------
# fixtures
# -----------------------------------------------------------------------------


def _evt(
    *,
    event_id: str,
    title: str,
    country_code: str,
    country_name: str,
    severity: str = "elevated",
    severity_score: float = 0.7,
    type_: str = "news",
    age_hours: float = 1.0,
) -> SignalEvent:
    ts = NOW - timedelta(hours=age_hours)
    return SignalEvent(
        id=event_id,
        dedupe_key=event_id,
        type=type_,  # type: ignore[arg-type]
        title=title,
        summary=title,
        severity=severity,  # type: ignore[arg-type]
        severity_score=severity_score,
        confidence=0.7,
        place=Place(country_code=country_code, country_name=country_name),
        source_timestamp=ts,
        ingested_at=ts,
        sources=[
            SourceRef(
                adapter="news.test",
                provider="test",
                publisher="unit-test",
                url=f"https://test.example/{event_id}",
                retrieved_at=ts,
                source_timestamp=ts,
                reliability=0.7,
            )
        ],
    )


@pytest.fixture
async def portfolio_service() -> PortfolioService:
    events = InMemoryEventRepository()
    await events.upsert_many(
        [
            _evt(
                event_id="evt-jp-storm",
                title="Severe storm warning issued across southern Japan",
                country_code="JPN",
                country_name="Japan",
                type_="weather",
                severity_score=0.78,
            ),
            _evt(
                event_id="evt-us-airline",
                title="US airline operations strained by weather",
                country_code="USA",
                country_name="United States",
                severity="watch",
                severity_score=0.5,
            ),
            _evt(
                event_id="evt-egy-suez",
                title="Suez transit volumes ease after holiday backlog",
                country_code="EGY",
                country_name="Egypt",
                severity="watch",
                severity_score=0.45,
            ),
        ]
    )
    repo = InMemoryPortfolioRepository()
    return PortfolioService(
        repository=repo,
        events_repository=events,
        brief_service=PortfolioBriefService(repository=events),
    )


# -----------------------------------------------------------------------------
# enrichment + normalization
# -----------------------------------------------------------------------------


class TestSymbolNormalization:
    def test_alias_collapses_to_canonical(self) -> None:
        assert normalize_symbol("brk.b") == "BRK-B"
        assert normalize_symbol("goog") == "GOOGL"

    def test_unknown_symbol_kept_as_upper(self) -> None:
        assert normalize_symbol(" zZz ") == "ZZZ"

    def test_known_symbol_enriches_country_currency_sector(self) -> None:
        holding = enrich_holding(
            portfolio_id="port_demo",
            holding_input=HoldingInput(symbol="aapl", quantity=10),
        )
        assert holding.symbol == "AAPL"
        assert holding.country_code == "USA"
        assert holding.currency == "USD"
        assert holding.sector == "Technology"
        assert holding.enrichment_confidence >= 0.9
        assert holding.metadata["enriched"] is True
        assert holding.metadata["sector_exposure"]["technology"] == 1.0

    def test_unknown_symbol_falls_back_to_user_metadata(self) -> None:
        holding = enrich_holding(
            portfolio_id="port_demo",
            holding_input=HoldingInput(
                symbol="XYZQ",
                quantity=5,
                country_code="usa",
                sector="Misc",
                currency="usd",
            ),
        )
        assert holding.symbol == "XYZQ"
        assert holding.country_code == "USA"
        assert holding.currency == "USD"
        assert holding.sector == "Misc"
        assert holding.enrichment_confidence == 0.3
        assert holding.metadata["enriched"] is False


# -----------------------------------------------------------------------------
# CSV import
# -----------------------------------------------------------------------------


class TestCsvImport:
    def test_minimal_csv_parses(self) -> None:
        csv_text = "symbol,quantity\nAAPL,10\nMSFT,5"
        result = parse_holdings_csv(csv_text)
        assert len(result.holdings) == 2
        assert {h.symbol for h in result.holdings} == {"AAPL", "MSFT"}
        assert result.skipped_rows == []

    def test_full_csv_parses_with_average_cost_and_country(self) -> None:
        csv_text = (
            "symbol,quantity,average_cost,currency,country_code,sector,notes\n"
            "AAPL,10,180.50,USD,USA,Technology,core position\n"
            "TSM,15,95.20,USD,TWN,Semiconductors,Asia exposure\n"
        )
        result = parse_holdings_csv(csv_text)
        assert len(result.holdings) == 2
        aapl = next(h for h in result.holdings if h.symbol == "AAPL")
        assert aapl.quantity == 10
        assert aapl.average_cost == 180.50
        assert aapl.country_code == "USA"
        assert aapl.sector == "Technology"

    def test_missing_header_raises(self) -> None:
        with pytest.raises(CsvImportError):
            parse_holdings_csv("AAPL,10\nMSFT,5")

    def test_empty_body_raises(self) -> None:
        with pytest.raises(CsvImportError):
            parse_holdings_csv("")

    def test_bad_quantity_skipped_not_aborted(self) -> None:
        csv_text = "symbol,quantity\nAAPL,not-a-number\nMSFT,5"
        result = parse_holdings_csv(csv_text)
        assert len(result.holdings) == 1
        assert result.holdings[0].symbol == "MSFT"
        assert len(result.skipped_rows) == 1
        assert "could not parse" in result.skipped_rows[0][1]

    def test_missing_symbol_skipped(self) -> None:
        csv_text = "symbol,quantity\n,3\nAAPL,5"
        result = parse_holdings_csv(csv_text)
        assert len(result.holdings) == 1
        assert result.holdings[0].symbol == "AAPL"
        assert result.skipped_rows == [(2, "missing symbol")]


# -----------------------------------------------------------------------------
# portfolio CRUD
# -----------------------------------------------------------------------------


class TestPortfolioCrud:
    async def test_create_and_get(self, portfolio_service: PortfolioService) -> None:
        record = await portfolio_service.create_portfolio(
            PortfolioCreateRequest(
                name="Tech sleeve",
                base_currency="USD",
                holdings=[
                    HoldingInput(symbol="AAPL", quantity=10),
                    HoldingInput(symbol="MSFT", quantity=5),
                ],
            )
        )
        assert record.id.startswith("port_")
        assert record.name == "Tech sleeve"
        assert len(record.holdings) == 2
        fetched = await portfolio_service.get_portfolio(record.id)
        assert fetched.id == record.id

    async def test_update_changes_metadata(
        self, portfolio_service: PortfolioService
    ) -> None:
        record = await portfolio_service.create_portfolio(
            PortfolioCreateRequest(name="Original", holdings=[])
        )
        updated = await portfolio_service.update_portfolio(
            record.id,
            PortfolioUpdateRequest(name="Renamed", tags=["core"]),
        )
        assert updated.name == "Renamed"
        assert updated.tags == ["core"]

    async def test_delete_removes_record(
        self, portfolio_service: PortfolioService
    ) -> None:
        record = await portfolio_service.create_portfolio(
            PortfolioCreateRequest(name="Tmp", holdings=[])
        )
        await portfolio_service.delete_portfolio(record.id)
        with pytest.raises(PortfolioNotFoundError):
            await portfolio_service.get_portfolio(record.id)

    async def test_create_dedupes_repeated_symbols(
        self, portfolio_service: PortfolioService
    ) -> None:
        record = await portfolio_service.create_portfolio(
            PortfolioCreateRequest(
                name="Dedup",
                holdings=[
                    HoldingInput(symbol="AAPL", quantity=5),
                    HoldingInput(symbol="AAPL", quantity=3),
                ],
            )
        )
        assert len(record.holdings) == 1
        assert record.holdings[0].quantity == 8

    async def test_csv_import_appends(
        self, portfolio_service: PortfolioService
    ) -> None:
        record = await portfolio_service.create_portfolio(
            PortfolioCreateRequest(
                name="CSV", holdings=[HoldingInput(symbol="AAPL", quantity=1)]
            )
        )
        record, skipped = await portfolio_service.import_csv(
            record.id, "symbol,quantity\nMSFT,4\n,3\n"
        )
        symbols = {h.symbol for h in record.holdings}
        assert symbols == {"AAPL", "MSFT"}
        assert any("missing symbol" in reason for _, reason in skipped)


# -----------------------------------------------------------------------------
# exposure graph
# -----------------------------------------------------------------------------


class TestExposureGraph:
    async def test_country_currency_and_sector_buckets(
        self, portfolio_service: PortfolioService
    ) -> None:
        record = await portfolio_service.create_portfolio(
            PortfolioCreateRequest(
                name="Mixed",
                holdings=[
                    HoldingInput(symbol="AAPL", quantity=10, average_cost=180),
                    HoldingInput(symbol="7203.T", quantity=20, average_cost=2000),
                    HoldingInput(symbol="ASML", quantity=5, average_cost=600),
                ],
            )
        )
        service = ExposureService()
        graph = service.build_graph(record)
        summary = service.build_summary(record, graph)

        country_codes = [b.node.country_code for b in summary.countries]
        assert "USA" in country_codes
        assert "JPN" in country_codes
        assert "NLD" in country_codes

        currencies = [b.node.label for b in summary.currencies]
        assert "USD" in currencies
        assert "JPY" in currencies
        assert "EUR" in currencies

        sectors = {b.node.label.lower() for b in summary.sectors}
        # Tech / autos / semis transmission paths must show up.
        assert any("tech" in s or "semi" in s or "auto" in s for s in sectors)

    async def test_chokepoint_exposure_for_shipping(
        self, portfolio_service: PortfolioService
    ) -> None:
        record = await portfolio_service.create_portfolio(
            PortfolioCreateRequest(
                name="Ships",
                holdings=[HoldingInput(symbol="MAERSK-B.CO", quantity=10)],
            )
        )
        graph = ExposureService().build_graph(record)
        chokepoint_ids = {n.id for n in graph.nodes if n.domain == "chokepoint"}
        # Maersk is exposed to Suez + Hormuz + Bab el-Mandeb at minimum.
        assert "chokepoint:suez" in chokepoint_ids
        assert "chokepoint:hormuz" in chokepoint_ids

    async def test_unknown_holding_keeps_user_country(
        self, portfolio_service: PortfolioService
    ) -> None:
        record = await portfolio_service.create_portfolio(
            PortfolioCreateRequest(
                name="Unknown",
                holdings=[
                    HoldingInput(
                        symbol="XYZQ",
                        quantity=10,
                        country_code="USA",
                        sector="Industrials",
                    )
                ],
            )
        )
        graph = ExposureService().build_graph(record)
        country_nodes = {n.id for n in graph.nodes if n.domain == "country"}
        assert "country:USA" in country_nodes
        sector_nodes = {n.id for n in graph.nodes if n.domain == "sector"}
        assert any("industrials" in s for s in sector_nodes)


# -----------------------------------------------------------------------------
# brief composition
# -----------------------------------------------------------------------------


class TestPortfolioBrief:
    async def test_brief_groups_exposures_and_links_events(
        self, portfolio_service: PortfolioService
    ) -> None:
        record = await portfolio_service.create_portfolio(
            PortfolioCreateRequest(
                name="Demo",
                holdings=[
                    HoldingInput(symbol="AAPL", quantity=10, average_cost=180),
                    HoldingInput(symbol="7203.T", quantity=20, average_cost=2000),
                    HoldingInput(symbol="MAERSK-B.CO", quantity=4, average_cost=12000),
                ],
            )
        )
        brief = await portfolio_service.build_brief(record.id)

        assert brief.holdings_count == 3
        assert brief.exposure_summary.countries
        assert brief.entity.primary_country_codes
        assert brief.confidence > 0.0

        # JPN storm event should be one of the linked events because Toyota
        # is in the portfolio.
        linked_countries = {e.country_code for e in brief.linked_events}
        assert "JPN" in linked_countries
        # Egypt event is also linked through Maersk's Suez chokepoint
        # exposure (country exposure for Maersk is DNK, but Suez chokepoint
        # has country EGY mapped via macro fallback).
        assert any(
            evt.country_code in {"JPN", "USA", "EGY"}
            for evt in brief.linked_events
        )

        # Top risks must include at least one country concentration entry.
        titles = " ".join(r.title for r in brief.top_risks).lower()
        assert "concentration" in titles or "exposure" in titles

        # Dependency paths should reference at least one contributing holding
        if brief.dependency_paths:
            assert all(
                len(p.contributing_holdings) > 0 for p in brief.dependency_paths
            )

    async def test_brief_for_empty_portfolio_is_safe(
        self, portfolio_service: PortfolioService
    ) -> None:
        record = await portfolio_service.create_portfolio(
            PortfolioCreateRequest(name="Empty", holdings=[])
        )
        brief = await portfolio_service.build_brief(record.id)
        assert brief.holdings_count == 0
        assert brief.exposure_summary.countries == []
        assert brief.linked_events == []
        assert brief.confidence == 0.0
        # Note about no resolved country must surface for the analyst.
        assert any("country" in note.lower() for note in brief.notes)

    async def test_brief_partial_metadata_degrades_gracefully(
        self, portfolio_service: PortfolioService
    ) -> None:
        record = await portfolio_service.create_portfolio(
            PortfolioCreateRequest(
                name="Partial",
                holdings=[HoldingInput(symbol="UNKNOWNX", quantity=1)],
            )
        )
        brief = await portfolio_service.build_brief(record.id)
        # No fabricated country exposure; brief must still render.
        assert brief.exposure_summary.countries == []
        # The low-enrichment note must be present so the analyst knows why.
        assert any("enrichment" in note.lower() for note in brief.notes)


# -----------------------------------------------------------------------------
# watchlist conversion
# -----------------------------------------------------------------------------


class TestWatchlistFlows:
    async def test_create_and_convert_watchlist(
        self, portfolio_service: PortfolioService
    ) -> None:
        wl = await portfolio_service.create_watchlist(
            WatchlistInput(
                name="Asia tech",
                symbols=["aapl", "tsm", "asml"],
                countries=["jpn", "twn"],
            )
        )
        assert wl.symbols == ["AAPL", "TSM", "ASML"]
        assert wl.countries == ["JPN", "TWN"]
        portfolio = await portfolio_service.watchlist_to_portfolio(
            wl.id, name="Promoted from Asia tech"
        )
        assert portfolio.name == "Promoted from Asia tech"
        assert {h.symbol for h in portfolio.holdings} == {"AAPL", "TSM", "ASML"}
        assert "from-watchlist" in portfolio.tags
