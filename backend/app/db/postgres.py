from collections.abc import Sequence

from psycopg import AsyncConnection
from psycopg.types.json import Jsonb

from app.models.schemas import Event, MetricRecord, Region


INIT_SQL = """
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  severity DOUBLE PRECISION NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  geom GEOGRAPHY(POINT, 4326) NOT NULL
);

CREATE TABLE IF NOT EXISTS regions (
  id UUID PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  geojson JSONB NOT NULL,
  centroid GEOGRAPHY(POINT, 4326) NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  id UUID PRIMARY KEY,
  region TEXT NOT NULL,
  layer TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL
);
"""


class PostgresStore:
    def __init__(self, dsn: str | None) -> None:
        self._dsn = dsn
        self.available = False

    async def init(self) -> None:
        if not self._dsn:
            return

        try:
            async with await AsyncConnection.connect(self._dsn, autocommit=True) as connection:
                async with connection.cursor() as cursor:
                    await cursor.execute(INIT_SQL)
            self.available = True
        except Exception:
            self.available = False

    async def close(self) -> None:
        return

    async def upsert_regions(self, regions: Sequence[Region]) -> None:
        if not self.available or not regions:
            return

        query = """
        INSERT INTO regions (id, slug, name, geojson, centroid)
        VALUES (%s::uuid, %s, %s, %s, ST_GeogFromText(%s))
        ON CONFLICT (slug) DO UPDATE
          SET name = EXCLUDED.name,
              geojson = EXCLUDED.geojson,
              centroid = EXCLUDED.centroid
        """

        values = [
            (
                region.id,
                region.slug,
                region.name,
                Jsonb(region.geojson),
                self._point_wkt(region.centroid.lon, region.centroid.lat),
            )
            for region in regions
        ]

        try:
            async with await AsyncConnection.connect(self._dsn, autocommit=True) as connection:
                async with connection.cursor() as cursor:
                    await cursor.executemany(query, values)
        except Exception:
            self.available = False

    async def persist_events(self, events: Sequence[Event]) -> None:
        if not self.available or not events:
            return

        query = """
        INSERT INTO events (id, type, lat, lon, severity, timestamp, metadata, geom)
        VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, ST_GeogFromText(%s))
        """

        values = [
            (
                event.id,
                event.type,
                event.lat,
                event.lon,
                event.severity,
                event.timestamp,
                Jsonb(event.metadata.model_dump(mode="json", exclude_none=True)),
                self._point_wkt(event.lon, event.lat),
            )
            for event in events
        ]

        try:
            async with await AsyncConnection.connect(self._dsn, autocommit=True) as connection:
                async with connection.cursor() as cursor:
                    await cursor.executemany(query, values)
        except Exception:
            self.available = False

    async def persist_metrics(self, metrics: Sequence[MetricRecord]) -> None:
        if not self.available or not metrics:
            return

        query = """
        INSERT INTO metrics (id, region, layer, value, timestamp)
        VALUES (%s::uuid, %s, %s, %s, %s)
        """

        values = [
            (metric.id, metric.region, metric.layer, metric.value, metric.timestamp)
            for metric in metrics
        ]

        try:
            async with await AsyncConnection.connect(self._dsn, autocommit=True) as connection:
                async with connection.cursor() as cursor:
                    await cursor.executemany(query, values)
        except Exception:
            self.available = False

    @staticmethod
    def _point_wkt(lon: float, lat: float) -> str:
        return f"SRID=4326;POINT({lon} {lat})"
