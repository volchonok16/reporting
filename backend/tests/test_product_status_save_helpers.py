from app.product_status_save_helpers import apply_row_order, resolve_row
from app.schemas import ProductStatusCellUpdate


def test_apply_row_order_reorders_known_rows() -> None:
    db_rows = [
        {"id": 10, "cells": {}},
        {"id": 20, "cells": {}},
        {"id": 30, "cells": {}},
    ]
    ordered = apply_row_order(db_rows, [30, 10, 20])
    assert [row["id"] for row in ordered] == [30, 10, 20]


def test_apply_row_order_appends_unknown_rows() -> None:
    db_rows = [
        {"id": 10, "cells": {}},
        {"id": 20, "cells": {}},
    ]
    ordered = apply_row_order(db_rows, [20])
    assert [row["id"] for row in ordered] == [20, 10]


def test_resolve_row_by_id() -> None:
    update = ProductStatusCellUpdate(
        gid="0",
        rowIndex=1,
        columnIndex=0,
        value="x",
        rowId=20,
    )
    row = resolve_row(
        update,
        db_rows=[{"id": 10}, {"id": 20}],
        row_by_id={10: {"id": 10}, 20: {"id": 20}},
    )
    assert row == {"id": 20}


def test_resolve_row_without_id_uses_new_rows_map_not_index() -> None:
    """Prepended UI rows must not overwrite db_rows[0] via 1-based index."""
    update = ProductStatusCellUpdate(
        gid="0",
        rowIndex=1,
        columnIndex=0,
        value="new",
        rowId=None,
    )
    created = {"id": 99, "cells": {}}
    existing = {"id": 10, "cells": {"Дата запуска": "01.07"}}
    row = resolve_row(
        update,
        db_rows=[existing],
        row_by_id={10: existing},
        new_rows_by_index={1: created},
    )
    assert row is created


def test_resolve_row_without_new_map_falls_back_to_legacy_index() -> None:
    update = ProductStatusCellUpdate(
        gid="0",
        rowIndex=1,
        columnIndex=0,
        value="x",
        rowId=None,
    )
    existing = {"id": 10}
    row = resolve_row(
        update,
        db_rows=[existing],
        row_by_id={10: existing},
    )
    assert row is existing
