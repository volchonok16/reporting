from typing import Any


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def as_relation_list(value: Any) -> list[dict[str, Any]]:
    return [item for item in as_list(value) if isinstance(item, dict)]


def as_work_item_list(value: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for item in as_list(value):
        if not isinstance(item, dict):
            continue
        item_id = item.get("id")
        if item_id is None:
            continue
        items.append(item)
    return items
