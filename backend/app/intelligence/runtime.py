"""Runtime container for the live intelligence backbone.

Instantiated once in ``app.main.create_app`` and stashed on ``app.state`` so
routes and background tasks share the same adapters, repository, and services.
Keeping this wiring in one place avoids sprinkling DI details across every
route module and makes the whole backbone easy to swap in tests.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Sequence

from app.intelligence.alerts import (
    AlertRepository,
    AlertService,
    InMemoryAlertRepository,
    RedisAlertRepository,
)
from app.intelligence.calibration import (
    CalibrationService,
    InMemoryQueryLogRepository,
    QueryLogRepository,
    SqlAlchemyQueryLogRepository,
    WeightsLoader,
)
from app.intelligence.investigations import (
    InMemoryInvestigationRepository,
    InvestigationRepository,
    InvestigationService,
    SqlAlchemyInvestigationRepository,
)
from app.intelligence.adapters import (
    CommoditiesAdapter,
    ConflictAdapter,
    CurrencyAdapter,
    DiseaseAdapter,
    FlightAdapter,
    MoodAdapter,
    NewsAdapter,
    SignalAdapter,
    StocksAdapter,
    WeatherAdapter,
)
from app.intelligence.portfolio import (
    ExposureService,
    InMemoryPortfolioRepository,
    PortfolioBriefService,
    PortfolioRepository,
    PortfolioService,
)
from app.intelligence.portfolio.market_data import (
    MarketDataProvider,
    build_market_data_provider,
)
from app.intelligence.portfolio.posture.narrative_service import (
    MarketNarrativeService,
)
from app.intelligence.portfolio.posture.service import MarketPostureService
from app.intelligence.portfolio.risk_service import (
    PortfolioRiskScoreService,
)
from app.intelligence.portfolio.semantic_service import (
    SemanticPressureService,
)
from app.intelligence.portfolio.technical_service import (
    TechnicalSnapshotService,
)
from app.intelligence.repositories.event_repository import (
    EventRepository,
    InMemoryEventRepository,
)
from app.intelligence.services import (
    AgentQueryService,
    CompareService,
    CountrySummaryService,
    DedupeService,
    DependencyService,
    IngestService,
    SearchService,
)
from app.settings import IntelligenceSettings, get_intelligence_settings


logger = logging.getLogger(__name__)


def _build_alert_repository(
    settings: IntelligenceSettings,
) -> AlertRepository:
    """Choose the alert repo implementation based on settings.

    ``redis_url`` set       → Redis-backed repo (durable + replicable).
    ``redis_url`` unset     → in-memory ring buffer (local dev / tests).
    Production mode (``env="production"``) without a Redis URL raises so
    we don't silently boot a non-replicable repo into a real environment.
    """

    redis_url = (settings.redis_url or "").strip()
    is_prod = (settings.env or "").lower() in ("production", "prod")
    if not redis_url:
        if is_prod:
            raise RuntimeError(
                "INTELLIGENCE_REDIS_URL is required in production. Alert "
                "buffering would not survive a restart or replicate "
                "across replicas without it."
            )
        logger.info(
            "intelligence.runtime redis_url unset; using in-memory "
            "alert repository"
        )
        return InMemoryAlertRepository()

    from app.cache import build_redis_client

    client = build_redis_client(redis_url)
    logger.info("intelligence.runtime using Redis alert repository")
    return RedisAlertRepository(client)


def _build_query_log_repository(
    settings: IntelligenceSettings,
) -> QueryLogRepository:
    """Choose the query-log repo implementation based on settings.

    ``database_url`` set     → Postgres-backed repo (durable across restarts).
    ``database_url`` unset   → in-memory repo (local dev / tests).

    Unlike investigations, the query log is not blocking for production:
    we tolerate an in-memory degraded mode even in production so a
    misconfigured DSN never takes down the live agent path. Any
    durability concerns are flagged via a warning log.
    """

    dsn = (settings.database_url or "").strip()
    if not dsn:
        logger.info(
            "intelligence.runtime database_url unset; using in-memory "
            "query log repository"
        )
        return InMemoryQueryLogRepository()

    from app.db import build_engine, build_session_factory

    engine = build_engine(dsn)
    session_factory = build_session_factory(engine)
    logger.info("intelligence.runtime using Postgres query log repository")
    return SqlAlchemyQueryLogRepository(session_factory=session_factory)


def _build_investigation_repository(
    settings: IntelligenceSettings,
) -> InvestigationRepository:
    """Choose the investigation repo implementation based on settings.

    ``database_url`` set      → Postgres-backed repo (durable across restarts).
    ``database_url`` unset    → in-memory repo (local dev / tests).
    Production mode (``env="production"``) without a DSN raises so we don't
    silently boot a non-durable repo into a real environment.
    """

    dsn = (settings.database_url or "").strip()
    is_prod = (settings.env or "").lower() in ("production", "prod")
    if not dsn:
        if is_prod:
            raise RuntimeError(
                "INTELLIGENCE_DATABASE_URL is required in production. "
                "Saved investigations would not survive a restart without it."
            )
        logger.info(
            "intelligence.runtime database_url unset; using in-memory "
            "investigation repository"
        )
        return InMemoryInvestigationRepository()

    # Lazy import to keep ``app.db`` cold-loaded only when persistence is on.
    from app.db import build_engine, build_session_factory

    engine = build_engine(dsn)
    session_factory = build_session_factory(engine)
    logger.info("intelligence.runtime using Postgres investigation repository")
    return SqlAlchemyInvestigationRepository(session_factory=session_factory)


@dataclass(slots=True)
class IntelligenceRuntime:
    """Holds long-lived objects for the intelligence backbone."""

    repository: EventRepository
    ingest_service: IngestService
    search_service: SearchService
    summary_service: CountrySummaryService
    agent_service: AgentQueryService
    compare_service: CompareService
    dependency_service: DependencyService
    adapters: tuple[SignalAdapter, ...]
    portfolio_repository: PortfolioRepository
    portfolio_service: PortfolioService
    investigation_repository: InvestigationRepository
    investigation_service: InvestigationService
    alert_repository: AlertRepository
    alert_service: AlertService
    query_log_repository: QueryLogRepository | None = None
    calibration_service: CalibrationService | None = None
    market_data_provider: MarketDataProvider | None = None
    technical_service: TechnicalSnapshotService | None = None
    semantic_service: SemanticPressureService | None = None
    risk_service: PortfolioRiskScoreService | None = None
    posture_service: MarketPostureService | None = None
    narrative_service: MarketNarrativeService | None = None
    _alert_task: asyncio.Task | None = field(default=None, repr=False)
    _settings: IntelligenceSettings | None = field(default=None, repr=False)

    @classmethod
    def build_default(
        cls,
        *,
        adapters: Sequence[SignalAdapter] | None = None,
        repository: EventRepository | None = None,
        stale_ttl: timedelta = timedelta(hours=6),
        settings: IntelligenceSettings | None = None,
    ) -> "IntelligenceRuntime":
        repo = repository or InMemoryEventRepository()
        # Phase 17A.3 — narrative service needs settings even when adapters
        # are explicitly supplied (test paths). Resolve once here.
        active_settings = settings or get_intelligence_settings()
        if adapters is not None:
            resolved_adapters: tuple[SignalAdapter, ...] = tuple(adapters)
        else:
            resolved_adapters = cls._build_adapters_from_settings(active_settings)
        summary_service = CountrySummaryService()
        dedupe_service = DedupeService()
        ingest_service = IngestService(
            adapters=resolved_adapters,
            repository=repo,
            dedupe_service=dedupe_service,
            summary_service=summary_service,
            stale_ttl=stale_ttl,
        )
        search_service = SearchService(repo)

        # Phase 18B — query log + calibration. The repository is
        # selected the same way the investigations repo is: in-memory
        # without ``database_url``, Postgres-backed with one. Weights
        # are loaded from ``ranking_weights.yaml`` next to ``app/`` so
        # an analyst can hot-edit ranking knobs without a redeploy.
        query_log_repository = _build_query_log_repository(active_settings)
        weights_path = Path(__file__).resolve().parents[1] / "ranking_weights.yaml"
        calibration_service = CalibrationService(
            repository=query_log_repository,
            weights_loader=WeightsLoader(path=weights_path),
        )

        agent_service = AgentQueryService(
            search=search_service,
            repository=repo,
            calibration_service=calibration_service,
            anthropic_api_key=active_settings.anthropic_api_key,
            anthropic_model=active_settings.anthropic_model,
            anthropic_base_url=active_settings.anthropic_base_url,
            anthropic_timeout_seconds=active_settings.anthropic_request_timeout_seconds,
        )
        compare_service = CompareService(repository=repo)
        dependency_service = DependencyService(repository=repo)
        portfolio_repository: PortfolioRepository = InMemoryPortfolioRepository()

        # Phase 13B.1: wire the MarketDataProvider abstraction. When adapters
        # are explicitly supplied (tests with adapters=()), skip live provider
        # setup and leave the brief's valuation_summary as None.
        market_data_provider: MarketDataProvider | None = None
        if adapters is None:
            try:
                market_data_provider = build_market_data_provider(
                    settings=active_settings
                )
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning(
                    "failed to build market data provider: %s; continuing without valuation",
                    exc,
                )

        from app.intelligence.portfolio.valuation_service import ValuationService

        valuation_service = (
            ValuationService() if market_data_provider is not None else None
        )
        portfolio_brief_service = PortfolioBriefService(
            repository=repo,
            market_data_provider=market_data_provider,
            valuation_service=valuation_service,
        )

        # Phase 13B.2: wire the technical snapshot service atop the same
        # MarketDataProvider so replay + chart slices can reuse it.
        technical_service: TechnicalSnapshotService | None = None
        if market_data_provider is not None:
            technical_service = TechnicalSnapshotService(
                repository=portfolio_repository,
                provider=market_data_provider,
            )

        # Phase 13B.3: wire the semantic / event pressure service. It depends
        # only on the shared EventRepository + PortfolioRepository, so we can
        # wire it whether or not a market data provider was configured.
        semantic_service = SemanticPressureService(
            repository=portfolio_repository,
            events=repo,
        )

        # Phase 13B.4: wire the macro risk score service. It assembles the
        # brief + semantic rollup into an interpretable 0..100 score with
        # drivers + component breakdown — never a naked number.
        risk_service = PortfolioRiskScoreService(
            repository=portfolio_repository,
            brief_service=portfolio_brief_service,
            semantic_service=semantic_service,
            exposure_service=ExposureService(),
            technical_service=technical_service,
        )

        # Phase 17B → 18A.2: investigations persistence.
        # When ``database_url`` is configured we swap in the Postgres-backed
        # repository so saved investigations and share tokens survive
        # restarts. With no DSN the in-memory repo continues to satisfy
        # the same Protocol so local dev keeps working without Postgres.
        investigation_repository: InvestigationRepository = (
            _build_investigation_repository(active_settings)
        )
        investigation_service = InvestigationService(
            repository=investigation_repository,
        )

        portfolio_service = PortfolioService(
            repository=portfolio_repository,
            events_repository=repo,
            brief_service=portfolio_brief_service,
            market_data_provider=market_data_provider,
            technical_service=technical_service,
            semantic_service=semantic_service,
            risk_service=risk_service,
        )

        # Phase 17A.1: wire the deterministic market posture service. It
        # composes the technical engine + the live event corpus into a
        # symbol-level posture without portfolio scoping. Pure / cacheable —
        # the agent layer (17A.2) will call this rather than reasoning over
        # raw candles.
        posture_service = MarketPostureService(
            market_data_provider=market_data_provider,
            events=repo,
        )

        # Phase 17A.3: bounded agentic narrative layer over the deterministic
        # posture envelope. Anthropic key is optional — without one the
        # service returns a deterministic narrative with the same shape so
        # the frontend never has to special-case "no provider configured".
        narrative_service = MarketNarrativeService(
            posture_service=posture_service,
            anthropic_api_key=active_settings.anthropic_api_key,
            anthropic_model=active_settings.anthropic_model,
            anthropic_base_url=active_settings.anthropic_base_url,
            anthropic_timeout_seconds=
                active_settings.anthropic_request_timeout_seconds,
        )

        # Phase 17C → 18A.3: alert rules + recent-event ring buffer.
        # When ``redis_url`` is configured the Redis-backed repository
        # replaces the in-memory ring buffer so events survive restarts
        # and replicate across replicas. Service surface is unchanged.
        alert_repository: AlertRepository = _build_alert_repository(active_settings)
        alert_service = AlertService(
            repository=alert_repository,
            posture_service=posture_service,
        )

        return cls(
            repository=repo,
            ingest_service=ingest_service,
            search_service=search_service,
            summary_service=summary_service,
            agent_service=agent_service,
            compare_service=compare_service,
            dependency_service=dependency_service,
            adapters=resolved_adapters,
            portfolio_repository=portfolio_repository,
            portfolio_service=portfolio_service,
            investigation_repository=investigation_repository,
            investigation_service=investigation_service,
            alert_repository=alert_repository,
            alert_service=alert_service,
            query_log_repository=query_log_repository,
            calibration_service=calibration_service,
            market_data_provider=market_data_provider,
            technical_service=technical_service,
            semantic_service=semantic_service,
            risk_service=risk_service,
            posture_service=posture_service,
            narrative_service=narrative_service,
            _settings=active_settings,
        )

    @staticmethod
    def _build_adapters_from_settings(
        settings: IntelligenceSettings,
    ) -> tuple[SignalAdapter, ...]:
        return (
            WeatherAdapter(config=settings.provider_config("weather")),
            NewsAdapter(config=settings.provider_config("news")),
            FlightAdapter(config=settings.provider_config("flight")),
            ConflictAdapter(config=settings.provider_config("conflict")),
            MoodAdapter(config=settings.provider_config("mood")),
            DiseaseAdapter(config=settings.provider_config("disease")),
            StocksAdapter(config=settings.provider_config("stocks")),
            CommoditiesAdapter(config=settings.provider_config("commodities")),
            CurrencyAdapter(config=settings.provider_config("currency")),
        )

    async def start(
        self,
        *,
        interval_seconds: float = 120.0,
        alert_interval_seconds: float = 60.0,
    ) -> None:
        # Phase 18A.4 — boot-time smoke. When Postgres / Redis are
        # configured we ping them once before serving requests so a
        # misconfigured DSN surfaces at boot rather than on first save.
        # In production mode a failed ping is fatal; in dev mode it is
        # a warning so working-offline still boots.
        await self._smoke_persistence_at_boot()
        await self.ingest_service.start_background(interval_seconds=interval_seconds)
        # Phase 17C: alert evaluation cycle. Independent from the ingest
        # loop because alert cycles are cheap and want to react sooner
        # than a 2-minute ingest tick.
        self._alert_task = asyncio.create_task(
            self._alert_loop(alert_interval_seconds)
        )

    async def _smoke_persistence_at_boot(self) -> None:
        """Ping configured persistence stores once before serving traffic."""

        settings = self._settings or get_intelligence_settings()
        is_prod = (settings.env or "").lower() in ("production", "prod")

        await self._smoke_postgres(settings.database_url, is_prod=is_prod)
        await self._smoke_redis(settings.redis_url, is_prod=is_prod)

    async def _smoke_postgres(
        self, database_url: str | None, *, is_prod: bool
    ) -> None:
        dsn = (database_url or "").strip()
        if not dsn:
            return
        try:
            from app.db import build_engine
            from sqlalchemy import text

            engine = build_engine(dsn)
            try:
                async with engine.connect() as connection:
                    await connection.execute(text("SELECT 1"))
            finally:
                await engine.dispose()
        except Exception as exc:
            message = (
                "intelligence.runtime Postgres smoke failed at boot: %s" % exc
            )
            if is_prod:
                raise RuntimeError(message) from exc
            logger.warning(message)
            return
        logger.info("intelligence.runtime Postgres smoke ok")

    async def _smoke_redis(
        self, redis_url: str | None, *, is_prod: bool
    ) -> None:
        url = (redis_url or "").strip()
        if not url:
            return
        try:
            from app.cache import build_redis_client, ping_redis

            client = build_redis_client(url)
            try:
                pong = await ping_redis(client)
                if not pong:
                    raise RuntimeError("PING returned False")
            finally:
                await client.aclose()
        except Exception as exc:
            message = (
                "intelligence.runtime Redis smoke failed at boot: %s" % exc
            )
            if is_prod:
                raise RuntimeError(message) from exc
            logger.warning(message)
            return
        logger.info("intelligence.runtime Redis smoke ok")

    async def _alert_loop(self, interval_seconds: float) -> None:
        try:
            while True:
                await asyncio.sleep(interval_seconds)
                try:
                    await self.alert_service.evaluate_all()
                except Exception as exc:  # pragma: no cover - defensive
                    logger.warning("alerts: evaluate_all failed: %s", exc)
        except asyncio.CancelledError:
            return

    async def stop(self) -> None:
        if self._alert_task is not None:
            self._alert_task.cancel()
            try:
                await self._alert_task
            except (asyncio.CancelledError, Exception):  # pragma: no cover
                pass
            self._alert_task = None
        await self.ingest_service.stop_background()
        for adapter in self.adapters:
            closer = getattr(adapter, "aclose", None)
            if closer is None:
                continue
            try:
                await closer()
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("intelligence runtime: adapter close failed: %s", exc)
        if self.market_data_provider is not None:
            try:
                await self.market_data_provider.aclose()
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning(
                    "intelligence runtime: market data provider close failed: %s",
                    exc,
                )


__all__ = ["IntelligenceRuntime"]
