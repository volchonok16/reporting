from app.b2b_news_db import (
    ROW_ID_KEY,
    B2B_NEWS_SECTION_COLUMNS,
    delete_b2b_news_row,
    load_b2b_news_from_db,
    load_b2b_news_history,
    load_b2b_news_snapshots,
    restore_b2b_news_snapshot,
    save_b2b_news_to_db,
)
from app.schemas import ProductStatusB2BOut

__all__ = [
    "B2B_NEWS_SECTION_COLUMNS",
    "ROW_ID_KEY",
    "delete_b2b_news_row",
    "load_b2b_news",
    "load_b2b_news_from_db",
    "load_b2b_news_history",
    "load_b2b_news_snapshots",
    "restore_b2b_news_snapshot",
    "save_b2b_news_to_db",
]


def load_b2b_news(
    *,
    db,
    gid: str | None = None,
    meta_only: bool = False,
    use_cache: bool = True,
) -> ProductStatusB2BOut:
    del use_cache
    return load_b2b_news_from_db(
        db,
        gid=gid,
        meta_only=meta_only,
    )
