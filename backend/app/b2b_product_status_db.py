from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.app_access import can_manage_org, is_superadmin_user
from app.config import settings
from app.product_status_rich_text import display_cell_text, parse_embedded_table_doc
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
    ProductStatusPriorityRangeOut,
    ProductStatusSaveIn,
    ProductStatusSheetOut,
    ProductStatusSnapshotOut,
    ProductStatusSnapshotsOut,
)

from app.b2b_product_status_attachments import (
    ATTACHMENTS_COLUMN,
    ATTACHMENTS_JSON_KEY,
    delete_storage_objects,
    list_storage_keys_for_rows,
    load_attachments_by_row_ids,
)

ROW_ID_KEY = "__rowId"

SUMMARY_GID = "summary"
SUMMARY_SHEET_NAME = "Сводка"
SUMMARY_OFFICE_COLUMN = "Офис"
SUMMARY_STATUS_COLUMN = "Статус"
SUMMARY_PROJECT_TITLE_KEY = "__summaryTitle"
SUMMARY_COLUMNS: tuple[str, ...] = (
    SUMMARY_OFFICE_COLUMN,
    SUMMARY_STATUS_COLUMN,
    "Зачем и для чего делаем",
    ATTACHMENTS_COLUMN,
)
_COORDINATION_COLUMN = "Проект координация"
_FULL_STATUS_COLUMN = "Полное Описание проекта и статус"
_PRESENTATION_STATUS_COLUMN = "Для презентации Описание проекта и статус"
_PRESENTATION_FLAG_COLUMN = "Идет в презентацию"

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
    ATTACHMENTS_COLUMN,
    "Приоритет",
    "Неактуальное",
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
        if column == ATTACHMENTS_COLUMN:
            # Файлы живут в b2b_product_status_attachment, не в cells.
            cells[column] = ""
            continue
        if column == WHY_COLUMN:
            cells[column] = _merge_why_cell_value(source)
            continue
        value = source.get(column, "")
        cells[column] = "" if value is None else str(value)
    return cells


def _attach_files_to_row_payload(
    payload: dict[str, str],
    attachments: list[dict[str, Any]],
) -> dict[str, str]:
    if attachments:
        payload[ATTACHMENTS_COLUMN] = ", ".join(
            str(item.get("filename") or "") for item in attachments if item.get("filename")
        )
        payload[ATTACHMENTS_JSON_KEY] = json.dumps(attachments, ensure_ascii=False)
    else:
        payload[ATTACHMENTS_COLUMN] = ""
        payload[ATTACHMENTS_JSON_KEY] = "[]"
    return payload


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


def _iso_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    text_value = str(value).strip()
    return text_value or None


def _sheet_from_rows(
    *,
    gid: str,
    name: str,
    rows: list[dict[str, Any]],
    projects: list[str] | None = None,
    project_priority_ranges: dict[str, ProductStatusPriorityRangeOut] | None = None,
    editing_locked: bool = False,
    editing_locked_at: Any = None,
    editing_unlocked_at: Any = None,
    attachments_by_row: dict[int, list[dict[str, Any]]] | None = None,
) -> ProductStatusSheetOut:
    files_by_row = attachments_by_row or {}
    sheet_rows: list[dict[str, str]] = []
    for row in rows:
        cells = _normalize_cells(row.get("cells"))
        payload = dict(cells)
        payload[ROW_ID_KEY] = str(row["id"])
        row_id = int(row["id"])
        _attach_files_to_row_payload(payload, files_by_row.get(row_id, []))
        sheet_rows.append(payload)
    return ProductStatusSheetOut(
        gid=gid,
        name=name,
        columns=list(B2B_PRODUCT_STATUS_COLUMNS),
        rows=sheet_rows,
        totalShown=len(sheet_rows),
        projects=list(projects or []),
        projectPriorityRanges=dict(project_priority_ranges or {}),
        editingLocked=bool(editing_locked),
        editingLockedAt=_iso_timestamp(editing_locked_at),
        editingUnlockedAt=_iso_timestamp(editing_unlocked_at),
    )


def _office_summary_label(name: str) -> str:
    raw = (name or "").strip()
    prefix = "Офис:"
    if raw.casefold().startswith(prefix.casefold()):
        return raw[len(prefix) :].strip() or raw
    return raw


def _is_presentation_flag_yes(value: str) -> bool:
    normalized = display_cell_text(value or "").strip().casefold()
    if normalized in ("нет", "no", "0", "false"):
        return False
    return normalized in ("да", "yes", "1", "true")


def _copy_cell_preserving_table(primary: str, fallback: str = "") -> str:
    """В сводку уходит исходная ячейка, в том числе вставленная таблица."""
    if parse_embedded_table_doc(primary) is not None:
        return primary
    if fallback and parse_embedded_table_doc(fallback) is not None:
        return fallback
    return primary


def build_summary_rows(
    offices_with_rows: list[tuple[dict[str, Any], list[dict[str, Any]]]],
    *,
    attachments_by_row: dict[int, list[dict[str, Any]]] | None = None,
) -> list[dict[str, str]]:
    """Строки сводки: офисы в их порядке, внутри — порядок строк офиса."""
    files_by_row = attachments_by_row or {}
    rows: list[dict[str, str]] = []
    for office, office_rows in offices_with_rows:
        office_gid = str(office["gid"])
        office_name = str(office["name"])
        for row in office_rows:
            cells = _normalize_cells(row.get("cells"))
            if not _is_presentation_flag_yes(cells.get(_PRESENTATION_FLAG_COLUMN, "")):
                continue
            source_row_id = int(row["id"])
            payload = {
                SUMMARY_OFFICE_COLUMN: _office_summary_label(office_name),
                SUMMARY_STATUS_COLUMN: _copy_cell_preserving_table(
                    cells.get(_PRESENTATION_STATUS_COLUMN, ""),
                    cells.get(_FULL_STATUS_COLUMN, ""),
                ),
                WHY_COLUMN: _copy_cell_preserving_table(cells.get(WHY_COLUMN, "")),
                SUMMARY_PROJECT_TITLE_KEY: cells.get(_COORDINATION_COLUMN, ""),
                ROW_ID_KEY: f"{SUMMARY_GID}-{office_gid}-{source_row_id}",
            }
            _attach_files_to_row_payload(payload, files_by_row.get(source_row_id, []))
            rows.append(payload)
    return rows


def _summary_sheet(rows: list[dict[str, str]] | None = None) -> ProductStatusSheetOut:
    sheet_rows = list(rows or [])
    return ProductStatusSheetOut(
        gid=SUMMARY_GID,
        name=SUMMARY_SHEET_NAME,
        columns=list(SUMMARY_COLUMNS),
        rows=sheet_rows,
        totalShown=len(sheet_rows),
        projects=[],
        projectPriorityRanges={},
        editingLocked=True,
        readOnly=True,
    )


def _load_summary_sheet(db: Session, *, offices: list[dict[str, Any]], meta_only: bool) -> ProductStatusSheetOut:
    if meta_only:
        return _summary_sheet()
    packed: list[tuple[dict[str, Any], list[dict[str, Any]]]] = [
        (office, _load_office_rows(db, office_id=int(office["id"])))
        for office in offices
    ]
    row_ids = [int(row["id"]) for _, office_rows in packed for row in office_rows]
    attachments_by_row = load_attachments_by_row_ids(db, row_ids)
    return _summary_sheet(build_summary_rows(packed, attachments_by_row=attachments_by_row))


def _load_offices(db: Session) -> list[dict[str, Any]]:
    result = db.execute(
        text(
            """
            SELECT id, gid, name, editing_locked, editing_locked_at, editing_unlocked_at
            FROM b2b_product_status_office
            WHERE is_active = TRUE
            ORDER BY sort_order, id
            """
        )
    )
    return [dict(row._mapping) for row in result]


def _load_office_projects(db: Session, *, office_ids: list[int]) -> dict[int, list[str]]:
    if not office_ids:
        return {}
    result = db.execute(
        text(
            """
            SELECT office_id, name
            FROM b2b_product_status_project
            WHERE is_active = TRUE
              AND office_id = ANY(:office_ids)
            ORDER BY office_id, sort_order, id
            """
        ),
        {"office_ids": office_ids},
    )
    by_office: dict[int, list[str]] = {}
    for row in result:
        office_id = int(row._mapping["office_id"])
        by_office.setdefault(office_id, []).append(str(row._mapping["name"]))
    return by_office


def _load_office_project_priority_ranges(
    db: Session,
    *,
    office_ids: list[int],
) -> dict[int, dict[str, ProductStatusPriorityRangeOut]]:
    """office_id → { project_name: {rangeFrom, rangeTo} } — один диапазон на проект."""
    if not office_ids:
        return {}
    result = db.execute(
        text(
            """
            SELECT DISTINCT ON (p.office_id, p.id)
                   p.office_id,
                   p.name AS project_name,
                   pr.range_from,
                   pr.range_to
            FROM b2b_product_status_project AS p
            JOIN b2b_product_status_project_priority AS pr
              ON pr.project_id = p.id
             AND pr.is_active = TRUE
            WHERE p.is_active = TRUE
              AND p.office_id = ANY(:office_ids)
            ORDER BY p.office_id, p.id, pr.sort_order, pr.range_from, pr.id
            """
        ),
        {"office_ids": office_ids},
    )
    by_office: dict[int, dict[str, ProductStatusPriorityRangeOut]] = {}
    for row in result:
        mapping = row._mapping
        range_from = mapping.get("range_from")
        range_to = mapping.get("range_to")
        if range_from is None or range_to is None:
            continue
        from_value = int(range_from)
        to_value = int(range_to)
        if from_value < 1 or to_value < from_value:
            continue
        office_id = int(mapping["office_id"])
        project_name = str(mapping["project_name"])
        by_office.setdefault(office_id, {})[project_name] = ProductStatusPriorityRangeOut(
            rangeFrom=from_value,
            rangeTo=to_value,
        )
    return by_office


def _load_office(db: Session, *, gid: str) -> dict[str, Any] | None:
    result = db.execute(
        text(
            """
            SELECT id, gid, name, editing_locked, editing_locked_at, editing_unlocked_at
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
    all_offices = _load_offices(db)
    if not all_offices:
        raise HTTPException(
            status_code=503,
            detail="Таблицы статуса продукта B2B не инициализированы.",
        )

    if gid == SUMMARY_GID:
        return ProductStatusB2BOut(
            title=_TITLE,
            sourceUrl=None,
            presentationReferenceUrl=(
                settings.b2b_product_status_presentation_reference_url or None
            ),
            sheets=[_load_summary_sheet(db, offices=all_offices, meta_only=meta_only)],
        )

    offices = all_offices
    if gid:
        offices = [office for office in all_offices if office["gid"] == gid]
        if not offices:
            raise HTTPException(status_code=404, detail=f"Офис gid={gid} не найден.")

    sheets: list[ProductStatusSheetOut] = []
    if gid is None:
        sheets.append(_load_summary_sheet(db, offices=all_offices, meta_only=meta_only))

    office_ids = [int(office["id"]) for office in offices]
    projects_by_office = _load_office_projects(db, office_ids=office_ids)
    ranges_by_office = _load_office_project_priority_ranges(db, office_ids=office_ids)
    for office in offices:
        office_id = int(office["id"])
        office_projects = projects_by_office.get(office_id, [])
        office_ranges = ranges_by_office.get(office_id, {})
        if meta_only:
            sheets.append(
                ProductStatusSheetOut(
                    gid=office["gid"],
                    name=office["name"],
                    columns=list(B2B_PRODUCT_STATUS_COLUMNS),
                    rows=[],
                    totalShown=0,
                    projects=office_projects,
                    projectPriorityRanges=office_ranges,
                    editingLocked=bool(office.get("editing_locked")),
                    editingLockedAt=_iso_timestamp(office.get("editing_locked_at")),
                    editingUnlockedAt=_iso_timestamp(office.get("editing_unlocked_at")),
                )
            )
            continue
        rows = _load_office_rows(db, office_id=office_id)
        attachments_by_row = load_attachments_by_row_ids(
            db,
            [int(row["id"]) for row in rows],
        )
        sheets.append(
            _sheet_from_rows(
                gid=office["gid"],
                name=office["name"],
                rows=rows,
                projects=office_projects,
                project_priority_ranges=office_ranges,
                editing_locked=bool(office.get("editing_locked")),
                editing_locked_at=office.get("editing_locked_at"),
                editing_unlocked_at=office.get("editing_unlocked_at"),
                attachments_by_row=attachments_by_row,
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


def _assert_office_editable(office: dict[str, Any], meta: dict[str, Any] | None = None) -> None:
    if bool(office.get("editing_locked")) and not is_superadmin_user(meta):
        raise HTTPException(
            status_code=403,
            detail=(
                f"«{office['name']}» заблокирован для внесения изменений. "
                "Для разблокировки обратитесь к Склярову Ивану или Тараскину Александру."
            ),
        )


def set_auto_lock_offices_editing_locked(
    db: Session,
    *,
    locked: bool,
    office_ids: list[int] | None = None,
) -> list[dict[str, Any]]:
    """Меняет editing_locked только у офисов с автоблокировкой. Возвращает те, у которых флаг реально сменился."""
    rows = db.execute(
        text(
            """
            UPDATE b2b_product_status_office
            SET editing_locked = :locked,
                editing_locked_at = CASE
                    WHEN editing_locked IS DISTINCT FROM :locked AND :locked IS TRUE THEN NOW()
                    ELSE editing_locked_at
                END,
                editing_unlocked_at = CASE
                    WHEN editing_locked IS DISTINCT FROM :locked AND :locked IS FALSE THEN NOW()
                    ELSE editing_unlocked_at
                END
            WHERE is_active = TRUE
              AND auto_lock_enabled = TRUE
              AND editing_locked IS DISTINCT FROM :locked
              AND (:office_ids IS NULL OR id = ANY(:office_ids))
            RETURNING id, gid, name
            """
        ),
        {"locked": locked, "office_ids": office_ids},
    ).mappings()
    changed = [dict(row) for row in rows]
    db.commit()
    return changed


def get_b2b_product_status_office_access(db: Session, *, gid: str) -> dict[str, Any]:
    office = _load_office(db, gid=gid)
    if office is None:
        raise HTTPException(status_code=404, detail=f"Офис gid={gid} не найден.")
    flag = db.execute(
        text(
            """
            SELECT auto_lock_enabled
            FROM b2b_product_status_office
            WHERE id = :office_id
            """
        ),
        {"office_id": int(office["id"])},
    ).scalar()
    members = db.execute(
        text(
            """
            SELECT e.id AS employee_id, e.full_name,
                   COALESCE(NULLIF(btrim(e.email), ''), NULLIF(btrim(u.email), '')) AS email
            FROM b2b_product_status_office_member AS m
            JOIN employee AS e ON e.id = m.employee_id
            LEFT JOIN org_user AS u ON u.id = e.user_id
            WHERE m.office_id = :office_id
            ORDER BY e.full_name, e.id
            """
        ),
        {"office_id": int(office["id"])},
    ).mappings()
    from app.status_office_schedule import load_office_lock_slots

    lock, unlock = load_office_lock_slots(db, int(office["id"]))
    return {
        "gid": office["gid"],
        "name": office["name"],
        "autoLockEnabled": bool(flag),
        "lock": {"weekday": lock.weekday, "minutes": lock.minutes},
        "unlock": {"weekday": unlock.weekday, "minutes": unlock.minutes},
        "members": [dict(row) for row in members],
    }


def set_b2b_product_status_office_access(
    db: Session,
    *,
    gid: str,
    auto_lock_enabled: bool,
    employee_ids: list[int],
    lock_weekday: int,
    lock_minutes: int,
    unlock_weekday: int,
    unlock_minutes: int,
) -> dict[str, Any]:
    """Сохраняет автоблокировку и состав офиса. Если автоблокировку выключили у уже заблокированного офиса — снимает блокировку."""
    office = _load_office(db, gid=gid)
    if office is None:
        raise HTTPException(status_code=404, detail=f"Офис gid={gid} не найден.")
    unique_ids = sorted({int(item) for item in employee_ids})
    if unique_ids:
        found = db.execute(
            text(
                """
                SELECT id
                FROM employee
                WHERE is_active = TRUE
                  AND id = ANY(:ids)
                """
            ),
            {"ids": unique_ids},
        ).scalars()
        found_ids = {int(item) for item in found}
        missing = [item for item in unique_ids if item not in found_ids]
        if missing:
            raise HTTPException(
                status_code=400,
                detail="Некоторые сотрудники не найдены или неактивны.",
            )
    office_id = int(office["id"])
    from app.status_office_schedule import ScheduleSlot, save_office_lock_slots

    save_office_lock_slots(
        db,
        office_id,
        ScheduleSlot(lock_weekday, lock_minutes),
        ScheduleSlot(unlock_weekday, unlock_minutes),
    )
    db.execute(
        text("DELETE FROM b2b_product_status_office_member WHERE office_id = :office_id"),
        {"office_id": office_id},
    )
    if unique_ids:
        db.execute(
            text(
                """
                INSERT INTO b2b_product_status_office_member (office_id, employee_id)
                SELECT :office_id, id
                FROM employee
                WHERE id = ANY(:ids)
                """
            ),
            {"office_id": office_id, "ids": unique_ids},
        )
    unlocked_now = bool(office.get("editing_locked")) and not auto_lock_enabled
    db.execute(
        text(
            """
            UPDATE b2b_product_status_office
            SET auto_lock_enabled = :auto_lock_enabled,
                editing_locked = CASE
                    WHEN :unlocked_now THEN FALSE
                    ELSE editing_locked
                END,
                editing_unlocked_at = CASE
                    WHEN :unlocked_now THEN NOW()
                    ELSE editing_unlocked_at
                END
            WHERE id = :office_id
            """
        ),
        {
            "auto_lock_enabled": auto_lock_enabled,
            "unlocked_now": unlocked_now,
            "office_id": office_id,
        },
    )
    db.commit()
    access = get_b2b_product_status_office_access(db, gid=gid)
    access["unlockedNow"] = unlocked_now
    return access


def set_b2b_product_status_office_editing_locked(
    db: Session,
    *,
    gid: str,
    locked: bool,
) -> ProductStatusSheetOut:
    office = _load_office(db, gid=gid)
    if office is None:
        if gid == SUMMARY_GID:
            raise HTTPException(
                status_code=400,
                detail="Вкладка «Сводка» только для чтения.",
            )
        raise HTTPException(status_code=404, detail=f"Офис gid={gid} не найден.")

    stamped = db.execute(
        text(
            """
            UPDATE b2b_product_status_office
            SET editing_locked = :locked,
                editing_locked_at = CASE
                    WHEN editing_locked IS DISTINCT FROM :locked AND :locked IS TRUE THEN NOW()
                    ELSE editing_locked_at
                END,
                editing_unlocked_at = CASE
                    WHEN editing_locked IS DISTINCT FROM :locked AND :locked IS FALSE THEN NOW()
                    ELSE editing_unlocked_at
                END
            WHERE id = :office_id
            RETURNING editing_locked_at, editing_unlocked_at
            """
        ),
        {"locked": locked, "office_id": int(office["id"])},
    ).mappings().first()
    db.commit()
    office["editing_locked"] = locked
    if stamped is not None:
        office["editing_locked_at"] = stamped["editing_locked_at"]
        office["editing_unlocked_at"] = stamped["editing_unlocked_at"]
    office_id = int(office["id"])
    projects = _load_office_projects(db, office_ids=[office_id])
    ranges = _load_office_project_priority_ranges(db, office_ids=[office_id])
    rows = _load_office_rows(db, office_id=office_id)
    attachments_by_row = load_attachments_by_row_ids(
        db,
        [int(row["id"]) for row in rows],
    )
    return _sheet_from_rows(
        gid=office["gid"],
        name=office["name"],
        rows=rows,
        projects=projects.get(office_id, []),
        project_priority_ranges=ranges.get(office_id, {}),
        editing_locked=locked,
        editing_locked_at=office.get("editing_locked_at"),
        editing_unlocked_at=office.get("editing_unlocked_at"),
        attachments_by_row=attachments_by_row,
    )


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

    row_order_by_gid: dict[str, list[int]] = {}
    for item in payload.rowOrder:
        row_order_by_gid[item.gid] = list(item.rowIds)

    processed_gids = set(updates_by_gid) | set(deleted_by_gid) | set(row_order_by_gid)
    for gid in processed_gids:
        if gid == SUMMARY_GID:
            raise HTTPException(
                status_code=400,
                detail="Вкладка «Сводка» только для чтения.",
            )
        office = _load_office(db, gid=gid)
        if office is None:
            raise HTTPException(status_code=404, detail=f"Офис gid={gid} не найден.")
        _assert_office_editable(office, meta)

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
            if column == ATTACHMENTS_COLUMN:
                continue
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
        orphan_keys = list_storage_keys_for_rows(db, sorted(deleted_ids))

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
        if orphan_keys:
            delete_storage_objects(orphan_keys)

        db_rows = [row for row in db_rows if int(row["id"]) not in deleted_ids]

        updates = updates_by_gid.get(gid, [])
        data_updates = [item for item in updates if item.rowIndex >= 1]
        conflicts: list[str] = []

        # Updates without rowId are always new rows — never overwrite existing by index
        # (index matching wiped the table when empty rows were prepended in the UI).
        new_rows_by_index: dict[int, dict[str, Any]] = {}
        for row_index in sorted({item.rowIndex for item in data_updates if item.rowId is None}):
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
            row_by_id[int(created["id"])] = created
            new_rows_by_index[row_index] = created
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
            column = (
                update.column
                if update.column in B2B_PRODUCT_STATUS_COLUMNS
                else B2B_PRODUCT_STATUS_COLUMNS[update.columnIndex]
                if update.columnIndex < len(B2B_PRODUCT_STATUS_COLUMNS)
                else None
            )
            if column is None or column == ATTACHMENTS_COLUMN:
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

        db_rows = apply_row_order(db_rows, row_order_by_gid.get(gid))

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
        if gid == SUMMARY_GID:
            raise HTTPException(
                status_code=400,
                detail="Вкладка «Сводка» только для чтения.",
            )
        raise HTTPException(status_code=404, detail=f"Офис gid={gid} не найден.")
    _assert_office_editable(office, meta)

    office_id = int(office["id"])
    rows = _load_office_rows(db, office_id=office_id)
    row = next((item for item in rows if int(item["id"]) == row_id), None)
    if row is None:
        raise HTTPException(status_code=404, detail="Строка не найдена.")

    cells = _normalize_cells(row.get("cells"))
    orphan_keys = list_storage_keys_for_rows(db, [row_id])
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
    if orphan_keys:
        delete_storage_objects(orphan_keys)
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
    _assert_office_editable(office, meta)

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
