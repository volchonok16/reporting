"""Связь ошибок (Ошибка) с ЗНИ через Hierarchy-Forward."""

from __future__ import annotations

from typing import Any

from app.config import settings
from app.json_utils import as_dict, as_relation_list


def relation_target_id(relation: dict[str, Any]) -> int | None:
    if relation.get("ID") is not None:
        try:
            return int(relation["ID"])
        except (TypeError, ValueError):
            return None
    url = relation.get("url", "")
    try:
        return int(str(url).rstrip("/").split("/")[-1])
    except ValueError:
        return None


def relation_type(relation: dict[str, Any]) -> str:
    if relation.get("rel"):
        return str(relation["rel"])
    if relation.get("LinkType") is not None:
        return str(relation["LinkType"])
    return str(as_dict(relation.get("attributes")).get("name") or "unknown")


def is_parent_link(relation: dict[str, Any]) -> bool:
    link = relation_type(relation).lower()
    name = str(as_dict(relation.get("attributes")).get("name") or "").lower()
    if link in {
        "parent",
        "hierarchy-reverse",
        "system.linktypes.hierarchy-reverse",
    } or name in {"parent", "hierarchy-reverse", "system.linktypes.hierarchy-reverse"}:
        return True
    if relation.get("LinkType") == 1 or link == "1":
        return True
    return False


def is_child_link(relation: dict[str, Any]) -> bool:
    link = relation_type(relation).lower()
    name = str(as_dict(relation.get("attributes")).get("name") or "").lower()
    if link in {
        "child",
        "hierarchy-forward",
        "system.linktypes.hierarchy-forward",
    } or name in {"child", "hierarchy-forward", "system.linktypes.hierarchy-forward"}:
        return True
    if relation.get("LinkType") == 2 or link == "2":
        return True
    return False


def is_error_work_item_type(work_item_type: str | None) -> bool:
    if not work_item_type:
        return False
    normalized = work_item_type.strip().lower()
    return normalized in {value.lower() for value in settings.error_type_list}


def error_child_ids_from_zni(payload: dict[str, Any]) -> list[int]:
    result: list[int] = []
    for relation in as_relation_list(payload.get("relations")):
        if not is_child_link(relation):
            continue
        child_id = relation_target_id(relation)
        if child_id is not None:
            result.append(child_id)
    return result


def parent_zni_id_from_error_payload(payload: dict[str, Any]) -> int | None:
    """Родительское ЗНИ для ошибки: ссылка Hierarchy-Reverse на карточке ошибки."""
    for relation in as_relation_list(payload.get("relations")):
        if not is_parent_link(relation):
            continue
        parent_id = relation_target_id(relation)
        if parent_id is not None:
            return parent_id
    return None


def linked_item_parent_map(payloads: list[dict[str, Any]]) -> dict[int, int]:
    result: dict[int, int] = {}
    for payload in payloads:
        source_id = payload["id"]
        for relation in as_relation_list(payload.get("relations")):
            if not is_child_link(relation):
                continue
            child_id = relation_target_id(relation)
            if child_id is not None:
                result[child_id] = source_id
    return result
