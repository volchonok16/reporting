from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings

logger = logging.getLogger(__name__)

_B2B_AUDIT_TABLES: tuple[tuple[str, str], ...] = (
    ("b2b_product_status_history", "changed_at"),
    ("b2b_product_status_snapshot", "created_at"),
    ("b2b_news_history", "changed_at"),
    ("b2b_news_snapshot", "created_at"),
)


def purge_old_b2b_audit_records(db: Session) -> dict[str, int]:
    """Удаляет историю правок и снимки версий старше срока хранения (строки таблиц не трогаем)."""
    retention_days = max(1, int(settings.b2b_audit_retention_days))
    cutoff = datetime.now(UTC) - timedelta(days=retention_days)
    deleted: dict[str, int] = {}

    for table, timestamp_column in _B2B_AUDIT_TABLES:
        result = db.execute(
            text(
                f"""
                DELETE FROM {table}
                WHERE {timestamp_column} < :cutoff
                """
            ),
            {"cutoff": cutoff},
        )
        count = int(result.rowcount or 0)
        deleted[table] = count

    db.commit()
    total = sum(deleted.values())
    if total:
        logger.info(
            "Очистка B2B-аудита: удалено %s записей старше %s дн. (%s)",
            total,
            retention_days,
            ", ".join(f"{name}={count}" for name, count in deleted.items() if count),
        )
    return deleted
