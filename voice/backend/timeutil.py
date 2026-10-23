"""Unix float ↔ timestamptz helpers for Voice master/registry columns."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


def now_ts() -> datetime:
    return datetime.now(UTC)


def as_dt(value: float | int | datetime | None) -> datetime | None:
    """Convert API/legacy Unix float (or datetime) to aware UTC datetime."""

    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)
    return datetime.fromtimestamp(float(value), tz=UTC)


def as_unix(value: Any) -> float | None:
    """Normalize DB/API timestamp values to Unix seconds (float)."""

    if value is None:
        return None
    if isinstance(value, datetime):
        return value.timestamp()
    return float(value)


def coerce_row_value(value: Any) -> Any:
    """PgRow helper: expose timestamptz columns as Unix float for legacy callers."""

    if isinstance(value, datetime):
        return value.timestamp()
    return value
