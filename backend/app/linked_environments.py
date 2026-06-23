"""Загрузка и сохранение связей Digital ЗНИ с окружениями CRM и Bercut."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.boards import BoardConfig
from app.models import Task
from app.tfs_client import TfsClient
from app.zni_linked_environments import (
    DIGITAL_LINKED_ENVIRONMENT_TARGETS,
    LinkedEnvironmentTarget,
)

_LINK_STATUS_FIELDS = [
    "System.Id",
    "System.State",
    "System.BoardColumn",
]


def _tfs_item_url(item_id: int, board: BoardConfig) -> str:
    return f"{board.base_url.rstrip('/')}/{board.project}/_workitems/edit/{item_id}"


def _linked_record(
    target: LinkedEnvironmentTarget,
    *,
    linked_id: int,
    fields: dict[str, Any],
    url: str,
) -> dict[str, Any]:
    status = fields.get("System.State")
    board_column = fields.get("System.BoardColumn")
    return {
        "key": target.key,
        "label": target.label,
        "zni_id": str(linked_id),
        "status": str(status).strip() if status not in (None, "") else None,
        "board_column": str(board_column).strip() if board_column not in (None, "") else None,
        "url": url,
    }


async def load_digital_linked_environments(
    client: TfsClient,
    *,
    digital_board: BoardConfig,
    target: LinkedEnvironmentTarget,
    pat: str,
) -> dict[int, list[dict[str, Any]]]:
    """digital_zni_id -> список связанных окружений (может быть несколько Related)."""
    target_board = target.board()
    link_map = await client.get_related_change_request_links_between_areas(
        source_area_path=digital_board.area_path,
        source_project=digital_board.project,
        target_area_path=target_board.area_path,
        target_project=target_board.project,
    )
    if not link_map:
        return {}

    linked_ids = sorted({linked_id for linked in link_map.values() for linked_id in linked})
    target_client = TfsClient(target_board.to_tfs_auth(pat))
    payloads = await target_client.get_work_items_batch(
        linked_ids,
        expand_relations=False,
        fields=_LINK_STATUS_FIELDS,
    )
    fields_by_id = {
        int(item["id"]): item.get("fields") or {}
        for item in payloads
        if isinstance(item, dict) and item.get("id") is not None
    }

    result: dict[int, list[dict[str, Any]]] = {}
    for digital_id, linked_list in link_map.items():
        records: list[dict[str, Any]] = []
        for linked_id in linked_list:
            fields = fields_by_id.get(linked_id)
            if not fields:
                continue
            records.append(
                _linked_record(
                    target,
                    linked_id=linked_id,
                    fields=fields,
                    url=_tfs_item_url(linked_id, target_board),
                )
            )
        if records:
            result[digital_id] = records
    return result


async def sync_digital_linked_environments(
    db: Session,
    client: TfsClient,
    *,
    digital_board: BoardConfig,
    zni_db_ids: dict[int, int],
    pat: str,
) -> None:
    """Обновляет extra_json.linked_environments для ЗНИ доски Digital."""
    if not zni_db_ids:
        return

    combined: dict[int, list[dict[str, Any]]] = {zni_id: [] for zni_id in zni_db_ids}
    for target in DIGITAL_LINKED_ENVIRONMENT_TARGETS:
        by_digital = await load_digital_linked_environments(
            client,
            digital_board=digital_board,
            target=target,
            pat=pat,
        )
        for digital_id, records in by_digital.items():
            if digital_id in combined:
                combined[digital_id].extend(records)

    for external_id, task_id in zni_db_ids.items():
        row = db.get(Task, task_id)
        if row is None:
            continue
        extra = dict(row.extra_json) if isinstance(row.extra_json, dict) else {}
        extra["linked_environments"] = combined.get(external_id, [])
        row.extra_json = extra
        db.add(row)
