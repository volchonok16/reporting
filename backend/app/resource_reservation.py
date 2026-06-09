"""Признак «Бронь ресурса ЕЦТ»: Related-связь ЗНИ с элементом «Бронь ресурсов»."""

from __future__ import annotations

from typing import Iterable


def compute_ect_resource_reservation(
    zni_ids: Iterable[int],
    *,
    reservation_zni_ids: set[int],
) -> dict[int, bool]:
    """ДА, если у ЗНИ есть Related на элемент типа «Бронь ресурсов»."""
    return {zni_id: zni_id in reservation_zni_ids for zni_id in zni_ids}


def ect_resource_reservation_label(value: bool | None) -> str:
    return "ДА" if value else "НЕТ"
