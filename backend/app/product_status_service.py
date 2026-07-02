from app.b2b_product_status_db import (
    ADMIN_ONLY_COLUMNS,
    B2B_PRODUCT_STATUS_COLUMNS,
    ROW_ID_KEY,
    delete_b2b_product_status_row,
    load_b2b_product_status_from_db,
    load_b2b_product_status_history,
    load_b2b_product_status_snapshots,
    restore_b2b_product_status_snapshot,
    save_b2b_product_status_to_db,
)
from app.config import settings
from app.schemas import ProductStatusB2BOut

__all__ = [
    "ADMIN_ONLY_COLUMNS",
    "B2B_PRODUCT_STATUS_COLUMNS",
    "ROW_ID_KEY",
    "delete_b2b_product_status_row",
    "load_b2b_product_status",
    "load_b2b_product_status_from_db",
    "load_b2b_product_status_history",
    "load_b2b_product_status_snapshots",
    "restore_b2b_product_status_snapshot",
    "save_b2b_product_status_to_db",
]


def load_b2b_product_status(
    *,
    db,
    gid: str | None = None,
    meta_only: bool = False,
    use_cache: bool = True,
) -> ProductStatusB2BOut:
    del use_cache
    return load_b2b_product_status_from_db(
        db,
        gid=gid,
        meta_only=meta_only,
    )
