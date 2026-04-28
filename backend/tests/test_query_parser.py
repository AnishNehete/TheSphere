from app.services.query_parser import query_parser


def test_parse_region_and_unavailable_layer() -> None:
    result = query_parser.parse("show africa conflict")

    assert result.layer == "conflict"
    assert result.region == "africa"
    assert result.cameraPreset == "regional_focus"
    assert result.available is False


def test_parse_entity_defaults_to_flights() -> None:
    result = query_parser.parse("track aal123")

    assert result.layer == "flights"
    assert result.entityId == "AAL123"
    assert result.action == "track_entity"
    assert result.available is True


def test_parse_layer_only() -> None:
    result = query_parser.parse("show markets")

    assert result.layer == "markets"
    assert result.region is None
    assert result.cameraPreset == "global_pullback"
