"""Очистка журнала изменений мастер-файла Voice (master_changes).

Удаляет записи журнала старше срока хранения. Текущая версия мастер-файла
(master_records / master_state.current_revision) не затрагивается.
"""

from __future__ import annotations

import logging
import os
import time

from .pg_db import connect as pg_connect

logger = logging.getLogger(__name__)

DEFAULT_RETENTION_DAYS = 14
_LAST_PURGE_AT = 0.0
# Не чаще раза в сутки из cleanup-loop (интервал TTL обычно 5 мин).
_MIN_PURGE_INTERVAL_SECONDS = 24 * 60 * 60


def retention_days_from_env() -> int:
    try:
        from .config import settings

        return max(1, int(settings.master_history_retention_days))
    except Exception:
        raw = (
            os.getenv("VOICE_MASTER_HISTORY_RETENTION_DAYS")
            or os.getenv("MASTER_HISTORY_RETENTION_DAYS")
            or str(DEFAULT_RETENTION_DAYS)
        ).strip()
        try:
            value = int(raw)
        except ValueError:
            return DEFAULT_RETENTION_DAYS
        return max(1, value)


def purge_old_master_changes(*, retention_days: int | None = None, force: bool = False) -> int:
    """DELETE из master_changes WHERE created_at старше retention_days.

    Возвращает число удалённых строк. master_records и current_revision не трогает.
    """
    global _LAST_PURGE_AT
    now = time.time()
    if not force and _LAST_PURGE_AT and (now - _LAST_PURGE_AT) < _MIN_PURGE_INTERVAL_SECONDS:
        return 0

    days = retention_days if retention_days is not None else retention_days_from_env()
    days = max(1, int(days))
    cutoff = now - days * 86400.0

    deleted = 0
    with pg_connect() as connection:
        # pg_db использует ?-плейсхолдеры (sqlite-стиль), translate_sql → %s
        cursor = connection.execute(
            "DELETE FROM master_changes WHERE created_at < ?",
            (cutoff,),
        )
        deleted = int(getattr(cursor, "rowcount", 0) or 0)
        connection.commit()

    _LAST_PURGE_AT = now
    if deleted:
        logger.info(
            "Voice master history: удалено %s записей master_changes старше %s дн. "
            "(текущая версия мастер-файла сохранена)",
            deleted,
            days,
        )
    return deleted
