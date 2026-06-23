"""Связанные окружения Digital ЗНИ: CRM (Продукты) и Bercut (BE Analytics)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.boards import BoardConfig, board_by_code


@dataclass(frozen=True)
class LinkedEnvironmentTarget:
    key: str
    label: str
    board_code: str

    def board(self) -> BoardConfig:
        board = board_by_code(self.board_code)
        if board is None:
            raise ValueError(f"Доска {self.board_code} не найдена")
        return board


DIGITAL_LINKED_ENVIRONMENT_TARGETS: tuple[LinkedEnvironmentTarget, ...] = (
    LinkedEnvironmentTarget(key="crm", label="CRM", board_code="tele2_products"),
    LinkedEnvironmentTarget(key="bercut", label="Bercut", board_code="be_t2_team"),
)


def linked_environment_records_from_extra(extra: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(extra, dict):
        return []
    raw = extra.get("linked_environments")
    if not isinstance(raw, list):
        return []
    records: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip()
        zni_id = str(item.get("zni_id") or item.get("zniId") or "").strip()
        if not key or not zni_id:
            continue
        records.append(item)
    return records
