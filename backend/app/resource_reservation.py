"""Признак «Бронь ресурса ЕЦТ» по Related-связям ЗНИ с типами бронирования."""

from __future__ import annotations

from collections import defaultdict
from typing import Iterable


def merge_undirected_pairs(pairs: Iterable[tuple[int, int]]) -> dict[int, set[int]]:
    graph: dict[int, set[int]] = defaultdict(set)
    for left, right in pairs:
        graph[left].add(right)
        graph[right].add(left)
    return graph


def compute_ect_resource_reservation(
    zni_ids: Iterable[int],
    *,
    direct_reservation_zni_ids: set[int],
    related_zni_ids: dict[int, set[int]],
) -> dict[int, bool]:
    """ДА, если у ЗНИ есть Related на «Бронь ресурсов» или такая связь у связанной ЗНИ."""
    result: dict[int, bool] = {}
    for zni_id in zni_ids:
        if zni_id in direct_reservation_zni_ids:
            result[zni_id] = True
            continue
        related = related_zni_ids.get(zni_id, set())
        result[zni_id] = any(related_id in direct_reservation_zni_ids for related_id in related)
    return result


def ect_resource_reservation_label(value: bool | None) -> str:
    return "ДА" if value else "НЕТ"
