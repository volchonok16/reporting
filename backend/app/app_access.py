from __future__ import annotations

FULL_APP_ROLE = "full"
ROADMAP_APP_ROLE = "roadmap"
ROADMAP_DIGITAL_BOARD_CODE = "digital_streams_b2b"


def normalize_app_role(value: str | None) -> str:
    if value == ROADMAP_APP_ROLE:
        return ROADMAP_APP_ROLE
    return FULL_APP_ROLE


def is_roadmap_role(role: str | None) -> bool:
    return normalize_app_role(role) == ROADMAP_APP_ROLE


def sync_board_denied_reason(role: str | None, board_code: str | None) -> str | None:
    if not is_roadmap_role(role):
        return None
    if board_code != ROADMAP_DIGITAL_BOARD_CODE:
        return "Доступна только синхронизация доски Digital Streams B2b"
    return None
