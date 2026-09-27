"""A tiny in-process TTL cache with single-flight semantics.

The web UI polls: the map and firehose refresh every few seconds, so N viewers
means N identical queries per interval for byte-identical results. Caching the
expensive read endpoints for roughly one poll interval decouples database load
from audience size, which matters more here than any single query rewrite.

Single-flight is the important half. A plain TTL cache still lets every request
that arrives during a cold computation start its own copy of that work -- which
is exactly the thundering herd you get when a popular page expires. Callers
that miss instead wait on the in-flight computation and share its result.

Deliberately not an LRU: the key space is small and bounded by the number of
distinct query-string shapes, so entries are cheap to keep.
"""

import asyncio
import time


class TTLCache:
    def __init__(self):
        self._entries: dict[object, tuple[float, object]] = {}
        self._locks: dict[object, asyncio.Lock] = {}

    def _live(self, key):
        entry = self._entries.get(key)
        if entry is None:
            return None
        expires_at, value = entry
        if time.monotonic() >= expires_at:
            return None
        return (value,)

    async def get_or_compute(self, key, ttl: float, factory):
        """Return a cached value for ``key``, computing it via ``factory`` if stale.

        ``factory`` is an async callable taking no arguments. It runs at most
        once per key across concurrent callers.
        """
        hit = self._live(key)
        if hit is not None:
            return hit[0]

        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            # Another caller may have populated the entry while we queued.
            hit = self._live(key)
            if hit is not None:
                return hit[0]

            value = await factory()
            self._entries[key] = (time.monotonic() + ttl, value)
            return value

    def invalidate(self, key=None):
        if key is None:
            self._entries.clear()
        else:
            self._entries.pop(key, None)

    def stats(self):
        now = time.monotonic()
        live = sum(1 for expires_at, _ in self._entries.values() if expires_at > now)
        return {"entries": len(self._entries), "live": live}
