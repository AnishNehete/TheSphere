"""Live source adapters for Sphere intelligence ingestion."""

from app.intelligence.adapters.base import (
    AdapterHealth,
    AdapterResult,
    SignalAdapter,
)
from app.intelligence.adapters.commodities_adapter import CommoditiesAdapter
from app.intelligence.adapters.conflict_adapter import ConflictAdapter
from app.intelligence.adapters.currency_adapter import CurrencyAdapter
from app.intelligence.adapters.disease_adapter import DiseaseAdapter
from app.intelligence.adapters.flight_adapter import FlightAdapter
from app.intelligence.adapters.mood_adapter import MoodAdapter
from app.intelligence.adapters.news_adapter import NewsAdapter
from app.intelligence.adapters.stocks_adapter import StocksAdapter
from app.intelligence.adapters.weather_adapter import WeatherAdapter

__all__ = [
    "AdapterHealth",
    "AdapterResult",
    "CommoditiesAdapter",
    "ConflictAdapter",
    "CurrencyAdapter",
    "DiseaseAdapter",
    "FlightAdapter",
    "MoodAdapter",
    "NewsAdapter",
    "SignalAdapter",
    "StocksAdapter",
    "WeatherAdapter",
]
