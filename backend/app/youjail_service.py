from __future__ import annotations

import logging
import mimetypes
import re
import shutil
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, UploadFile
from sqlalchemy import Select, delete, desc, func, or_, select
from sqlalchemy.orm import Session

from app.config import settings
from app.org_models import Employee
from app.org_photo_service import photo_public_url
from app.youjail_access import (
    actor_employee_id,
    assert_board_access,
    assert_card_access,
    assert_youjail_admin,
    accessible_board_ids,
    is_youjail_admin,
    team_member_count,
)
from app.youjail_models import (
    YouJailAttachment,
    YouJailBoard,
    YouJailBoardTeam,
    YouJailCard,
    YouJailCardTag,
    YouJailColumn,
    YouJailExecution,
    YouJailExecutionLog,
    YouJailProject,
    YouJailTag,
    YouJailTaskType,
    YouJailTeam,
    YouJailTeamMember,
)
from app.youjail_terminal import run_command_with_pty

logger = logging.getLogger(__name__)

EXECUTORS = ("manual", "claude", "codex", "gemini", "pi", "openclaw", "opencode")
EXECUTION_STATUSES = ("idle", "queued", "running", "succeeded", "failed")
TAG_COLORS = ("#0052CC", "#FF5630", "#36B37E", "#6554C0", "#00B8D9", "#FF991F", "#8993A4")
DEFAULT_COLUMNS = (
    ("backlog", "Backlog", "backlog", 1),
    ("in_progress", "In Progress", "progress", 2),
    ("blocked", "Blocked", "blocked", 3),
    ("done", "Done", "done", 4),
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def workspace_dir() -> Path:
    path = Path(settings.youjail_workspace_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def attachments_dir() -> Path:
    path = workspace_dir() / "attachments"
    path.mkdir(parents=True, exist_ok=True)
    return path


def worktrees_dir() -> Path:
    path = workspace_dir() / "worktrees"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _slugify(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return normalized or "project"


def _tag_color(name: str) -> str:
    total = sum(ord(char) for char in name.lower())
    return TAG_COLORS[total % len(TAG_COLORS)]


def _serialize_tag(tag: YouJailTag) -> dict:
    return {
        "id": tag.id,
        "name": tag.name,
        "slug": tag.slug,
        "color": tag.color,
    }


def _card_tags_map(db: Session, card_ids: list[int]) -> dict[int, list[dict]]:
    if not card_ids:
        return {}
    rows = db.execute(
        select(YouJailCardTag.card_id, YouJailTag)
        .join(YouJailTag, YouJailCardTag.tag_id == YouJailTag.id)
        .where(YouJailCardTag.card_id.in_(card_ids))
        .order_by(YouJailTag.name.asc())
    ).all()
    result: dict[int, list[dict]] = {}
    for card_id, tag in rows:
        result.setdefault(card_id, []).append(_serialize_tag(tag))
    return result


def _set_card_tags(db: Session, card_id: int, tag_ids: list[int]) -> None:
    unique_ids = sorted({int(tag_id) for tag_id in tag_ids})
    for tag_id in unique_ids:
        tag = db.get(YouJailTag, tag_id)
        if tag is None:
            raise HTTPException(status_code=400, detail=f"Тег {tag_id} не найден.")
    db.execute(delete(YouJailCardTag).where(YouJailCardTag.card_id == card_id))
    for tag_id in unique_ids:
        db.add(YouJailCardTag(card_id=card_id, tag_id=tag_id))


def _find_tag_by_name(db: Session, name: str) -> YouJailTag | None:
    normalized = name.strip()
    if not normalized:
        return None
    return db.scalar(select(YouJailTag).where(func.lower(YouJailTag.name) == normalized.lower()))


def list_tags(db: Session) -> list[dict]:
    tags = db.scalars(select(YouJailTag).order_by(YouJailTag.name.asc())).all()
    return [_serialize_tag(tag) for tag in tags]


def create_tag(db: Session, data: dict) -> dict:
    name = data["name"].strip()
    if not name:
        raise HTTPException(status_code=400, detail="Название тега обязательно.")
    existing = _find_tag_by_name(db, name)
    if existing is not None:
        return _serialize_tag(existing)

    slug_base = _slugify(name)
    slug = slug_base
    suffix = 2
    while db.scalar(select(YouJailTag.id).where(YouJailTag.slug == slug)) is not None:
        slug = f"{slug_base}-{suffix}"
        suffix += 1

    tag = YouJailTag(
        name=name,
        slug=slug,
        color=data.get("color") or _tag_color(name),
    )
    db.add(tag)
    db.commit()
    db.refresh(tag)
    return _serialize_tag(tag)


def _next_sort_order(db: Session, column_id: int) -> int:
    current = db.scalar(
        select(func.coalesce(func.max(YouJailCard.sort_order), -1)).where(YouJailCard.column_id == column_id)
    )
    return int(current or -1) + 1


def _next_card_number(db: Session, board_id: int) -> int:
    db.scalar(select(YouJailBoard.id).where(YouJailBoard.id == board_id).with_for_update())
    current = db.scalar(
        select(func.coalesce(func.max(YouJailCard.card_number), 0)).where(YouJailCard.board_id == board_id)
    )
    return int(current or 0) + 1


def _card_key(board_slug: str, card_number: int) -> str:
    prefix = board_slug.upper().replace("-", "")
    return f"{prefix}-{card_number}"


def _attachment_url(attachment_id: int) -> str:
    return f"/api/youjail/attachments/{attachment_id}/download"


def _board_team_ids(db: Session, board_id: int) -> list[int]:
    return list(
        db.scalars(select(YouJailBoardTeam.team_id).where(YouJailBoardTeam.board_id == board_id)).all()
    )


def _set_board_teams(db: Session, board_id: int, team_ids: list[int]) -> None:
    unique_ids = sorted({int(team_id) for team_id in team_ids})
    for team_id in unique_ids:
        team = db.get(YouJailTeam, team_id)
        if team is None or not team.is_active:
            raise HTTPException(status_code=400, detail=f"Команда {team_id} не найдена.")
    db.execute(delete(YouJailBoardTeam).where(YouJailBoardTeam.board_id == board_id))
    for team_id in unique_ids:
        db.add(YouJailBoardTeam(board_id=board_id, team_id=team_id))


def _serialize_board(db: Session, board: YouJailBoard) -> dict:
    return {
        "id": board.id,
        "name": board.name,
        "slug": board.slug,
        "description": board.description or "",
        "sortOrder": board.sort_order,
        "isActive": board.is_active,
        "teamIds": _board_team_ids(db, board.id),
    }


def _filter_boards_query(query: Select, db: Session, meta: dict) -> Select:
    allowed = accessible_board_ids(db, meta)
    if allowed is None:
        return query
    if not allowed:
        return query.where(YouJailBoard.id == -1)
    return query.where(YouJailBoard.id.in_(allowed))


def _resolve_board_id(db: Session, board_id: int | None, meta: dict) -> int:
    if board_id is not None:
        board = db.get(YouJailBoard, board_id)
        if board is None:
            raise HTTPException(status_code=404, detail="Доска не найдена.")
        assert_board_access(db, meta, board.id)
        return board.id
    query = select(YouJailBoard).where(YouJailBoard.is_active.is_(True)).order_by(YouJailBoard.sort_order.asc())
    query = _filter_boards_query(query, db, meta)
    board = db.scalar(query.limit(1))
    if board is None:
        raise HTTPException(status_code=403, detail="Нет доступных досок.")
    return board.id


def _apply_fuzzy_search(query: Select, needle: str) -> Select:
    pattern = f"%{needle}%"
    title_similarity = func.similarity(YouJailCard.title, needle)
    description_similarity = func.similarity(YouJailCard.description_md, needle)
    return (
        query.where(
            or_(
                YouJailCard.title.op("%")(needle),
                YouJailCard.description_md.op("%")(needle),
                YouJailCard.title.ilike(pattern),
                YouJailCard.description_md.ilike(pattern),
            )
        )
        .order_by(
            desc(func.greatest(title_similarity, description_similarity)),
            YouJailCard.pinned.desc(),
            YouJailCard.sort_order.asc(),
            YouJailCard.id.asc(),
        )
    )


def _card_query(*, fuzzy_search: str | None = None) -> Select:
    query = select(YouJailCard)
    if fuzzy_search:
        return _apply_fuzzy_search(query, fuzzy_search)
    return query.order_by(
        YouJailCard.pinned.desc(),
        YouJailCard.sort_order.asc(),
        YouJailCard.id.asc(),
    )


def _serialize_attachment(attachment: YouJailAttachment) -> dict:
    return {
        "id": attachment.id,
        "cardId": attachment.card_id,
        "filename": attachment.filename,
        "contentType": attachment.content_type,
        "sizeBytes": attachment.size_bytes,
        "downloadUrl": _attachment_url(attachment.id),
        "createdAt": attachment.created_at,
    }


def _serialize_execution(db: Session, execution: YouJailExecution, *, with_logs: bool = False) -> dict:
    payload = {
        "id": execution.id,
        "cardId": execution.card_id,
        "executor": execution.executor,
        "status": execution.status,
        "startedAt": execution.started_at,
        "finishedAt": execution.finished_at,
        "exitCode": execution.exit_code,
        "errorMessage": execution.error_message,
        "worktreePath": execution.worktree_path,
        "logs": [],
    }
    if with_logs:
        logs = db.scalars(
            select(YouJailExecutionLog)
            .where(YouJailExecutionLog.execution_id == execution.id)
            .order_by(YouJailExecutionLog.seq.asc())
        ).all()
        payload["logs"] = [
            {
                "id": log.id,
                "seq": log.seq,
                "stream": log.stream,
                "content": log.content,
                "createdAt": log.created_at,
            }
            for log in logs
        ]
    return payload


def _serialize_column(column: YouJailColumn) -> dict:
    return {
        "id": column.id,
        "boardId": column.board_id,
        "columnKey": column.column_key,
        "title": column.title,
        "tone": column.tone,
        "sortOrder": column.sort_order,
    }


def _resolve_assignee(db: Session, employee_id: int | None) -> Employee | None:
    if employee_id is None:
        return None
    employee = db.get(Employee, employee_id)
    if employee is None or not employee.is_active:
        raise HTTPException(status_code=400, detail="Сотрудник не найден.")
    return employee


def _serialize_card(
    db: Session,
    card: YouJailCard,
    *,
    detailed: bool = False,
    tags_map: dict[int, list[dict]] | None = None,
    board_slug: str | None = None,
) -> dict:
    column = db.get(YouJailColumn, card.column_id)
    project = db.get(YouJailProject, card.project_id) if card.project_id else None
    task_type = db.get(YouJailTaskType, card.task_type_id) if card.task_type_id else None
    assignee = db.get(Employee, card.assignee_employee_id) if card.assignee_employee_id else None
    attachments = db.scalars(
        select(YouJailAttachment)
        .where(YouJailAttachment.card_id == card.id)
        .order_by(YouJailAttachment.created_at.asc())
    ).all()
    latest_execution = db.scalar(
        select(YouJailExecution)
        .where(YouJailExecution.card_id == card.id)
        .order_by(YouJailExecution.started_at.desc())
        .limit(1)
    )
    if board_slug is None:
        board = db.get(YouJailBoard, card.board_id)
        board_slug = board.slug if board else "board"
    return {
        "id": card.id,
        "boardId": card.board_id,
        "columnId": card.column_id,
        "columnKey": column.column_key if column else "",
        "cardNumber": card.card_number,
        "cardKey": _card_key(board_slug, card.card_number),
        "projectId": card.project_id,
        "projectName": project.name if project else None,
        "taskTypeId": card.task_type_id,
        "taskTypeName": task_type.name if task_type else None,
        "title": card.title,
        "descriptionMd": card.description_md or "",
        "pinned": card.pinned,
        "archived": card.archived,
        "closedAt": card.closed_at,
        "scheduledAt": card.scheduled_at,
        "sortOrder": card.sort_order,
        "executor": card.executor,
        "worktreePath": card.worktree_path,
        "worktreeBranch": card.worktree_branch,
        "executionStatus": card.execution_status,
        "assigneeEmployeeId": card.assignee_employee_id,
        "assigneeName": assignee.full_name if assignee else None,
        "assigneePhotoUrl": photo_public_url(assignee.photo_path) if assignee else None,
        "tags": tags_map.get(card.id, []) if tags_map is not None else _card_tags_map(db, [card.id]).get(card.id, []),
        "createdBy": card.created_by,
        "createdAt": card.created_at,
        "updatedAt": card.updated_at,
        "attachments": [_serialize_attachment(item) for item in attachments],
        "latestExecution": (
            _serialize_execution(db, latest_execution, with_logs=detailed) if latest_execution else None
        ),
    }


def load_board(
    db: Session,
    *,
    meta: dict,
    board_id: int | None = None,
    search: str | None = None,
    archived: str = "false",
) -> dict:
    resolved_board_id = _resolve_board_id(db, board_id, meta)
    board = db.get(YouJailBoard, resolved_board_id)
    if board is None:
        raise HTTPException(status_code=404, detail="Доска не найдена.")

    boards_query = select(YouJailBoard).where(YouJailBoard.is_active.is_(True)).order_by(YouJailBoard.sort_order.asc())
    boards = db.scalars(_filter_boards_query(boards_query, db, meta)).all()
    columns = db.scalars(
        select(YouJailColumn)
        .where(YouJailColumn.board_id == resolved_board_id)
        .order_by(YouJailColumn.sort_order.asc())
    ).all()
    projects = db.scalars(
        select(YouJailProject).where(YouJailProject.is_active.is_(True)).order_by(YouJailProject.name.asc())
    ).all()
    task_types = db.scalars(
        select(YouJailTaskType).where(YouJailTaskType.is_active.is_(True)).order_by(YouJailTaskType.sort_order.asc())
    ).all()

    needle = (search or "").strip()
    query = _card_query(fuzzy_search=needle or None).where(YouJailCard.board_id == resolved_board_id)
    if archived == "true":
        query = query.where(YouJailCard.archived.is_(True))
    elif archived != "all":
        query = query.where(YouJailCard.archived.is_(False))

    cards = db.scalars(query).all()
    card_ids = [card.id for card in cards]
    tags_map = _card_tags_map(db, card_ids)
    all_tags = list_tags(db)
    return {
        "board": _serialize_board(db, board),
        "boards": [_serialize_board(db, item) for item in boards],
        "columns": [_serialize_column(column) for column in columns],
        "cards": [_serialize_card(db, card, tags_map=tags_map, board_slug=board.slug) for card in cards],
        "projects": [
            {
                "id": project.id,
                "name": project.name,
                "slug": project.slug,
                "repoPath": project.repo_path,
                "contextMd": project.context_md or "",
                "instructionsMd": project.instructions_md or "",
                "isActive": project.is_active,
            }
            for project in projects
        ],
        "taskTypes": [
            {
                "id": task_type.id,
                "name": task_type.name,
                "instructionsMd": task_type.instructions_md or "",
                "sortOrder": task_type.sort_order,
                "isActive": task_type.is_active,
            }
            for task_type in task_types
        ],
        "tags": all_tags,
    }


def get_card(db: Session, card_id: int, *, meta: dict) -> dict:
    card = assert_card_access(db, meta, card_id)
    return _serialize_card(db, card, detailed=True)


def _default_backlog_column_id(db: Session, board_id: int) -> int:
    column = db.scalar(
        select(YouJailColumn).where(
            YouJailColumn.board_id == board_id,
            YouJailColumn.column_key == "backlog",
        )
    )
    if column is None:
        raise HTTPException(status_code=500, detail="Колонки YouJail не инициализированы.")
    return column.id


def list_boards(db: Session, *, meta: dict) -> list[dict]:
    query = select(YouJailBoard).where(YouJailBoard.is_active.is_(True)).order_by(YouJailBoard.sort_order.asc())
    boards = db.scalars(_filter_boards_query(query, db, meta)).all()
    return [_serialize_board(db, board) for board in boards]


def create_board(db: Session, data: dict, *, meta: dict) -> dict:
    assert_youjail_admin(meta)
    slug = _slugify(data.get("slug") or data["name"])
    existing = db.scalar(select(YouJailBoard).where(YouJailBoard.slug == slug))
    if existing is not None:
        raise HTTPException(status_code=409, detail="Доска с таким slug уже существует.")

    board = YouJailBoard(
        name=data["name"].strip(),
        slug=slug,
        description=(data.get("description") or "").strip(),
        sort_order=int(data.get("sortOrder") or 0),
        updated_at=_utcnow(),
    )
    db.add(board)
    db.flush()
    for column_key, title, tone, sort_order in DEFAULT_COLUMNS:
        db.add(
            YouJailColumn(
                board_id=board.id,
                column_key=column_key,
                title=title,
                tone=tone,
                sort_order=sort_order,
            )
        )
    team_ids = data.get("teamIds") or []
    if team_ids:
        _set_board_teams(db, board.id, team_ids)
    db.commit()
    db.refresh(board)
    return _serialize_board(db, board)


def delete_board(db: Session, board_id: int, *, meta: dict) -> None:
    assert_youjail_admin(meta)
    assert_board_access(db, meta, board_id)
    board = db.get(YouJailBoard, board_id)
    if board is None:
        raise HTTPException(status_code=404, detail="Доска не найдена.")

    active_count = db.scalar(
        select(func.count()).select_from(YouJailBoard).where(YouJailBoard.is_active.is_(True))
    )
    if int(active_count or 0) <= 1:
        raise HTTPException(status_code=400, detail="Нельзя удалить последнюю доску.")

    db.delete(board)
    db.commit()


def set_board_teams(db: Session, board_id: int, team_ids: list[int], *, meta: dict) -> dict:
    assert_youjail_admin(meta)
    board = db.get(YouJailBoard, board_id)
    if board is None:
        raise HTTPException(status_code=404, detail="Доска не найдена.")
    _set_board_teams(db, board_id, team_ids)
    db.commit()
    return _serialize_board(db, board)


def create_column(db: Session, board_id: int, data: dict, *, meta: dict) -> dict:
    assert_youjail_admin(meta)
    assert_board_access(db, meta, board_id)

    title = data["title"].strip()
    base_key = _slugify(data.get("columnKey") or title).replace("-", "_")[:28] or "column"
    column_key = base_key
    suffix = 1
    while db.scalar(
        select(YouJailColumn.id).where(
            YouJailColumn.board_id == board_id,
            YouJailColumn.column_key == column_key,
        )
    ):
        column_key = f"{base_key[:24]}_{suffix}"
        suffix += 1

    max_order = db.scalar(
        select(func.coalesce(func.max(YouJailColumn.sort_order), 0)).where(YouJailColumn.board_id == board_id)
    )
    tone = (data.get("tone") or "custom").strip().lower()[:32]

    column = YouJailColumn(
        board_id=board_id,
        column_key=column_key,
        title=title,
        tone=tone,
        sort_order=int(max_order or 0) + 1,
    )
    db.add(column)
    db.commit()
    db.refresh(column)
    return _serialize_column(column)


def update_column(db: Session, column_id: int, data: dict, *, meta: dict) -> dict:
    assert_youjail_admin(meta)
    column = db.get(YouJailColumn, column_id)
    if column is None:
        raise HTTPException(status_code=404, detail="Колонка не найдена.")
    assert_board_access(db, meta, column.board_id)

    if data.get("title") is not None:
        column.title = data["title"].strip()
    if data.get("tone") is not None:
        column.tone = data["tone"].strip().lower()[:32]
    if data.get("sortOrder") is not None:
        column.sort_order = int(data["sortOrder"])

    db.commit()
    db.refresh(column)
    return _serialize_column(column)


def create_card(db: Session, data: dict, *, created_by: str | None, meta: dict) -> dict:
    board_id = _resolve_board_id(db, data.get("boardId"), meta)
    column_id = data.get("columnId") or _default_backlog_column_id(db, board_id)
    column = db.get(YouJailColumn, column_id)
    if column is None or column.board_id != board_id:
        raise HTTPException(status_code=400, detail="Колонка не найдена.")

    executor = (data.get("executor") or "manual").strip().lower()
    if executor not in EXECUTORS:
        raise HTTPException(status_code=400, detail="Неизвестный исполнитель.")

    assignee_id = data.get("assigneeEmployeeId")
    if assignee_id is not None:
        _resolve_assignee(db, assignee_id)

    card = YouJailCard(
        board_id=board_id,
        column_id=column_id,
        card_number=_next_card_number(db, board_id),
        project_id=data.get("projectId"),
        task_type_id=data.get("taskTypeId"),
        title=data["title"].strip(),
        description_md=(data.get("descriptionMd") or "").strip(),
        scheduled_at=data.get("scheduledAt"),
        executor=executor,
        assignee_employee_id=assignee_id,
        sort_order=_next_sort_order(db, column_id),
        created_by=created_by,
        updated_at=_utcnow(),
    )
    db.add(card)
    db.commit()
    db.refresh(card)
    if data.get("tagIds") is not None:
        _set_card_tags(db, card.id, data["tagIds"])
        db.commit()
    return get_card(db, card.id, meta=meta)


def update_card(db: Session, card_id: int, data: dict, *, meta: dict) -> dict:
    card = assert_card_access(db, meta, card_id)

    if data.get("title") is not None:
        card.title = data["title"].strip()
    if data.get("descriptionMd") is not None:
        card.description_md = data["descriptionMd"]
    if data.get("projectId") is not None or "projectId" in data:
        card.project_id = data.get("projectId")
    if data.get("taskTypeId") is not None or "taskTypeId" in data:
        card.task_type_id = data.get("taskTypeId")
    if data.get("scheduledAt") is not None or "scheduledAt" in data:
        card.scheduled_at = data.get("scheduledAt")
    if data.get("executor") is not None:
        executor = data["executor"].strip().lower()
        if executor not in EXECUTORS:
            raise HTTPException(status_code=400, detail="Неизвестный исполнитель.")
        card.executor = executor
    if "assigneeEmployeeId" in data:
        assignee_id = data.get("assigneeEmployeeId")
        if assignee_id is not None:
            _resolve_assignee(db, assignee_id)
        card.assignee_employee_id = assignee_id
    if data.get("columnId") is not None:
        column = db.get(YouJailColumn, data["columnId"])
        if column is None or column.board_id != card.board_id:
            raise HTTPException(status_code=400, detail="Колонка не найдена.")
        card.column_id = column.id
    if data.get("sortOrder") is not None:
        card.sort_order = int(data["sortOrder"])
    if data.get("tagIds") is not None:
        _set_card_tags(db, card.id, data["tagIds"])

    card.updated_at = _utcnow()
    db.commit()
    db.refresh(card)
    return get_card(db, card.id, meta=meta)


def move_card(
    db: Session,
    card_id: int,
    *,
    column_id: int,
    sort_order: int | None,
    meta: dict,
) -> dict:
    card = assert_card_access(db, meta, card_id)
    column = db.get(YouJailColumn, column_id)
    if column is None or column.board_id != card.board_id:
        raise HTTPException(status_code=400, detail="Колонка не найдена.")
    card.column_id = column_id
    card.sort_order = sort_order if sort_order is not None else _next_sort_order(db, column_id)
    card.updated_at = _utcnow()
    db.commit()
    db.refresh(card)
    return get_card(db, card.id, meta=meta)


def delete_card(db: Session, card_id: int, *, meta: dict) -> None:
    card = assert_card_access(db, meta, card_id)
    db.delete(card)
    db.commit()


def set_card_flag(db: Session, card_id: int, *, meta: dict, **flags: bool | datetime | None) -> dict:
    card = assert_card_access(db, meta, card_id)
    if "pinned" in flags:
        card.pinned = bool(flags["pinned"])
    if "archived" in flags:
        card.archived = bool(flags["archived"])
    if "closedAt" in flags:
        card.closed_at = flags["closedAt"]
    card.updated_at = _utcnow()
    db.commit()
    db.refresh(card)
    return get_card(db, card.id, meta=meta)


def _serialize_team_member(db: Session, member: YouJailTeamMember) -> dict:
    employee = db.get(Employee, member.employee_id)
    return {
        "id": member.id,
        "teamId": member.team_id,
        "employeeId": member.employee_id,
        "employeeName": employee.full_name if employee else "—",
        "employeePhotoUrl": photo_public_url(employee.photo_path) if employee else None,
        "role": member.role,
    }


def _serialize_team(db: Session, team: YouJailTeam, *, with_members: bool = False) -> dict:
    payload = {
        "id": team.id,
        "name": team.name,
        "slug": team.slug,
        "description": team.description or "",
        "sortOrder": team.sort_order,
        "isActive": team.is_active,
        "memberCount": team_member_count(db, team.id),
        "members": [],
    }
    if with_members:
        members = db.scalars(
            select(YouJailTeamMember)
            .where(YouJailTeamMember.team_id == team.id)
            .order_by(YouJailTeamMember.id.asc())
        ).all()
        payload["members"] = [_serialize_team_member(db, member) for member in members]
    return payload


def list_teams(db: Session, *, meta: dict, detailed: bool = False) -> list[dict]:
    query = select(YouJailTeam).where(YouJailTeam.is_active.is_(True)).order_by(YouJailTeam.sort_order.asc())
    if not is_youjail_admin(meta):
        employee_id = actor_employee_id(db, meta)
        if employee_id is None:
            return []
        query = (
            select(YouJailTeam)
            .join(YouJailTeamMember, YouJailTeamMember.team_id == YouJailTeam.id)
            .where(
                YouJailTeamMember.employee_id == employee_id,
                YouJailTeam.is_active.is_(True),
            )
            .order_by(YouJailTeam.sort_order.asc())
        )
    teams = db.scalars(query).unique().all()
    return [_serialize_team(db, team, with_members=detailed) for team in teams]


def create_team(db: Session, data: dict, *, meta: dict) -> dict:
    assert_youjail_admin(meta)
    slug = _slugify(data.get("slug") or data["name"])
    existing = db.scalar(select(YouJailTeam).where(YouJailTeam.slug == slug))
    if existing is not None:
        raise HTTPException(status_code=409, detail="Команда с таким slug уже существует.")
    team = YouJailTeam(
        name=data["name"].strip(),
        slug=slug,
        description=(data.get("description") or "").strip(),
        sort_order=int(data.get("sortOrder") or 0),
        updated_at=_utcnow(),
    )
    db.add(team)
    db.commit()
    db.refresh(team)
    return _serialize_team(db, team, with_members=True)


def update_team(db: Session, team_id: int, data: dict, *, meta: dict) -> dict:
    assert_youjail_admin(meta)
    team = db.get(YouJailTeam, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Команда не найдена.")
    if data.get("name") is not None:
        team.name = data["name"].strip()
    if data.get("description") is not None:
        team.description = data["description"]
    if data.get("sortOrder") is not None:
        team.sort_order = int(data["sortOrder"])
    if data.get("isActive") is not None:
        team.is_active = bool(data["isActive"])
    team.updated_at = _utcnow()
    db.commit()
    db.refresh(team)
    return _serialize_team(db, team, with_members=True)


def delete_team(db: Session, team_id: int, *, meta: dict) -> None:
    assert_youjail_admin(meta)
    team = db.get(YouJailTeam, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Команда не найдена.")
    db.delete(team)
    db.commit()


def add_team_member(db: Session, team_id: int, data: dict, *, meta: dict) -> dict:
    assert_youjail_admin(meta)
    team = db.get(YouJailTeam, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Команда не найдена.")
    employee_id = int(data["employeeId"])
    employee = db.get(Employee, employee_id)
    if employee is None or not employee.is_active:
        raise HTTPException(status_code=400, detail="Сотрудник не найден.")
    existing = db.scalar(
        select(YouJailTeamMember).where(
            YouJailTeamMember.team_id == team_id,
            YouJailTeamMember.employee_id == employee_id,
        )
    )
    if existing is None:
        db.add(
            YouJailTeamMember(
                team_id=team_id,
                employee_id=employee_id,
                role=(data.get("role") or "member").strip()[:32],
            )
        )
        db.commit()
    return _serialize_team(db, team, with_members=True)


def remove_team_member(db: Session, team_id: int, employee_id: int, *, meta: dict) -> dict:
    assert_youjail_admin(meta)
    team = db.get(YouJailTeam, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Команда не найдена.")
    member = db.scalar(
        select(YouJailTeamMember).where(
            YouJailTeamMember.team_id == team_id,
            YouJailTeamMember.employee_id == employee_id,
        )
    )
    if member is not None:
        db.delete(member)
        db.commit()
    return _serialize_team(db, team, with_members=True)


def list_projects(db: Session) -> list[dict]:
    projects = db.scalars(select(YouJailProject).order_by(YouJailProject.name.asc())).all()
    return [
        {
            "id": project.id,
            "name": project.name,
            "slug": project.slug,
            "repoPath": project.repo_path,
            "contextMd": project.context_md or "",
            "instructionsMd": project.instructions_md or "",
            "isActive": project.is_active,
        }
        for project in projects
    ]


def create_project(db: Session, data: dict) -> dict:
    slug = _slugify(data.get("slug") or data["name"])
    project = YouJailProject(
        name=data["name"].strip(),
        slug=slug,
        repo_path=(data.get("repoPath") or "").strip() or None,
        context_md=(data.get("contextMd") or "").strip(),
        instructions_md=(data.get("instructionsMd") or "").strip(),
        updated_at=_utcnow(),
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return {
        "id": project.id,
        "name": project.name,
        "slug": project.slug,
        "repoPath": project.repo_path,
        "contextMd": project.context_md or "",
        "instructionsMd": project.instructions_md or "",
        "isActive": project.is_active,
    }


def update_project(db: Session, project_id: int, data: dict) -> dict:
    project = db.get(YouJailProject, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Проект не найден.")
    if data.get("name") is not None:
        project.name = data["name"].strip()
    if data.get("repoPath") is not None:
        project.repo_path = data["repoPath"].strip() or None
    if data.get("contextMd") is not None:
        project.context_md = data["contextMd"]
    if data.get("instructionsMd") is not None:
        project.instructions_md = data["instructionsMd"]
    if data.get("isActive") is not None:
        project.is_active = bool(data["isActive"])
    project.updated_at = _utcnow()
    db.commit()
    db.refresh(project)
    return {
        "id": project.id,
        "name": project.name,
        "slug": project.slug,
        "repoPath": project.repo_path,
        "contextMd": project.context_md or "",
        "instructionsMd": project.instructions_md or "",
        "isActive": project.is_active,
    }


def list_task_types(db: Session) -> list[dict]:
    task_types = db.scalars(select(YouJailTaskType).order_by(YouJailTaskType.sort_order.asc())).all()
    return [
        {
            "id": task_type.id,
            "name": task_type.name,
            "instructionsMd": task_type.instructions_md or "",
            "sortOrder": task_type.sort_order,
            "isActive": task_type.is_active,
        }
        for task_type in task_types
    ]


def create_task_type(db: Session, data: dict) -> dict:
    task_type = YouJailTaskType(
        name=data["name"].strip(),
        instructions_md=(data.get("instructionsMd") or "").strip(),
        sort_order=int(data.get("sortOrder") or 0),
    )
    db.add(task_type)
    db.commit()
    db.refresh(task_type)
    return {
        "id": task_type.id,
        "name": task_type.name,
        "instructionsMd": task_type.instructions_md or "",
        "sortOrder": task_type.sort_order,
        "isActive": task_type.is_active,
    }


async def save_attachment(db: Session, card_id: int, file: UploadFile, *, meta: dict) -> dict:
    card = assert_card_access(db, meta, card_id)
    if not file.filename:
        raise HTTPException(status_code=400, detail="Файл не выбран.")

    content = await file.read()
    if len(content) > settings.youjail_max_attachment_bytes:
        raise HTTPException(status_code=400, detail="Файл слишком большой.")

    ext = Path(file.filename).suffix
    storage_name = f"{card_id}_{uuid4().hex}{ext}"
    storage_path = attachments_dir() / storage_name
    storage_path.write_bytes(content)

    content_type, _ = mimetypes.guess_type(file.filename)
    attachment = YouJailAttachment(
        card_id=card_id,
        filename=file.filename,
        storage_path=str(storage_path),
        content_type=content_type,
        size_bytes=len(content),
    )
    db.add(attachment)
    db.commit()
    db.refresh(attachment)
    return _serialize_attachment(attachment)


def load_attachment_file(db: Session, attachment_id: int, *, meta: dict) -> tuple[Path, str, str | None]:
    attachment = db.get(YouJailAttachment, attachment_id)
    if attachment is None:
        raise HTTPException(status_code=404, detail="Вложение не найдено.")
    assert_card_access(db, meta, attachment.card_id)
    path = Path(attachment.storage_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Файл вложения отсутствует.")
    return path, attachment.filename, attachment.content_type


def delete_attachment(db: Session, attachment_id: int, *, meta: dict) -> None:
    attachment = db.get(YouJailAttachment, attachment_id)
    if attachment is None:
        raise HTTPException(status_code=404, detail="Вложение не найдено.")
    assert_card_access(db, meta, attachment.card_id)
    path = Path(attachment.storage_path)
    if path.is_file():
        path.unlink(missing_ok=True)
    db.delete(attachment)
    db.commit()


def _append_log(db: Session, execution_id: int, seq: int, stream: str, content: str) -> int:
    log = YouJailExecutionLog(
        execution_id=execution_id,
        seq=seq,
        stream=stream,
        content=content,
    )
    db.add(log)
    db.commit()
    return seq + 1


def _prepare_worktree(db: Session, card: YouJailCard) -> str | None:
    project = db.get(YouJailProject, card.project_id) if card.project_id else None
    if project is None or not project.repo_path:
        return None
    repo_path = Path(project.repo_path)
    if not repo_path.is_dir():
        raise HTTPException(status_code=400, detail="Путь репозитория проекта недоступен.")

    branch = card.worktree_branch or f"youjail/card-{card.id}"
    target = worktrees_dir() / f"card-{card.id}"
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)

    subprocess.run(
        ["git", "worktree", "add", "-B", branch, str(target), "HEAD"],
        cwd=repo_path,
        check=True,
        capture_output=True,
        text=True,
    )
    card.worktree_path = str(target)
    card.worktree_branch = branch
    card.updated_at = _utcnow()
    db.commit()
    return str(target)


def _run_execution_thread(execution_id: int, card_id: int, command: str | None, feedback: str | None) -> None:
    from app.db import SessionLocal

    db = SessionLocal()
    seq = 0
    try:
        execution = db.get(YouJailExecution, execution_id)
        card = db.get(YouJailCard, card_id)
        if execution is None or card is None:
            return

        card.execution_status = "running"
        db.commit()

        seq = _append_log(db, execution_id, seq, "system", f"Старт исполнителя {execution.executor}")

        if command:
            seq = _append_log(db, execution_id, seq, "system", f"Команда: {command}")
            if feedback:
                seq = _append_log(db, execution_id, seq, "system", f"Обратная связь: {feedback}")

            def on_text_line(stream: str, line: str) -> None:
                nonlocal seq
                seq = _append_log(db, execution_id, seq, stream, line)

            exit_code = run_command_with_pty(
                execution_id,
                command,
                cwd=execution.worktree_path or None,
                on_text_line=on_text_line,
            )
            status = "succeeded" if exit_code == 0 else "failed"
            error_message = None if exit_code == 0 else f"Код выхода {exit_code}"
        else:
            seq = _append_log(
                db,
                execution_id,
                seq,
                "system",
                "YOUJAIL_EXECUTOR_COMMAND не задан — демо-режим (PTY).",
            )
            demo_command = (
                f'printf "%s\\n" "Задача: {card.title.replace(chr(34), chr(92)+chr(34))}"; '
                f'printf "%s\\n" "Откройте терминал в браузере для live-вывода."; sleep 1'
            )
            if card.description_md:
                for line in card.description_md.splitlines()[:10]:
                    safe_line = line.replace('"', '\\"')
                    demo_command += f'; printf "%s\\n" "{safe_line}"'
            if feedback:
                demo_command += f'; printf "%s\\n" "Retry feedback: {feedback.replace(chr(34), chr(92)+chr(34))}"'

            def on_demo_line(stream: str, line: str) -> None:
                nonlocal seq
                seq = _append_log(db, execution_id, seq, stream, line)

            exit_code = run_command_with_pty(
                execution_id,
                demo_command,
                cwd=execution.worktree_path or None,
                on_text_line=on_demo_line,
            )
            status = "succeeded" if exit_code == 0 else "failed"
            error_message = None if exit_code == 0 else f"Код выхода {exit_code}"

        execution.status = status
        execution.exit_code = exit_code
        execution.error_message = error_message
        execution.finished_at = _utcnow()
        card.execution_status = status
        card.updated_at = _utcnow()
        db.commit()
    except Exception as exc:
        logger.exception("YouJail execution failed card_id=%s", card_id)
        execution = db.get(YouJailExecution, execution_id)
        card = db.get(YouJailCard, card_id)
        if execution is not None:
            execution.status = "failed"
            execution.error_message = str(exc)
            execution.finished_at = _utcnow()
        if card is not None:
            card.execution_status = "failed"
            card.updated_at = _utcnow()
        try:
            seq = _append_log(db, execution_id, seq, "stderr", str(exc))
        except Exception:
            pass
        db.commit()
    finally:
        db.close()


def start_execution(db: Session, card_id: int, *, executor: str | None, feedback: str | None, meta: dict) -> dict:
    card = assert_card_access(db, meta, card_id)
    if card.execution_status == "running":
        raise HTTPException(status_code=409, detail="Карточка уже выполняется.")

    selected_executor = (executor or card.executor or "manual").strip().lower()
    if selected_executor not in EXECUTORS:
        raise HTTPException(status_code=400, detail="Неизвестный исполнитель.")

    worktree_path = _prepare_worktree(db, card)
    execution = YouJailExecution(
        card_id=card.id,
        executor=selected_executor,
        status="running",
        worktree_path=worktree_path,
    )
    card.executor = selected_executor
    card.execution_status = "queued"
    card.updated_at = _utcnow()
    db.add(execution)
    db.commit()
    db.refresh(execution)

    command_template = settings.youjail_executor_command.strip()
    command = None
    if command_template:
        command = command_template.format(
            worktree_path=worktree_path or "",
            title=card.title.replace('"', '\\"'),
            description=(card.description_md or "").replace('"', '\\"'),
            card_id=card.id,
            executor=selected_executor,
        )

    thread = threading.Thread(
        target=_run_execution_thread,
        args=(execution.id, card.id, command, feedback),
        daemon=True,
    )
    thread.start()
    return _serialize_execution(db, execution, with_logs=False)


def get_execution(db: Session, execution_id: int, *, meta: dict, with_logs: bool = True) -> dict:
    execution = db.get(YouJailExecution, execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail="Запуск не найден.")
    assert_card_access(db, meta, execution.card_id)
    return _serialize_execution(db, execution, with_logs=with_logs)


def list_card_executions(db: Session, card_id: int, *, meta: dict) -> list[dict]:
    assert_card_access(db, meta, card_id)
    executions = db.scalars(
        select(YouJailExecution)
        .where(YouJailExecution.card_id == card_id)
        .order_by(YouJailExecution.started_at.desc())
    ).all()
    return [_serialize_execution(db, execution, with_logs=False) for execution in executions]
