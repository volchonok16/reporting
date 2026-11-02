"""Простой in-memory rate limit (login / password-reset)."""

from __future__ import annotations

import threading
import time


class RateLimiter:
    def __init__(self, limit: int, window_seconds: float) -> None:
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            bucket = self._hits.setdefault(key, [])
            cutoff = now - self.window
            while bucket and bucket[0] < cutoff:
                bucket.pop(0)
            if len(bucket) >= self.limit:
                return False
            bucket.append(now)
            return True

    def reset(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)


# Login: 20 / 10 мин с IP, 10 / 10 мин на логин
login_by_ip = RateLimiter(20, 10 * 60)
login_by_user = RateLimiter(10, 10 * 60)

# Password reset verify/confirm: 30 / 10 мин с IP
reset_verify_by_ip = RateLimiter(30, 10 * 60)
