from __future__ import annotations

import re

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.youjail_access import accessible_board_ids
from app.youjail_models import YouJailBoard, YouJailCard

_CARD_KEY_RE = re.compile(r"^([A-Za-z0-9_-]+)-(\d+)$")


def card_key_for_board(board: YouJailBoard, card_number: int, **_kwargs) -> str:
    prefix = board.slug.upper().replace("-", "")
    return f"{prefix}-{card_number}"


def global_card_key(board: YouJailBoard, card_number: int) -> str:
    return card_key_for_board(board, card_number)


def resolve_card_number(board: YouJailBoard, card_key: str) -> int | None:
    match = _CARD_KEY_RE.match(card_key.strip().upper())
    if not match:
        return None
    prefix, number_raw = match.group(1), int(match.group(2))
    expected = board.slug.upper().replace("-", "")
    if prefix != expected:
        return None
    return number_raw


def parse_card_keys(raw: str | None) -> list[str]:
    if not raw or not str(raw).strip():
        return []
    seen: set[str] = set()
    keys: list[str] = []
    for part in re.split(r"[,;]+", str(raw)):
        token = part.strip().upper()
        if not token or token in seen:
            continue
        if not _CARD_KEY_RE.match(token):
            raise HTTPException(status_code=400, detail=f"Некорректный ключ карточки: {part.strip()}")
        seen.add(token)
        keys.append(token)
    return keys


def _board_prefix(board: YouJailBoard) -> str:
    return board.slug.upper().replace("-", "")


def _accessible_boards(db: Session, meta: dict) -> list[YouJailBoard]:
    query = select(YouJailBoard).where(YouJailBoard.is_active.is_(True))
    allowed = accessible_board_ids(db, meta)
    if allowed is not None:
        if not allowed:
            return []
        query = query.where(YouJailBoard.id.in_(allowed))
    return list(db.scalars(query).all())


def find_card_by_key(db: Session, meta: dict, card_key: str) -> YouJailCard:
    match = _CARD_KEY_RE.match(card_key.strip().upper())
    if not match:
        raise HTTPException(status_code=400, detail=f"Некорректный ключ карточки: {card_key}")

    prefix, card_number = match.group(1), int(match.group(2))
    matches: list[tuple[YouJailBoard, YouJailCard]] = []

    for board in _accessible_boards(db, meta):
        if prefix != _board_prefix(board):
            continue

        card = db.scalar(
            select(YouJailCard).where(
                YouJailCard.board_id == board.id,
                YouJailCard.card_number == card_number,
            )
        )
        if card is not None:
            matches.append((board, card))

    if not matches:
        raise HTTPException(status_code=400, detail=f"Карточка {card_key.strip().upper()} не найдена или недоступна")

    if len(matches) > 1:
        hints = ", ".join(global_card_key(board, card.card_number) for board, card in matches)
        raise HTTPException(
            status_code=400,
            detail=f"Ключ {card_key.strip().upper()} неоднозначен. Уточните: {hints}",
        )

    return matches[0][1]
