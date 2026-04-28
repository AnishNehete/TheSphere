import re

from app.models.schemas import QueryResult


LAYER_ALIASES: dict[str, str] = {
    "flight": "flights",
    "flights": "flights",
    "aviation": "flights",
    "air": "flights",
    "conflict": "conflict",
    "war": "conflict",
    "strike": "conflict",
    "disease": "disease",
    "health": "disease",
    "outbreak": "disease",
    "biohazard": "disease",
    "market": "markets",
    "markets": "markets",
    "equity": "markets",
}

REGION_ALIASES: dict[str, str | None] = {
    "africa": "africa",
    "europe": "europe",
    "asia": "asia",
    "middle east": "middle-east",
    "middle-east": "middle-east",
    "mena": "middle-east",
    "north america": "north-america",
    "north-america": "north-america",
    "global": None,
    "world": None,
}

ENTITY_PATTERN = re.compile(r"\b[A-Z]{2,3}\d{2,4}\b", re.IGNORECASE)


class QueryParserService:
    def parse(self, value: str) -> QueryResult:
        text = value.strip().lower()
        entity_match = ENTITY_PATTERN.search(value)
        region = self._extract_region(text)
        layer = self._extract_layer(text)

        if entity_match and layer is None:
            layer = "flights"

        layer = layer or "flights"

        if entity_match:
            return QueryResult(
                layer="flights",
                region=region,
                entityId=entity_match.group(0).upper(),
                cameraPreset="hotspot_zoom",
                action="track_entity",
                available=True,
            )

        if region:
            return QueryResult(
                layer=layer,
                region=region,
                entityId=None,
                cameraPreset="regional_focus",
                action="focus_region",
                available=layer == "flights",
            )

        if layer:
            return QueryResult(
                layer=layer,
                region=None,
                entityId=None,
                cameraPreset="global_pullback",
                action="activate_layer",
                available=layer == "flights",
            )

        return QueryResult(
            layer="flights",
            region=None,
            entityId=None,
            cameraPreset="idle_orbit",
            action="idle",
            available=True,
        )

    def _extract_region(self, text: str) -> str | None:
        for alias, region in sorted(REGION_ALIASES.items(), key=lambda item: len(item[0]), reverse=True):
            if alias in text:
                return region
        return None

    def _extract_layer(self, text: str) -> str | None:
        for alias, layer in sorted(LAYER_ALIASES.items(), key=lambda item: len(item[0]), reverse=True):
            if alias in text:
                return layer
        return None


query_parser = QueryParserService()
