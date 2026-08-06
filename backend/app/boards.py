from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import ZniBoard
from app.tfs_auth import TfsAuth

ALL_BOARDS_CODE = "all"

_boards_cache: list[BoardConfig] | None = None


@dataclass(frozen=True)
class BoardConfig:
    code: str
    name: str
    display_name: str
    project: str
    project_id: str
    team_id: str
    area_path: str
    sync_tags: tuple[str, ...] = ()
    other_tags: tuple[str, ...] = ()
    error_sync_tags: tuple[str, ...] = ()
    exclude_sync_tags: tuple[str, ...] = ()
    exclude_sync_states: tuple[str, ...] = ()
    launching_soon_states: tuple[str, ...] = ()
    launching_soon_triage_values: tuple[str, ...] = ()
    launched_states: tuple[str, ...] = ()
    in_progress_states: tuple[str, ...] = ("Development",)
    incident_error_area_path: str | None = None
    incident_error_sync_tags: tuple[str, ...] = ()
    base_url: str = settings.tfs_base_url

    def to_tfs_auth(self, pat: str) -> TfsAuth:
        return TfsAuth(
            base_url=self.base_url.rstrip("/"),
            project=self.project,
            project_id=self.project_id,
            pat=pat,
        )


def parse_csv_tags(value: str | None) -> tuple[str, ...]:
    if not value or not str(value).strip():
        return ()
    return tuple(part.strip() for part in str(value).split(",") if part.strip())


def board_config_from_row(row: ZniBoard) -> BoardConfig:
    in_progress = parse_csv_tags(row.in_progress_states)
    return BoardConfig(
        code=row.code,
        name=row.board_name,
        display_name=row.alias,
        project=row.project,
        project_id=row.project_id,
        team_id=row.team_id,
        area_path=row.area_path,
        sync_tags=parse_csv_tags(row.sync_tags),
        other_tags=parse_csv_tags(row.other_tags),
        error_sync_tags=parse_csv_tags(row.error_sync_tags),
        exclude_sync_tags=parse_csv_tags(row.exclude_sync_tags),
        exclude_sync_states=parse_csv_tags(row.exclude_sync_states),
        launching_soon_states=parse_csv_tags(row.launching_soon_states),
        launching_soon_triage_values=parse_csv_tags(row.launching_soon_triage_values),
        launched_states=parse_csv_tags(row.launched_states),
        in_progress_states=in_progress or ("Development",),
        incident_error_area_path=row.incident_error_area_path or None,
        incident_error_sync_tags=parse_csv_tags(row.incident_error_sync_tags),
    )


def set_boards_cache(boards: list[BoardConfig]) -> None:
    global _boards_cache
    _boards_cache = list(boards)


def clear_boards_cache() -> None:
    global _boards_cache
    _boards_cache = None


def load_boards(db: Session) -> list[BoardConfig]:
    rows = list(
        db.scalars(
            select(ZniBoard)
            .where(ZniBoard.is_active.is_(True))
            .order_by(ZniBoard.sort_order, ZniBoard.code)
        )
    )
    boards = [board_config_from_row(row) for row in rows]
    set_boards_cache(boards)
    return boards


def get_boards() -> list[BoardConfig]:
    if _boards_cache is not None:
        return list(_boards_cache)
    return []


def ensure_boards_loaded(db: Session) -> list[BoardConfig]:
    if _boards_cache is not None:
        return list(_boards_cache)
    return load_boards(db)


def is_all_boards(code: str | None) -> bool:
    return (code or "").strip().lower() == ALL_BOARDS_CODE


def board_by_code(
    code: str | None,
    boards: list[BoardConfig] | None = None,
) -> BoardConfig | None:
    if not code or is_all_boards(code):
        return None
    normalized = code.strip().lower()
    for board in boards if boards is not None else get_boards():
        if board.code == normalized:
            return board
    return None


def boards_for_sync(
    board_code: str | None,
    boards: list[BoardConfig] | None = None,
) -> list[BoardConfig]:
    source = boards if boards is not None else get_boards()
    if is_all_boards(board_code) or not board_code:
        return list(source)
    board = board_by_code(board_code, source)
    return [board] if board else list(source)


def default_board(boards: list[BoardConfig] | None = None) -> BoardConfig:
    source = boards if boards is not None else get_boards()
    if not source:
        raise RuntimeError("Список досок ЗНИ пуст: выполните миграцию 043_zni_boards.sql")
    return source[0]
