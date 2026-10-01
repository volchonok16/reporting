from app.gov_initiatives_db import (
    ROW_ID_KEY,
    GOV_INITIATIVE_SECTION_COLUMNS,
    delete_gov_initiative_row,
    load_gov_initiatives_from_db,
    load_gov_initiatives_history,
    load_gov_initiatives_snapshots,
    restore_gov_initiative_snapshot,
    save_gov_initiatives_to_db,
)
from app.schemas import ProductStatusB2BOut

__all__ = [
    "GOV_INITIATIVE_SECTION_COLUMNS",
    "ROW_ID_KEY",
    "delete_gov_initiative_row",
    "load_gov_initiatives",
    "load_gov_initiatives_from_db",
    "load_gov_initiatives_history",
    "load_gov_initiatives_snapshots",
    "restore_gov_initiative_snapshot",
    "save_gov_initiatives_to_db",
]


def load_gov_initiatives(
    *,
    db,
    gid: str | None = None,
    meta_only: bool = False,
    use_cache: bool = True,
) -> ProductStatusB2BOut:
    del use_cache
    return load_gov_initiatives_from_db(
        db,
        gid=gid,
        meta_only=meta_only,
    )
