from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.product_status_save_helpers import (
    apply_row_order,
    fetch_row_cell,
    raise_save_conflicts,
    resolve_row,
    update_row_cell_if_expected,
)
from app.schemas import (
    ProductStatusB2BOut,
    ProductStatusCellUpdate,
    ProductStatusHistoryEntryOut,
    ProductStatusHistoryOut,
    ProductStatusSaveIn,
    ProductStatusSheetOut,
    ProductStatusSnapshotOut,
    ProductStatusSnapshotsOut,
)

ROW_ID_KEY = "__rowId"

REVENUE_NUMERIC_COLUMNS: tuple[str, ...] = (
    "Влияние на базу, тыс",
    "Влияние на выручку, млн",
    "Влияние на gmc, млн",
)

REVENUE_ACTIVITY_SECTION_COLUMNS: dict[str, tuple[str, ...]] = {
    "main": (
        "Активность",
        "Статус F2 2026",
        "Ответственный",
        "Влияние на базу, тыс",
        "Влияние на выручку, млн",
        "Влияние на gmc, млн",
        "Комментарий",
    ),
}

# Старые ключи cells → актуальные колонки (после переименований)
_COLUMN_SOURCE_KEYS: dict[str, tuple[str, ...]] = {
    "Статус F2 2026": ("Статус F2 2026", "Статус"),
    "Влияние на базу, тыс": ("Влияние на базу, тыс", "Влияние на базу"),
    "Влияние на выручку, млн": ("Влияние на выручку, млн", "Влияние на выручку"),
    "Влияние на gmc, млн": ("Влияние на gmc, млн", "Влияние на gmc", "Влияние на jmc"),
}

_TITLE = "Активности по выручкам"


def columns_for_section_gid(gid: str) -> tuple[str, ...]:
    columns = REVENUE_ACTIVITY_SECTION_COLUMNS.get(gid)
    if columns is None:
        raise HTTPException(status_code=404, detail=f"Вкладка gid={gid} не найдена.")
    return columns


def _empty_cells(columns: tuple[str, ...]) -> dict[str, str]:
    return {column: "" for column in columns}


def _parse_numeric(value: str) -> float | None:
    text = (
        str(value or "")
        .strip()
        .replace("\u00a0", "")
        .replace(" ", "")
        .replace(",", ".")
    )
    if not text:
        return None
    try:
        parsed = float(text)
    except ValueError:
        return None
    if parsed != parsed:  # NaN
        return None
    return parsed


def _format_numeric(value: float) -> str:
    if value == int(value):
        return str(int(value))
    return f"{value:.12g}"


def _source_cell_value(source: dict[str, Any], column: str) -> str:
    for key in _COLUMN_SOURCE_KEYS.get(column, (column,)):
        if key in source and source.get(key) is not None:
            return str(source.get(key))
    value = source.get(column, "")
    return "" if value is None else str(value)


def _row_has_content(cells: dict[str, str]) -> bool:
    return any(str(value).strip() for value in cells.values())


def _normalize_cells(raw: dict[str, Any] | None, *, columns: tuple[str, ...]) -> dict[str, str]:
    source = raw or {}
    cells = _empty_cells(columns)
    for column in columns:
        cells[column] = _source_cell_value(source, column)
    return cells


def _cells_json(cells: dict[str, str]) -> str:
    return json.dumps(cells, ensure_ascii=False)


def _section_snapshot_json(rows: list[dict[str, Any]], *, columns: tuple[str, ...]) -> str:
    payload = {
        "rows": [{"cells": _normalize_cells(row.get("cells"), columns=columns)} for row in rows],
    }
    return json.dumps(payload, ensure_ascii=False)


def _row_summary(cells: dict[str, str], *, columns: tuple[str, ...]) -> str:
    for column in columns:
        value = str(cells.get(column) or "").strip()
        if value:
            return value
    return ""


def _save_section_snapshot(
    db: Session,
    *,
    section_id: int,
    columns: tuple[str, ...],
    changed_by: str | None,
) -> None:
    rows = _load_section_rows(db, section_id=section_id)
    db.execute(
        text(
            """
            INSERT INTO revenue_activity_snapshot (section_id, rows, changed_by)
            VALUES (:section_id, CAST(:rows AS jsonb), :changed_by)
            """
        ),
        {
            "section_id": section_id,
            "rows": _section_snapshot_json(rows, columns=columns),
            "changed_by": changed_by,
        },
    )


def _replace_section_rows_from_snapshot(
    db: Session,
    *,
    section_id: int,
    columns: tuple[str, ...],
    snapshot_rows: list[dict[str, Any]],
) -> None:
    db.execute(
        text("DELETE FROM revenue_activity_row WHERE section_id = :section_id"),
        {"section_id": section_id},
    )
    for index, item in enumerate(snapshot_rows):
        cells = item.get("cells") if isinstance(item, dict) else {}
        db.execute(
            text(
                """
                INSERT INTO revenue_activity_row (section_id, sort_order, cells)
                VALUES (:section_id, :sort_order, CAST(:cells AS jsonb))
                """
            ),
            {
                "section_id": section_id,
                "sort_order": index,
                "cells": _cells_json(
                    _normalize_cells(cells if isinstance(cells, dict) else {}, columns=columns)
                ),
            },
        )


def _sheet_from_rows(
    *,
    gid: str,
    name: str,
    columns: tuple[str, ...],
    rows: list[dict[str, Any]],
) -> ProductStatusSheetOut:
    sheet_rows: list[dict[str, str]] = []
    for row in rows:
        cells = _normalize_cells(row.get("cells"), columns=columns)
        payload = dict(cells)
        payload[ROW_ID_KEY] = str(row["id"])
        sheet_rows.append(payload)
    return ProductStatusSheetOut(
        gid=gid,
        name=name,
        columns=list(columns),
        rows=sheet_rows,
        totalShown=len(sheet_rows),
    )


def _load_sections(db: Session) -> list[dict[str, Any]]:
    result = db.execute(
        text(
            """
            SELECT id, gid, name
            FROM revenue_activity_section
            WHERE is_active = TRUE
            ORDER BY sort_order, id
            """
        )
    )
    return [dict(row._mapping) for row in result]


def _load_section(db: Session, *, gid: str) -> dict[str, Any] | None:
    result = db.execute(
        text(
            """
            SELECT id, gid, name
            FROM revenue_activity_section
            WHERE gid = :gid AND is_active = TRUE
            """
        ),
        {"gid": gid},
    )
    row = result.first()
    return dict(row._mapping) if row else None


def _load_section_rows(db: Session, *, section_id: int) -> list[dict[str, Any]]:
    result = db.execute(
        text(
            """
            SELECT id, cells, sort_order
            FROM revenue_activity_row
            WHERE section_id = :section_id
            ORDER BY sort_order, id
            """
        ),
        {"section_id": section_id},
    )
    rows: list[dict[str, Any]] = []
    for row in result:
        mapping = dict(row._mapping)
        cells = mapping.get("cells")
        mapping["cells"] = cells if isinstance(cells, dict) else {}
        rows.append(mapping)
    return rows


def load_revenue_activities_from_db(
    db: Session,
    *,
    gid: str | None = None,
    meta_only: bool = False,
) -> ProductStatusB2BOut:
    sections = _load_sections(db)
    if not sections:
        raise HTTPException(
            status_code=503,
            detail="Таблицы «Активности по выручкам» не инициализированы.",
        )

    if gid:
        sections = [section for section in sections if section["gid"] == gid]
        if not sections:
            raise HTTPException(status_code=404, detail=f"Вкладка gid={gid} не найдена.")

    sheets: list[ProductStatusSheetOut] = []
    for section in sections:
        section_gid = str(section["gid"])
        columns = columns_for_section_gid(section_gid)
        if meta_only:
            sheets.append(
                ProductStatusSheetOut(
                    gid=section_gid,
                    name=str(section["name"]),
                    columns=list(columns),
                    rows=[],
                    totalShown=0,
                )
            )
            continue
        rows = _load_section_rows(db, section_id=int(section["id"]))
        sheets.append(
            _sheet_from_rows(
                gid=section_gid,
                name=str(section["name"]),
                columns=columns,
                rows=rows,
            )
        )

    return ProductStatusB2BOut(
        title=_TITLE,
        sourceUrl=None,
        presentationReferenceUrl=None,
        sheets=sheets,
    )


def _append_history(
    db: Session,
    *,
    row_id: int | None,
    section_id: int,
    section_name: str,
    action: str,
    field_name: str | None,
    old_value: str | None,
    new_value: str | None,
    changed_by: str | None,
) -> None:
    db.execute(
        text(
            """
            INSERT INTO revenue_activity_history (
                row_id, section_id, section_name, action,
                field_name, old_value, new_value, changed_by
            ) VALUES (
                :row_id, :section_id, :section_name, :action,
                :field_name, :old_value, :new_value, :changed_by
            )
            """
        ),
        {
            "row_id": row_id,
            "section_id": section_id,
            "section_name": section_name,
            "action": action,
            "field_name": field_name,
            "old_value": old_value,
            "new_value": new_value,
            "changed_by": changed_by,
        },
    )


def _resolve_changed_by(meta: dict[str, Any]) -> str | None:
    login = meta.get("app_login")
    if isinstance(login, str) and login.strip():
        return login.strip()
    return None


def _resolve_column(
    update: ProductStatusCellUpdate,
    *,
    columns: tuple[str, ...],
) -> str | None:
    if update.column and update.column in columns:
        return update.column
    if update.columnIndex < len(columns):
        return columns[update.columnIndex]
    return None


def save_revenue_activities_to_db(
    db: Session,
    payload: ProductStatusSaveIn,
    *,
    meta: dict[str, Any],
) -> None:
    changed_by = _resolve_changed_by(meta)
    updates_by_gid: dict[str, list[ProductStatusCellUpdate]] = {}
    for update in payload.updates:
        updates_by_gid.setdefault(update.gid, []).append(update)

    deleted_by_gid: dict[str, set[int]] = {}
    for item in payload.deletedRows:
        deleted_by_gid.setdefault(item.gid, set()).add(item.rowId)

    row_order_by_gid: dict[str, list[int]] = {}
    for item in payload.rowOrder:
        row_order_by_gid[item.gid] = list(item.rowIds)

    processed_gids = set(updates_by_gid) | set(deleted_by_gid) | set(row_order_by_gid)
    for section_gid in processed_gids:
        section = _load_section(db, gid=section_gid)
        if section is None:
            raise HTTPException(status_code=404, detail=f"Вкладка gid={section_gid} не найдена.")

        columns = columns_for_section_gid(section_gid)
        section_id = int(section["id"])
        section_name = str(section["name"])
        db_rows = _load_section_rows(db, section_id=section_id)
        row_by_id = {int(row["id"]): row for row in db_rows}
        deleted_ids = deleted_by_gid.get(section_gid, set())

        for row_id in deleted_ids:
            row = row_by_id.get(row_id)
            if row is None:
                continue
            cells = _normalize_cells(row.get("cells"), columns=columns)
            _append_history(
                db,
                row_id=row_id,
                section_id=section_id,
                section_name=section_name,
                action="delete",
                field_name=None,
                old_value=_row_summary(cells, columns=columns) or None,
                new_value=None,
                changed_by=changed_by,
            )
            db.execute(
                text(
                    "DELETE FROM revenue_activity_row WHERE id = :row_id AND section_id = :section_id"
                ),
                {"row_id": row_id, "section_id": section_id},
            )
            row_by_id.pop(row_id, None)

        db_rows = [row for row in db_rows if int(row["id"]) not in deleted_ids]

        updates = updates_by_gid.get(section_gid, [])
        data_updates = [item for item in updates if item.rowIndex >= 1]
        conflicts: list[str] = []

        # Updates without rowId are always new rows — never overwrite existing by index
        # (index matching wiped the table when empty rows were prepended in the UI).
        new_rows_by_index: dict[int, dict[str, Any]] = {}
        for row_index in sorted({item.rowIndex for item in data_updates if item.rowId is None}):
            insert = db.execute(
                text(
                    """
                    INSERT INTO revenue_activity_row (section_id, sort_order, cells)
                    VALUES (:section_id, :sort_order, CAST(:cells AS jsonb))
                    RETURNING id, cells, sort_order
                    """
                ),
                {
                    "section_id": section_id,
                    "sort_order": len(db_rows),
                    "cells": _cells_json(_empty_cells(columns)),
                },
            )
            created = dict(insert.first()._mapping)
            created["cells"] = _normalize_cells(created.get("cells"), columns=columns)
            db_rows.append(created)
            row_by_id[int(created["id"])] = created
            new_rows_by_index[row_index] = created
            _append_history(
                db,
                row_id=int(created["id"]),
                section_id=section_id,
                section_name=section_name,
                action="create",
                field_name=None,
                old_value=None,
                new_value=None,
                changed_by=changed_by,
            )

        for update in data_updates:
            row = resolve_row(
                update,
                db_rows=db_rows,
                row_by_id=row_by_id,
                new_rows_by_index=new_rows_by_index,
            )
            if row is None:
                conflicts.append(f"строка {update.rowIndex}")
                continue
            row_id = int(row["id"])
            column = _resolve_column(update, columns=columns)
            if column is None:
                continue

            stored = row.get("cells") if isinstance(row.get("cells"), dict) else {}
            current_value = "" if stored.get(column) is None else str(stored.get(column, ""))
            new_value = update.value
            if current_value == new_value:
                continue

            expected_value = (
                update.expectedValue
                if update.expectedValue is not None
                else current_value
            )
            if update.rowId is not None:
                updated = update_row_cell_if_expected(
                    db,
                    table="revenue_activity_row",
                    parent_column="section_id",
                    parent_id=section_id,
                    row_id=row_id,
                    column=column,
                    expected_value=expected_value,
                    new_value=new_value,
                )
                if not updated:
                    fresh_value = fetch_row_cell(
                        db,
                        table="revenue_activity_row",
                        row_id=row_id,
                        column=column,
                        normalize_cells=lambda raw: _normalize_cells(raw, columns=columns),
                    )
                    if fresh_value == new_value:
                        cells = _normalize_cells(
                            {**stored, column: new_value},
                            columns=columns,
                        )
                        row["cells"] = cells
                        continue
                    conflicts.append(f"{column} (строка {update.rowIndex})")
                    continue
                cells = _normalize_cells({**stored, column: new_value}, columns=columns)
                row["cells"] = cells
                _append_history(
                    db,
                    row_id=row_id,
                    section_id=section_id,
                    section_name=section_name,
                    action="update",
                    field_name=column,
                    old_value=expected_value,
                    new_value=new_value,
                    changed_by=changed_by,
                )
                continue

            old_value = current_value
            cells = _normalize_cells({**stored, column: new_value}, columns=columns)
            db.execute(
                text(
                    """
                    UPDATE revenue_activity_row
                    SET cells = CAST(:cells AS jsonb),
                        updated_at = :updated_at
                    WHERE id = :row_id
                    """
                ),
                {
                    "cells": _cells_json(cells),
                    "updated_at": datetime.now(UTC),
                    "row_id": row_id,
                },
            )
            row["cells"] = cells
            _append_history(
                db,
                row_id=row_id,
                section_id=section_id,
                section_name=section_name,
                action="update",
                field_name=column,
                old_value=old_value,
                new_value=new_value,
                changed_by=changed_by,
            )

        if conflicts:
            raise_save_conflicts(conflicts)

        db_rows = apply_row_order(db_rows, row_order_by_gid.get(section_gid))

        for index, row in enumerate(db_rows):
            cells = _normalize_cells(row.get("cells"), columns=columns)
            row["cells"] = cells
            db.execute(
                text(
                    """
                    UPDATE revenue_activity_row
                    SET sort_order = :sort_order,
                        cells = CAST(:cells AS jsonb),
                        updated_at = :updated_at
                    WHERE id = :row_id
                    """
                ),
                {
                    "sort_order": index,
                    "cells": _cells_json(cells),
                    "updated_at": datetime.now(UTC),
                    "row_id": int(row["id"]),
                },
            )

        _save_section_snapshot(
            db,
            section_id=section_id,
            columns=columns,
            changed_by=changed_by,
        )

    db.commit()


def delete_revenue_activity_row(
    db: Session,
    *,
    gid: str,
    row_id: int,
    meta: dict[str, Any],
) -> None:
    section = _load_section(db, gid=gid)
    if section is None:
        raise HTTPException(status_code=404, detail=f"Вкладка gid={gid} не найдена.")

    columns = columns_for_section_gid(gid)
    section_id = int(section["id"])
    rows = _load_section_rows(db, section_id=section_id)
    row = next((item for item in rows if int(item["id"]) == row_id), None)
    if row is None:
        raise HTTPException(status_code=404, detail="Строка не найдена.")

    cells = _normalize_cells(row.get("cells"), columns=columns)
    _append_history(
        db,
        row_id=row_id,
        section_id=section_id,
        section_name=str(section["name"]),
        action="delete",
        field_name=None,
        old_value=_row_summary(cells, columns=columns) or None,
        new_value=None,
        changed_by=_resolve_changed_by(meta),
    )
    db.execute(
        text("DELETE FROM revenue_activity_row WHERE id = :row_id AND section_id = :section_id"),
        {"row_id": row_id, "section_id": section_id},
    )
    db.commit()


def load_revenue_activities_history(
    db: Session,
    *,
    gid: str,
    limit: int = 100,
) -> ProductStatusHistoryOut:
    section = _load_section(db, gid=gid)
    if section is None:
        raise HTTPException(status_code=404, detail=f"Вкладка gid={gid} не найдена.")

    result = db.execute(
        text(
            """
            SELECT id, row_id, section_name, action, field_name,
                   old_value, new_value, changed_by, changed_at
            FROM revenue_activity_history
            WHERE section_id = :section_id
            ORDER BY changed_at DESC, id DESC
            LIMIT :limit
            """
        ),
        {"section_id": int(section["id"]), "limit": limit},
    )
    items = [
        ProductStatusHistoryEntryOut(
            id=int(row.id),
            rowId=int(row.row_id) if row.row_id is not None else None,
            officeName=str(row.section_name),
            action=str(row.action),
            fieldName=str(row.field_name) if row.field_name else None,
            oldValue=str(row.old_value) if row.old_value is not None else None,
            newValue=str(row.new_value) if row.new_value is not None else None,
            changedBy=str(row.changed_by) if row.changed_by else None,
            changedAt=row.changed_at.isoformat() if row.changed_at else "",
        )
        for row in result
    ]
    return ProductStatusHistoryOut(items=items)


def load_revenue_activities_snapshots(
    db: Session,
    *,
    gid: str,
    limit: int = 50,
) -> ProductStatusSnapshotsOut:
    section = _load_section(db, gid=gid)
    if section is None:
        raise HTTPException(status_code=404, detail=f"Вкладка gid={gid} не найдена.")

    result = db.execute(
        text(
            """
            SELECT id, rows, changed_by, created_at
            FROM revenue_activity_snapshot
            WHERE section_id = :section_id
            ORDER BY created_at DESC, id DESC
            LIMIT :limit
            """
        ),
        {"section_id": int(section["id"]), "limit": limit},
    )
    items: list[ProductStatusSnapshotOut] = []
    for row in result:
        raw_rows = row.rows if isinstance(row.rows, dict) else {}
        snapshot_rows = raw_rows.get("rows") if isinstance(raw_rows, dict) else []
        row_count = len(snapshot_rows) if isinstance(snapshot_rows, list) else 0
        items.append(
            ProductStatusSnapshotOut(
                id=int(row.id),
                rowCount=row_count,
                changedBy=str(row.changed_by) if row.changed_by else None,
                createdAt=row.created_at.isoformat() if row.created_at else "",
            )
        )
    return ProductStatusSnapshotsOut(items=items)


def restore_revenue_activity_snapshot(
    db: Session,
    *,
    snapshot_id: int,
    gid: str,
    meta: dict[str, Any],
) -> None:
    section = _load_section(db, gid=gid)
    if section is None:
        raise HTTPException(status_code=404, detail=f"Вкладка gid={gid} не найдена.")

    columns = columns_for_section_gid(gid)
    section_id = int(section["id"])
    section_name = str(section["name"])
    result = db.execute(
        text(
            """
            SELECT id, rows, created_at
            FROM revenue_activity_snapshot
            WHERE id = :snapshot_id AND section_id = :section_id
            """
        ),
        {"snapshot_id": snapshot_id, "section_id": section_id},
    )
    snapshot = result.first()
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Версия не найдена.")

    raw_rows = snapshot.rows if isinstance(snapshot.rows, dict) else {}
    snapshot_rows = raw_rows.get("rows") if isinstance(raw_rows, dict) else []
    if not isinstance(snapshot_rows, list):
        raise HTTPException(status_code=400, detail="Некорректный снимок версии.")

    changed_by = _resolve_changed_by(meta)
    version_label = (
        snapshot.created_at.isoformat() if snapshot.created_at else str(snapshot_id)
    )
    _replace_section_rows_from_snapshot(
        db,
        section_id=section_id,
        columns=columns,
        snapshot_rows=snapshot_rows,
    )
    _append_history(
        db,
        row_id=None,
        section_id=section_id,
        section_name=section_name,
        action="restore",
        field_name=None,
        old_value=None,
        new_value=f"Версия от {version_label}",
        changed_by=changed_by,
    )
    _save_section_snapshot(
        db,
        section_id=section_id,
        columns=columns,
        changed_by=changed_by,
    )
    db.commit()
