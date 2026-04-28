import asyncio
import math
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import uuid4

from app.db.postgres import PostgresStore
from app.db.redis import RedisStore
from app.models.schemas import Event, EventMetadata, GeoPoint, LiveEnvelope, MetricRecord, Region, RouteGeometry, ServiceStatus
from app.services.query_parser import QueryParserService, query_parser
from app.websocket.manager import WebSocketManager


@dataclass(slots=True)
class FlightSeed:
    flight_id: str
    callsign: str
    region: str
    origin: str
    destination: str
    origin_coords: tuple[float, float]
    destination_coords: tuple[float, float]
    base_lat: float
    base_lon: float
    altitude_ft: int
    velocity_mph: int
    heading_deg: int
    lat_amplitude: float
    lon_amplitude: float


class SphereRuntime:
    def __init__(
        self,
        *,
        redis_store: RedisStore,
        postgres_store: PostgresStore,
        ws_manager: WebSocketManager,
        interval_ms: int,
        enable_simulator: bool,
        parser: QueryParserService | None = None,
    ) -> None:
        self.redis = redis_store
        self.postgres = postgres_store
        self.ws_manager = ws_manager
        self.interval_ms = interval_ms
        self.enable_simulator = enable_simulator
        self.query_parser = parser or query_parser
        self.regions = self._build_regions()
        self.latest_events: list[Event] = []
        self.latest_metrics: list[MetricRecord] = []
        self._tick = 0
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        await self.redis.connect()
        await self.postgres.init()
        await self.postgres.upsert_regions(self.regions)
        await self.step()

        if self.enable_simulator:
            self._task = asyncio.create_task(self._run(), name="sphere-simulator")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await self.redis.close()
        await self.postgres.close()

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self.interval_ms / 1000)
            await self.step()

    async def step(self) -> None:
        self._tick += 1
        now = datetime.now(UTC)
        events = self._generate_events(now)
        metrics = self._build_metrics(events, now)
        self.latest_events = events
        self.latest_metrics = metrics

        snapshot = self.snapshot_envelope(now)
        telemetry = self.telemetry_envelope(now)
        status = self.status_envelope(now)

        await self.redis.set_json("live_events", {"items": [event.model_dump(mode="json") for event in events]})
        await self.redis.set_json("active_layers", {"items": ["flights"]})
        await self.redis.publish_json("sphere:events", snapshot.model_dump(mode="json"))
        await self.redis.publish_json("sphere:telemetry", telemetry.model_dump(mode="json"))
        await self.redis.publish_json("sphere:status", status.model_dump(mode="json"))
        await self.postgres.persist_events(events)
        await self.postgres.persist_metrics(metrics)

        await self.ws_manager.broadcast(snapshot.model_dump(mode="json"))
        await self.ws_manager.broadcast(telemetry.model_dump(mode="json"))
        await self.ws_manager.broadcast(status.model_dump(mode="json"))

    def list_events(self, *, layer: str, region: str | None, limit: int) -> list[Event]:
        items = [event for event in self.latest_events if event.type == layer]
        if region:
            items = [event for event in items if event.metadata.region == region]
        return items[:limit]

    def list_regions(self) -> list[Region]:
        return self.regions

    def parse_query(self, value: str):
        return self.query_parser.parse(value)

    def snapshot_envelope(self, now: datetime | None = None) -> LiveEnvelope:
        timestamp = now or datetime.now(UTC)
        return LiveEnvelope(
            type="snapshot",
            channel="sphere:events",
            timestamp=timestamp,
            payload={"items": [event.model_dump(mode="json") for event in self.latest_events]},
        )

    def telemetry_envelope(self, now: datetime | None = None) -> LiveEnvelope:
        timestamp = now or datetime.now(UTC)
        focus = max(self.latest_events, key=lambda item: item.severity, default=None)
        return LiveEnvelope(
            type="telemetry",
            channel="sphere:telemetry",
            timestamp=timestamp,
            payload={
                "flight": focus.model_dump(mode="json") if focus else None,
                "activeLayer": "flights",
                "trackedFlights": len(self.latest_events),
            },
        )

    def status_envelope(self, now: datetime | None = None) -> LiveEnvelope:
        timestamp = now or datetime.now(UTC)
        status = ServiceStatus(
            server="online",
            kafka="design-only",
            redis="active" if self.redis.connected else "degraded",
            localTime=timestamp.strftime("%H:%M:%S UTC"),
        )
        return LiveEnvelope(
            type="status",
            channel="sphere:status",
            timestamp=timestamp,
            payload=status.model_dump(mode="json"),
        )

    def _generate_events(self, now: datetime) -> list[Event]:
        phase = self._tick / 4
        results: list[Event] = []

        for index, seed in enumerate(self._flight_seeds()):
            wobble = phase + index * 0.8
            lat = round(seed.base_lat + math.sin(wobble) * seed.lat_amplitude, 4)
            lon = round(seed.base_lon + math.cos(wobble) * seed.lon_amplitude, 4)
            altitude = int(seed.altitude_ft + math.sin(wobble * 1.7) * 1100)
            velocity = int(seed.velocity_mph + math.cos(wobble * 1.2) * 34)
            heading = int((seed.heading_deg + self._tick * 4 + index * 9) % 360)
            severity = round(min(max(0.38 + ((math.sin(wobble) + 1) / 2) * 0.48, 0.0), 1.0), 3)

            results.append(
                Event(
                    id=str(uuid4()),
                    type="flights",
                    lat=lat,
                    lon=lon,
                    severity=severity,
                    timestamp=now,
                    metadata=EventMetadata(
                        flight_id=seed.flight_id,
                        callsign=seed.callsign,
                        origin=seed.origin,
                        destination=seed.destination,
                        altitude_ft=altitude,
                        velocity_mph=velocity,
                        heading_deg=heading,
                        region=seed.region,
                        pulse=severity,
                        route=RouteGeometry(
                            origin=GeoPoint(lat=seed.origin_coords[0], lon=seed.origin_coords[1]),
                            destination=GeoPoint(lat=seed.destination_coords[0], lon=seed.destination_coords[1]),
                        ),
                    ),
                )
            )

        return results

    def _build_metrics(self, events: list[Event], now: datetime) -> list[MetricRecord]:
        counts: dict[str, int] = {}
        for event in events:
            region = event.metadata.region or "global"
            counts[region] = counts.get(region, 0) + 1

        max_count = max(counts.values(), default=1)
        return [
            MetricRecord(
                id=str(uuid4()),
                region=region,
                layer="flights",
                value=round(count / max_count, 3),
                timestamp=now,
            )
            for region, count in sorted(counts.items())
        ]

    def _build_regions(self) -> list[Region]:
        return [
            self._region(
                slug="north-america",
                name="North America",
                centroid=(44.5, -100.0),
                polygon=[[-168.0, 12.0], [-52.0, 12.0], [-52.0, 72.0], [-168.0, 72.0], [-168.0, 12.0]],
            ),
            self._region(
                slug="europe",
                name="Europe",
                centroid=(50.0, 15.0),
                polygon=[[-12.0, 35.0], [42.0, 35.0], [42.0, 72.0], [-12.0, 72.0], [-12.0, 35.0]],
            ),
            self._region(
                slug="africa",
                name="Africa",
                centroid=(6.0, 20.0),
                polygon=[[-18.0, -35.0], [52.0, -35.0], [52.0, 38.0], [-18.0, 38.0], [-18.0, -35.0]],
            ),
            self._region(
                slug="middle-east",
                name="Middle East",
                centroid=(26.0, 45.0),
                polygon=[[30.0, 12.0], [61.0, 12.0], [61.0, 40.0], [30.0, 40.0], [30.0, 12.0]],
            ),
            self._region(
                slug="asia",
                name="Asia",
                centroid=(30.0, 95.0),
                polygon=[[26.0, 0.0], [178.0, 0.0], [178.0, 78.0], [26.0, 78.0], [26.0, 0.0]],
            ),
        ]

    def _region(self, *, slug: str, name: str, centroid: tuple[float, float], polygon: list[list[float]]) -> Region:
        return Region(
            id=str(uuid4()),
            slug=slug,
            name=name,
            centroid=GeoPoint(lat=centroid[0], lon=centroid[1]),
            geojson={
                "type": "Feature",
                "properties": {"slug": slug, "name": name},
                "geometry": {"type": "Polygon", "coordinates": [polygon]},
            },
        )

    def _flight_seeds(self) -> list[FlightSeed]:
        return [
            FlightSeed(
                flight_id="AAL123",
                callsign="AAL123",
                region="north-america",
                origin="JFK",
                destination="LAX",
                origin_coords=(40.6413, -73.7781),
                destination_coords=(33.9416, -118.4085),
                base_lat=39.2,
                base_lon=-96.0,
                altitude_ft=35000,
                velocity_mph=540,
                heading_deg=270,
                lat_amplitude=2.1,
                lon_amplitude=6.4,
            ),
            FlightSeed(
                flight_id="BAW047",
                callsign="BAW047",
                region="europe",
                origin="LHR",
                destination="DXB",
                origin_coords=(51.47, -0.4543),
                destination_coords=(25.2532, 55.3657),
                base_lat=47.8,
                base_lon=17.0,
                altitude_ft=37200,
                velocity_mph=515,
                heading_deg=122,
                lat_amplitude=2.0,
                lon_amplitude=7.0,
            ),
            FlightSeed(
                flight_id="ETH701",
                callsign="ETH701",
                region="africa",
                origin="ADD",
                destination="JNB",
                origin_coords=(8.9779, 38.7993),
                destination_coords=(-26.1337, 28.2420),
                base_lat=-3.0,
                base_lon=29.0,
                altitude_ft=34400,
                velocity_mph=503,
                heading_deg=214,
                lat_amplitude=6.0,
                lon_amplitude=4.8,
            ),
            FlightSeed(
                flight_id="QTR204",
                callsign="QTR204",
                region="middle-east",
                origin="DOH",
                destination="NBO",
                origin_coords=(25.2731, 51.6081),
                destination_coords=(-1.3192, 36.9278),
                base_lat=19.0,
                base_lon=42.0,
                altitude_ft=36100,
                velocity_mph=524,
                heading_deg=198,
                lat_amplitude=3.7,
                lon_amplitude=5.2,
            ),
            FlightSeed(
                flight_id="SIA318",
                callsign="SIA318",
                region="asia",
                origin="SIN",
                destination="HND",
                origin_coords=(1.3644, 103.9915),
                destination_coords=(35.5494, 139.7798),
                base_lat=20.0,
                base_lon=121.0,
                altitude_ft=38600,
                velocity_mph=560,
                heading_deg=54,
                lat_amplitude=5.5,
                lon_amplitude=8.5,
            ),
            FlightSeed(
                flight_id="AFR409",
                callsign="AFR409",
                region="africa",
                origin="CDG",
                destination="LOS",
                origin_coords=(49.0097, 2.5479),
                destination_coords=(6.5774, 3.3212),
                base_lat=19.0,
                base_lon=11.0,
                altitude_ft=33300,
                velocity_mph=496,
                heading_deg=183,
                lat_amplitude=4.9,
                lon_amplitude=5.9,
            ),
        ]
