from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.app_access import can_manage_org
from app.org_service import get_employee_for_org_user
from app.youjail_models import (
    YouJailBoard,
    YouJailBoardMember,
    YouJailBoardTeam,
    YouJailCard,
    YouJailTeam,
    YouJailTeamMember,
)

BOARD_MEMBER_ROLES = frozenset({"admin", "member"})


def actor_employee_id(db: Session, meta: dict) -> int | None:
    org_user_id = meta.get("org_user_id")
    if not org_user_id:
        return None
    employee = get_employee_for_org_user(db, int(org_user_id))
    return employee.id if employee else None


def is_youjail_admin(meta: dict) -> bool:
    return can_manage_org(meta)


def accessible_board_ids(db: Session, meta: dict) -> set[int] | None:
    """None = все доски (админ). Иначе — только id доступных досок."""
    if is_youjail_admin(meta):
        return None
    employee_id = actor_employee_id(db, meta)
    if employee_id is None:
        return set()
    rows = db.scalars(
        select(YouJailBoardTeam.board_id)
        .join(YouJailTeamMember, YouJailTeamMember.team_id == YouJailBoardTeam.team_id)
        .join(YouJailTeam, YouJailTeam.id == YouJailBoardTeam.team_id)
        .where(
            YouJailTeamMember.employee_id == employee_id,
            YouJailTeam.is_active.is_(True),
        )
        .distinct()
    ).all()
    allowed = set(rows)
    personal_board_id = db.scalar(
        select(YouJailBoard.id).where(
            YouJailBoard.owner_employee_id == employee_id,
            YouJailBoard.is_active.is_(True),
        )
    )
    if personal_board_id is not None:
        allowed.add(personal_board_id)
    shared_board_ids = db.scalars(
        select(YouJailBoardMember.board_id)
        .join(YouJailBoard, YouJailBoard.id == YouJailBoardMember.board_id)
        .where(
            YouJailBoardMember.employee_id == employee_id,
            YouJailBoard.is_active.is_(True),
        )
    ).all()
    allowed.update(shared_board_ids)
    return allowed


def can_manage_board(db: Session, meta: dict, board_id: int) -> bool:
    if is_youjail_admin(meta):
        return True
    employee_id = actor_employee_id(db, meta)
    if employee_id is None:
        return False
    board = db.get(YouJailBoard, board_id)
    if board is None:
        return False
    if board.owner_employee_id == employee_id:
        return True
    role = db.scalar(
        select(YouJailBoardMember.role).where(
            YouJailBoardMember.board_id == board_id,
            YouJailBoardMember.employee_id == employee_id,
        )
    )
    return role == "admin"


def assert_youjail_admin(meta: dict) -> None:
    if not is_youjail_admin(meta):
        raise HTTPException(status_code=403, detail="Недостаточно прав для управления досками и командами.")


def assert_board_manage(db: Session, meta: dict, board_id: int) -> None:
    assert_board_access(db, meta, board_id)
    if not can_manage_board(db, meta, board_id):
        raise HTTPException(status_code=403, detail="Недостаточно прав для управления этой доской.")


def assert_board_access(db: Session, meta: dict, board_id: int) -> None:
    allowed = accessible_board_ids(db, meta)
    if allowed is None:
        return
    if board_id not in allowed:
        raise HTTPException(status_code=403, detail="Нет доступа к этой доске.")


def assert_card_access(db: Session, meta: dict, card_id: int) -> YouJailCard:
    card = db.get(YouJailCard, card_id)
    if card is None:
        raise HTTPException(status_code=404, detail="Карточка не найдена.")
    assert_board_access(db, meta, card.board_id)
    return card


def team_member_count(db: Session, team_id: int) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(YouJailTeamMember)
            .where(YouJailTeamMember.team_id == team_id)
        )
        or 0
    )
