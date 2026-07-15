from app.revenue_activities_db import (
    ROW_ID_KEY,
    REVENUE_ACTIVITY_SECTION_COLUMNS,
    delete_revenue_activity_row,
    load_revenue_activities_from_db,
    load_revenue_activities_history,
    load_revenue_activities_snapshots,
    restore_revenue_activity_snapshot,
    save_revenue_activities_to_db,
)
from app.schemas import ProductStatusB2BOut

__all__ = [
    "REVENUE_ACTIVITY_SECTION_COLUMNS",
    "ROW_ID_KEY",
    "delete_revenue_activity_row",
    "load_revenue_activities",
    "load_revenue_activities_from_db",
    "load_revenue_activities_history",
    "load_revenue_activities_snapshots",
    "restore_revenue_activity_snapshot",
    "save_revenue_activities_to_db",
]


def load_revenue_activities(
    *,
    db,
    gid: str | None = None,
    meta_only: bool = False,
    use_cache: bool = True,
) -> ProductStatusB2BOut:
    del use_cache
    return load_revenue_activities_from_db(
        db,
        gid=gid,
        meta_only=meta_only,
    )
