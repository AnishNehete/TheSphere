from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


LayerName = Literal["flights", "conflict", "disease", "markets"]
CameraPreset = Literal["idle_orbit", "hotspot_zoom", "regional_focus", "global_pullback"]
EnvelopeType = Literal["snapshot", "event", "telemetry", "status"]


class GeoPoint(BaseModel):
    lat: float
    lon: float


class RouteGeometry(BaseModel):
    origin: GeoPoint
    destination: GeoPoint


class EventMetadata(BaseModel):
    flight_id: str | None = None
    callsign: str | None = None
    origin: str | None = None
    destination: str | None = None
    altitude_ft: int | None = None
    velocity_mph: int | None = None
    heading_deg: int | None = None
    region: str | None = None
    pulse: float | None = None
    route: RouteGeometry | None = None


class Event(BaseModel):
    id: str
    type: str
    lat: float
    lon: float
    severity: float = Field(ge=0.0, le=1.0)
    timestamp: datetime
    metadata: EventMetadata


class EventsResponse(BaseModel):
    items: list[Event]


class Region(BaseModel):
    id: str
    slug: str
    name: str
    geojson: dict[str, Any]
    centroid: GeoPoint


class RegionsResponse(BaseModel):
    items: list[Region]


class MetricRecord(BaseModel):
    id: str
    region: str
    layer: str
    value: float = Field(ge=0.0, le=1.0)
    timestamp: datetime


class QueryRequest(BaseModel):
    input: str = Field(min_length=2)


class QueryResult(BaseModel):
    layer: LayerName
    region: str | None = None
    entityId: str | None = None
    cameraPreset: CameraPreset
    action: Literal["activate_layer", "focus_region", "track_entity", "idle"]
    available: bool


class ServiceStatus(BaseModel):
    server: Literal["online", "degraded"]
    kafka: Literal["design-only", "active"]
    redis: Literal["active", "degraded"]
    localTime: str


class LiveEnvelope(BaseModel):
    type: EnvelopeType
    channel: str
    timestamp: datetime
    payload: dict[str, Any]
