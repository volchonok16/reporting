from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import ZniBoard
from app.tfs_auth import TfsAuth

ALL_BOARDS_CODE = "all"

logger = logging.getLogger(__name__)

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


def normalize_board_code(value: str | None) -> str:
    return (value or "").strip().lower()


def normalize_tfs_path(value: str | None) -> str:
    """TFS area path uses backslash; SQL inserts often come with '/'."""
    return (value or "").strip().replace("/", "\\")


def board_config_from_row(row: ZniBoard) -> BoardConfig:
    in_progress = parse_csv_tags(row.in_progress_states)
    return BoardConfig(
        code=(row.code or "").strip(),
        name=(row.board_name or "").strip(),
        display_name=(row.alias or "").strip() or (row.board_name or "").strip(),
        project=(row.project or "").strip(),
        project_id=(row.project_id or "").strip(),
        team_id=(row.team_id or "").strip(),
        area_path=normalize_tfs_path(row.area_path),
        sync_tags=parse_csv_tags(row.sync_tags),
        other_tags=parse_csv_tags(row.other_tags),
        error_sync_tags=parse_csv_tags(row.error_sync_tags),
        exclude_sync_tags=parse_csv_tags(row.exclude_sync_tags),
        exclude_sync_states=parse_csv_tags(row.exclude_sync_states),
        launching_soon_states=parse_csv_tags(row.launching_soon_states),
        launching_soon_triage_values=parse_csv_tags(row.launching_soon_triage_values),
        launched_states=parse_csv_tags(row.launched_states),
        in_progress_states=in_progress or ("Development",),
        incident_error_area_path=normalize_tfs_path(row.incident_error_area_path) or None,
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
    logger.info("zni_boards_loaded count=%s codes=%s", len(boards), [board.code for board in boards])
    return boards


def get_boards() -> list[BoardConfig]:
    if _boards_cache is not None:
        return list(_boards_cache)
    return []


def _is_db_session(db: object) -> bool:
    get_bind = getattr(db, "get_bind", None)
    if not callable(get_bind):
        return False
    try:
        bind = get_bind()
    except Exception:
        return False
    if type(bind).__name__ in {"MagicMock", "Mock", "AsyncMock"}:
        return False
    return getattr(bind, "dialect", None) is not None


def ensure_boards_loaded(db: Session, *, refresh: bool = False) -> list[BoardConfig]:
    if _is_db_session(db):
        return load_boards(db)
    if _boards_cache is not None:
        return list(_boards_cache)
    if refresh:
        return load_boards(db)
    return []


def is_all_boards(code: str | None) -> bool:
    return normalize_board_code(code) == ALL_BOARDS_CODE


def normalize_board_alias(value: str | None) -> str:
    """UI-имя доски: пробелы схлопываются, регистр не важен."""
    return " ".join((value or "").split()).casefold()


def board_by_code(
    code: str | None,
    boards: list[BoardConfig] | None = None,
) -> BoardConfig | None:
    if not code or is_all_boards(code):
        return None
    normalized = normalize_board_code(code)
    for board in boards if boards is not None else get_boards():
        if normalize_board_code(board.code) == normalized:
            return board
    return None


def boards_sharing_alias(
    board: BoardConfig,
    boards: list[BoardConfig] | None = None,
) -> list[BoardConfig]:
    """Все активные конфиги с тем же alias — разные area path в одной вкладке."""
    source = boards if boards is not None else get_boards()
    key = normalize_board_alias(board.display_name)
    if not key:
        return [board]
    return [item for item in source if normalize_board_alias(item.display_name) == key]


def grouped_boards_for_ui(boards: list[BoardConfig] | None = None) -> list[BoardConfig]:
    """Одна доска на alias: первая по sort_order, остальные area path подмешиваются."""
    source = boards if boards is not None else get_boards()
    seen: set[str] = set()
    result: list[BoardConfig] = []
    for board in source:
        key = normalize_board_alias(board.display_name)
        if key:
            if key in seen:
                continue
            seen.add(key)
        result.append(board)
    return result


def boards_for_sync(
    board_code: str | None,
    boards: list[BoardConfig] | None = None,
) -> list[BoardConfig]:
    source = boards if boards is not None else get_boards()
    if is_all_boards(board_code) or not board_code:
        return list(source)
    board = board_by_code(board_code, source)
    if board is None:
        return []
    return boards_sharing_alias(board, source)


def default_board(boards: list[BoardConfig] | None = None) -> BoardConfig:
    source = boards if boards is not None else get_boards()
    if not source:
        raise RuntimeError("Список досок ЗНИ пуст: выполните миграцию 043_zni_boards.sql")
    return source[0]
