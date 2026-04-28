import json

from redis.asyncio import Redis


class RedisStore:
    def __init__(self, url: str | None) -> None:
        self._url = url
        self._client: Redis | None = None
        self.connected = False

    async def connect(self) -> None:
        if not self._url:
            return

        try:
            self._client = Redis.from_url(self._url, decode_responses=True)
            await self._client.ping()
            self.connected = True
        except Exception:
            self._client = None
            self.connected = False

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
        self._client = None
        self.connected = False

    async def set_json(self, key: str, payload: dict) -> None:
        if self._client is None:
            return
        await self._client.set(key, json.dumps(payload))

    async def publish_json(self, channel: str, payload: dict) -> None:
        if self._client is None:
            return
        await self._client.publish(channel, json.dumps(payload))
