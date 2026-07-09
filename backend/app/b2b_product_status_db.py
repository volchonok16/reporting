from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.app_access import can_manage_org
from app.config import settings
from app.product_status_save_helpers import (
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

B2B_PRODUCT_STATUS_COLUMNS: tuple[str, ...] = (
    "Дата запуска",
    "Проект координация",
    "Полное Описание проекта и статус",
    "Для презентации Описание проекта и статус",
    "Зачем и для чего делаем",
    "ЗНИ",
    "Идет в презентацию",
    "Обратить внимание",
    "Комментарий",
)

WHY_COLUMN = "Зачем и для чего делаем"
_LEGACY_WHY_FULL_COLUMN = "Зачем и для чего делаем полное описание"
_LEGACY_WHY_PRESENTATION_COLUMN = "Зачем и для чего делаем для презентации"

ADMIN_ONLY_COLUMNS: frozenset[str] = frozenset()

_TITLE = "Статус продукта B2B"


def _empty_cells() -> dict[str, str]:
    return {column: "" for column in B2B_PRODUCT_STATUS_COLUMNS}


def _row_has_content(cells: dict[str, str]) -> bool:
    return any(str(value).strip() for value in cells.values())


def _merge_why_cell_value(source: dict[str, Any]) -> str:
    existing = source.get(WHY_COLUMN)
    if existing is not None and str(existing).strip():
        return "" if existing is None else str(existing)
    presentation = source.get(_LEGACY_WHY_PRESENTATION_COLUMN)
    if presentation is not None and str(presentation).strip():
        return str(presentation)
    full = source.get(_LEGACY_WHY_FULL_COLUMN)
    if full is not None and str(full).strip():
        return str(full)
    return "" if existing is None else str(existing or "")


def _normalize_cells(raw: dict[str, Any] | None) -> dict[str, str]:
    source = raw or {}
    cells = _empty_cells()
    for column in B2B_PRODUCT_STATUS_COLUMNS:
        if column == WHY_COLUMN:
            cells[column] = _merge_why_cell_value(source)
            continue
        value = source.get(column, "")
        cells[column] = "" if value is None else str(value)
    return cells


def _cells_json(cells: dict[str, str]) -> str:
    return json.dumps(cells, ensure_ascii=False)


def _office_snapshot_json(rows: list[dict[str, Any]]) -> str:
    payload = {
        "rows": [{"cells": _normalize_cells(row.get("cells"))} for row in rows],
    }
    return json.dumps(payload, ensure_ascii=False)


def _save_office_snapshot(
    db: Session,
    *,
    office_id: int,
    changed_by: str | None,
) -> None:
    rows = _load_office_rows(db, office_id=office_id)
    db.execute(
        text(
            """
            INSERT INTO b2b_product_status_snapshot (office_id, rows, changed_by)
            VALUES (:office_id, CAST(:rows AS jsonb), :changed_by)
            """
        ),
        {
            "office_id": office_id,
            "rows": _office_snapshot_json(rows),
            "changed_by": changed_by,
        },
    )


def _replace_office_rows_from_snapshot(
    db: Session,
    *,
    office_id: int,
    snapshot_rows: list[dict[str, Any]],
) -> None:
    db.execute(
        text("DELETE FROM b2b_product_status_row WHERE office_id = :office_id"),
        {"office_id": office_id},
    )
    for index, item in enumerate(snapshot_rows):
        cells = item.get("cells") if isinstance(item, dict) else {}
        db.execute(
            text(
                """
                INSERT INTO b2b_product_status_row (office_id, sort_order, cells)
                VALUES (:office_id, :sort_order, CAST(:cells AS jsonb))
                """
            ),
            {
                "office_id": office_id,
                "sort_order": index,
                "cells": _cells_json(_normalize_cells(cells if isinstance(cells, dict) else {})),
            },
        )


def _sheet_from_rows(*, gid: str, name: str, rows: list[dict[str, Any]]) -> ProductStatusSheetOut:
    sheet_rows: list[dict[str, str]] = []
    for row in rows:
        cells = _normalize_cells(row.get("cells"))
        if not _row_has_content(cells):
            continue
        payload = dict(cells)
        payload[ROW_ID_KEY] = str(row["id"])
        sheet_rows.append(payload)
    return ProductStatusSheetOut(
        gid=gid,
        name=name,
        columns=list(B2B_PRODUCT_STATUS_COLUMNS),
        rows=sheet_rows,
        totalShown=len(sheet_rows),
    )


def _load_offices(db: Session) -> list[dict[str, Any]]:
    result = db.execute(
        text(
            """
            SELECT id, gid, name
            FROM b2b_product_status_office
            WHERE is_active = TRUE
            ORDER BY sort_order, id
            """
        )
    )
    return [dict(row._mapping) for row in result]


def _load_office(db: Session, *, gid: str) -> dict[str, Any] | None:
    result = db.execute(
        text(
            """
            SELECT id, gid, name
            FROM b2b_product_status_office
            WHERE gid = :gid AND is_active = TRUE
            """
        ),
        {"gid": gid},
    )
    row = result.first()
    return dict(row._mapping) if row else None


def _load_office_rows(db: Session, *, office_id: int) -> list[dict[str, Any]]:
    result = db.execute(
        text(
            """
            SELECT id, cells, sort_order
            FROM b2b_product_status_row
            WHERE office_id = :office_id
            ORDER BY sort_order, id
            """
        ),
        {"office_id": office_id},
    )
    rows: list[dict[str, Any]] = []
    for row in result:
        mapping = dict(row._mapping)
        cells = mapping.get("cells")
        mapping["cells"] = cells if isinstance(cells, dict) else {}
        rows.append(mapping)
    return rows


def load_b2b_product_status_from_db(
    db: Session,
    *,
    gid: str | None = None,
    meta_only: bool = False,
) -> ProductStatusB2BOut:
    offices = _load_offices(db)
    if not offices:
        raise HTTPException(
            status_code=503,
            detail="Таблицы статуса продукта B2B не инициализированы.",
        )

    if gid:
        offices = [office for office in offices if office["gid"] == gid]
        if not offices:
            raise HTTPException(status_code=404, detail=f"Офис gid={gid} не найден.")

    sheets: list[ProductStatusSheetOut] = []
    for office in offices:
        if meta_only:
            sheets.append(
                ProductStatusSheetOut(
                    gid=office["gid"],
                    name=office["name"],
                    columns=list(B2B_PRODUCT_STATUS_COLUMNS),
                    rows=[],
                    totalShown=0,
                )
            )
            continue
        rows = _load_office_rows(db, office_id=int(office["id"]))
        sheets.append(
            _sheet_from_rows(
                gid=office["gid"],
                name=office["name"],
                rows=rows,
            )
        )

    return ProductStatusB2BOut(
        title=_TITLE,
        sourceUrl=None,
        presentationReferenceUrl=(
            settings.b2b_product_status_presentation_reference_url or None
        ),
        sheets=sheets,
    )


def _append_history(
    db: Session,
    *,
    row_id: int | None,
    office_id: int,
    office_name: str,
    action: str,
    field_name: str | None,
    old_value: str | None,
    new_value: str | None,
    changed_by: str | None,
) -> None:
    db.execute(
        text(
            """
            INSERT INTO b2b_product_status_history (
                row_id, office_id, office_name, action,
                field_name, old_value, new_value, changed_by
            ) VALUES (
                :row_id, :office_id, :office_name, :action,
                :field_name, :old_value, :new_value, :changed_by
            )
            """
        ),
        {
            "row_id": row_id,
            "office_id": office_id,
            "office_name": office_name,
            "action": action,
            "field_name": field_name,
            "old_value": old_value,
            "new_value": new_value,
            "changed_by": changed_by,
        },
    )


def _can_edit_admin_columns(meta: dict[str, Any]) -> bool:
    return can_manage_org(meta)


def _resolve_changed_by(meta: dict[str, Any]) -> str | None:
    login = meta.get("app_login")
    if isinstance(login, str) and login.strip():
        return login.strip()
    return None


def save_b2b_product_status_to_db(
    db: Session,
    payload: ProductStatusSaveIn,
    *,
    meta: dict[str, Any],
) -> None:
    can_edit_admin = _can_edit_admin_columns(meta)
    changed_by = _resolve_changed_by(meta)
    updates_by_gid: dict[str, list[ProductStatusCellUpdate]] = {}
    for update in payload.updates:
        updates_by_gid.setdefault(update.gid, []).append(update)

    deleted_by_gid: dict[str, set[int]] = {}
    for item in payload.deletedRows:
        deleted_by_gid.setdefault(item.gid, set()).add(item.rowId)

    processed_gids = set(updates_by_gid) | set(deleted_by_gid)
    for gid in processed_gids:
        office = _load_office(db, gid=gid)
        if office is None:
            raise HTTPException(status_code=404, detail=f"Офис gid={gid} не найден.")

        updates = updates_by_gid.get(gid, [])
        for update in updates:
            if update.rowIndex < 1:
                continue
            column = (
                update.column
                if update.column in B2B_PRODUCT_STATUS_COLUMNS
                else B2B_PRODUCT_STATUS_COLUMNS[update.columnIndex]
                if update.columnIndex < len(B2B_PRODUCT_STATUS_COLUMNS)
                else None
            )
            if column in ADMIN_ONLY_COLUMNS and not can_edit_admin:
                raise HTTPException(
                    status_code=403,
                    detail=f"Недостаточно прав для редактирования «{column}».",
                )

        office_id = int(office["id"])
        office_name = str(office["name"])
        db_rows = _load_office_rows(db, office_id=office_id)
        row_by_id = {int(row["id"]): row for row in db_rows}
        deleted_ids = deleted_by_gid.get(gid, set())

        for row_id in deleted_ids:
            row = row_by_id.get(row_id)
            if row is None:
                continue
            cells = _normalize_cells(row.get("cells"))
            _append_history(
                db,
                row_id=row_id,
                office_id=office_id,
                office_name=office_name,
                action="delete",
                field_name=None,
                old_value=str(cells.get("Проект координация") or cells.get("Дата запуска") or ""),
                new_value=None,
                changed_by=changed_by,
            )
            db.execute(
                text("DELETE FROM b2b_product_status_row WHERE id = :row_id AND office_id = :office_id"),
                {"row_id": row_id, "office_id": office_id},
            )
            row_by_id.pop(row_id, None)

        db_rows = [row for row in db_rows if int(row["id"]) not in deleted_ids]

        updates = updates_by_gid.get(gid, [])
        data_updates = [item for item in updates if item.rowIndex >= 1]
        max_row_index = max((item.rowIndex for item in data_updates), default=0)
        conflicts: list[str] = []

        while len(db_rows) < max_row_index:
            insert = db.execute(
                text(
                    """
                    INSERT INTO b2b_product_status_row (office_id, sort_order, cells)
                    VALUES (:office_id, :sort_order, CAST(:cells AS jsonb))
                    RETURNING id, cells, sort_order
                    """
                ),
                {
                    "office_id": office_id,
                    "sort_order": len(db_rows),
                    "cells": _cells_json(_empty_cells()),
                },
            )
            created = dict(insert.first()._mapping)
            created["cells"] = _normalize_cells(created.get("cells"))
            db_rows.append(created)
            _append_history(
                db,
                row_id=int(created["id"]),
                office_id=office_id,
                office_name=office_name,
                action="create",
                field_name=None,
                old_value=None,
                new_value=None,
                changed_by=changed_by,
            )

        for update in data_updates:
            row = resolve_row(update, db_rows=db_rows, row_by_id=row_by_id)
            if row is None:
                conflicts.append(f"строка {update.rowIndex}")
                continue
            row_id = int(row["id"])
            column = (
                update.column
                if update.column in B2B_PRODUCT_STATUS_COLUMNS
                else B2B_PRODUCT_STATUS_COLUMNS[update.columnIndex]
                if update.columnIndex < len(B2B_PRODUCT_STATUS_COLUMNS)
                else None
            )
            if column is None:
                continue
            if column in ADMIN_ONLY_COLUMNS and not can_edit_admin:
                raise HTTPException(
                    status_code=403,
                    detail=f"Недостаточно прав для редактирования «{column}».",
                )

            cells = _normalize_cells(row.get("cells"))
            current_value = cells.get(column, "")
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
                    table="b2b_product_status_row",
                    parent_column="office_id",
                    parent_id=office_id,
                    row_id=row_id,
                    column=column,
                    expected_value=expected_value,
                    new_value=new_value,
                )
                if not updated:
                    fresh_value = fetch_row_cell(
                        db,
                        table="b2b_product_status_row",
                        row_id=row_id,
                        column=column,
                        normalize_cells=_normalize_cells,
                    )
                    if fresh_value == new_value:
                        cells[column] = new_value
                        row["cells"] = cells
                        continue
                    conflicts.append(f"{column} (строка {update.rowIndex})")
                    continue
                cells[column] = new_value
                row["cells"] = cells
                _append_history(
                    db,
                    row_id=row_id,
                    office_id=office_id,
                    office_name=office_name,
                    action="update",
                    field_name=column,
                    old_value=expected_value,
                    new_value=new_value,
                    changed_by=changed_by,
                )
                continue

            old_value = current_value
            cells[column] = new_value
            db.execute(
                text(
                    """
                    UPDATE b2b_product_status_row
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
                office_id=office_id,
                office_name=office_name,
                action="update",
                field_name=column,
                old_value=old_value,
                new_value=new_value,
                changed_by=changed_by,
            )

        if conflicts:
            raise_save_conflicts(conflicts)

        for index, row in enumerate(db_rows):
            db.execute(
                text(
                    """
                    UPDATE b2b_product_status_row
                    SET sort_order = :sort_order
                    WHERE id = :row_id
                    """
                ),
                {"sort_order": index, "row_id": int(row["id"])},
            )

        _save_office_snapshot(
            db,
            office_id=office_id,
            changed_by=changed_by,
        )

    db.commit()


def delete_b2b_product_status_row(
    db: Session,
    *,
    gid: str,
    row_id: int,
    meta: dict[str, Any],
) -> None:
    office = _load_office(db, gid=gid)
    if office is None:
        raise HTTPException(status_code=404, detail=f"Офис gid={gid} не найден.")

    office_id = int(office["id"])
    rows = _load_office_rows(db, office_id=office_id)
    row = next((item for item in rows if int(item["id"]) == row_id), None)
    if row is None:
        raise HTTPException(status_code=404, detail="Строка не найдена.")

    cells = _normalize_cells(row.get("cells"))
    _append_history(
        db,
        row_id=row_id,
        office_id=office_id,
        office_name=str(office["name"]),
        action="delete",
        field_name=None,
        old_value=str(cells.get("Проект координация") or cells.get("Дата запуска") or ""),
        new_value=None,
        changed_by=_resolve_changed_by(meta),
    )
    db.execute(
        text("DELETE FROM b2b_product_status_row WHERE id = :row_id AND office_id = :office_id"),
        {"row_id": row_id, "office_id": office_id},
    )
    db.commit()


def load_b2b_product_status_history(
    db: Session,
    *,
    gid: str,
    limit: int = 100,
) -> ProductStatusHistoryOut:
    office = _load_office(db, gid=gid)
    if office is None:
        raise HTTPException(status_code=404, detail=f"Офис gid={gid} не найден.")

    result = db.execute(
        text(
            """
            SELECT id, row_id, office_name, action, field_name,
                   old_value, new_value, changed_by, changed_at
            FROM b2b_product_status_history
            WHERE office_id = :office_id
            ORDER BY changed_at DESC, id DESC
            LIMIT :limit
            """
        ),
        {"office_id": int(office["id"]), "limit": limit},
    )
    items = [
        ProductStatusHistoryEntryOut(
            id=int(row.id),
            rowId=int(row.row_id) if row.row_id is not None else None,
            officeName=str(row.office_name),
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


def load_b2b_product_status_snapshots(
    db: Session,
    *,
    gid: str,
    limit: int = 50,
) -> ProductStatusSnapshotsOut:
    office = _load_office(db, gid=gid)
    if office is None:
        raise HTTPException(status_code=404, detail=f"Офис gid={gid} не найден.")

    result = db.execute(
        text(
            """
            SELECT id, rows, changed_by, created_at
            FROM b2b_product_status_snapshot
            WHERE office_id = :office_id
            ORDER BY created_at DESC, id DESC
            LIMIT :limit
            """
        ),
        {"office_id": int(office["id"]), "limit": limit},
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


def restore_b2b_product_status_snapshot(
    db: Session,
    *,
    snapshot_id: int,
    gid: str,
    meta: dict[str, Any],
) -> None:
    office = _load_office(db, gid=gid)
    if office is None:
        raise HTTPException(status_code=404, detail=f"Офис gid={gid} не найден.")

    office_id = int(office["id"])
    office_name = str(office["name"])
    result = db.execute(
        text(
            """
            SELECT id, rows, created_at
            FROM b2b_product_status_snapshot
            WHERE id = :snapshot_id AND office_id = :office_id
            """
        ),
        {"snapshot_id": snapshot_id, "office_id": office_id},
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
    _replace_office_rows_from_snapshot(
        db,
        office_id=office_id,
        snapshot_rows=snapshot_rows,
    )
    _append_history(
        db,
        row_id=None,
        office_id=office_id,
        office_name=office_name,
        action="restore",
        field_name=None,
        old_value=None,
        new_value=f"Версия от {version_label}",
        changed_by=changed_by,
    )
    _save_office_snapshot(
        db,
        office_id=office_id,
        changed_by=changed_by,
    )
    db.commit()
