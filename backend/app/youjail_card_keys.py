from __future__ import annotations

import re

from fastapi import HTTPException

from app.youjail_models import YouJailBoard

PERSONAL_CARD_KEY_PREFIX = "MY"
_CARD_KEY_RE = re.compile(r"^([A-Za-z0-9_-]+)-(\d+)$")


def card_key_for_board(board: YouJailBoard, card_number: int) -> str:
    if board.owner_employee_id is not None:
        return f"{PERSONAL_CARD_KEY_PREFIX}-{card_number}"
    prefix = board.slug.upper().replace("-", "")
    return f"{prefix}-{card_number}"


def resolve_card_number(board: YouJailBoard, card_key: str) -> int | None:
    match = _CARD_KEY_RE.match(card_key.strip().upper())
    if not match:
        return None
    prefix, number_raw = match.group(1), int(match.group(2))
    if board.owner_employee_id is not None:
        if prefix == PERSONAL_CARD_KEY_PREFIX:
            return number_raw
        legacy_prefix = board.slug.upper().replace("-", "")
        if prefix == legacy_prefix:
            return number_raw
        return None
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
