from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.schemas import ProductStatusCellUpdate


def resolve_row(
    update: ProductStatusCellUpdate,
    *,
    db_rows: list[dict[str, Any]],
    row_by_id: dict[int, dict[str, Any]],
) -> dict[str, Any] | None:
    if update.rowId is not None:
        return row_by_id.get(update.rowId)
    if 1 <= update.rowIndex <= len(db_rows):
        return db_rows[update.rowIndex - 1]
    return None


def apply_row_order(
    db_rows: list[dict[str, Any]],
    ordered_row_ids: list[int] | None,
) -> list[dict[str, Any]]:
    if not ordered_row_ids:
        return db_rows
    by_id = {int(row["id"]): row for row in db_rows}
    ordered: list[dict[str, Any]] = []
    seen: set[int] = set()
    for row_id in ordered_row_ids:
        row = by_id.get(int(row_id))
        if row is None:
            continue
        ordered.append(row)
        seen.add(int(row_id))
    for row in db_rows:
        row_id = int(row["id"])
        if row_id not in seen:
            ordered.append(row)
    return ordered


def read_row_cell(row: dict[str, Any], column: str, *, normalize_cells) -> str:
    cells = normalize_cells(row.get("cells"))
    return cells.get(column, "")


def fetch_row_cell(
    db: Session,
    *,
    table: str,
    row_id: int,
    column: str,
    normalize_cells,
) -> str | None:
    if table not in {"b2b_product_status_row", "b2b_news_row"}:
        raise ValueError(f"Unsupported table: {table}")
    result = db.execute(
        text(f"SELECT cells FROM {table} WHERE id = :row_id"),
        {"row_id": row_id},
    )
    row = result.first()
    if row is None:
        return None
    cells = row.cells if isinstance(row.cells, dict) else {}
    return normalize_cells(cells).get(column, "")


def update_row_cell_if_expected(
    db: Session,
    *,
    table: str,
    parent_column: str,
    parent_id: int,
    row_id: int,
    column: str,
    expected_value: str,
    new_value: str,
    updated_at: datetime | None = None,
) -> bool:
    if table not in {"b2b_product_status_row", "b2b_news_row"}:
        raise ValueError(f"Unsupported table: {table}")
    if parent_column not in {"office_id", "section_id"}:
        raise ValueError(f"Unsupported parent column: {parent_column}")

    stamp = updated_at or datetime.now(UTC)
    result = db.execute(
        text(
            f"""
            UPDATE {table}
            SET cells = jsonb_set(
                    cells,
                    ARRAY[:column_name]::text[],
                    to_jsonb(CAST(:new_value AS text)),
                    true
                ),
                updated_at = :updated_at
            WHERE id = :row_id
              AND {parent_column} = :parent_id
              AND COALESCE(cells ->> :column_name, '') IS NOT DISTINCT FROM :expected_value
            """
        ),
        {
            "column_name": column,
            "new_value": new_value,
            "updated_at": stamp,
            "row_id": row_id,
            "parent_id": parent_id,
            "expected_value": expected_value,
        },
    )
    return result.rowcount > 0


def raise_save_conflicts(conflicts: list[str]) -> None:
    preview = ", ".join(conflicts[:5])
    suffix = f" и ещё {len(conflicts) - 5}" if len(conflicts) > 5 else ""
    raise HTTPException(
        status_code=409,
        detail=(
            "Данные были изменены другим пользователем. "
            f"Проверьте актуальную версию и сохраните снова: {preview}{suffix}."
        ),
    )
