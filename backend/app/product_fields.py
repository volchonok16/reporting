"""Поля TFS и доска для карточек «Продукт»."""

from __future__ import annotations

from typing import Any

from app.boards import BoardConfig, get_boards, normalize_tfs_path
from app.config import settings
from app.zni_description import tfs_identity_display_name


def product_owner_from_fields(fields: dict[str, Any]) -> str | None:
    """Владелец проекта — то же поле TFS, что «Заказчик» у ЗНИ (`Logrocon.PO`)."""
    for field_name in settings.product_owner_field_list:
        value = fields.get(field_name)
        if value is None or value == "":
            continue
        if field_name == "System.AssignedTo" or "AssignedTo" in field_name or field_name.endswith(".PO"):
            name = tfs_identity_display_name(value)
            if name:
                return name
        text = str(value).strip()
        if text:
            return text
    return None


def board_for_area_path(
    area_path: str | None,
    boards: list[BoardConfig] | None = None,
) -> BoardConfig | None:
    """Самая специфичная доска zni_board, чей area_path покрывает area_path продукта."""
    normalized = normalize_tfs_path(area_path)
    if not normalized:
        return None
    source = boards if boards is not None else get_boards()
    best: BoardConfig | None = None
    best_len = -1
    for board in source:
        board_area = normalize_tfs_path(board.area_path)
        if not board_area:
            continue
        if normalized == board_area or normalized.startswith(f"{board_area}\\"):
            if len(board_area) > best_len:
                best = board
                best_len = len(board_area)
    return best
