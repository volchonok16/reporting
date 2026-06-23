"""Признак «Приемка ЕЦТ»: Related-связь ЗНИ с элементом типа «Приемка ЕЦТ»."""

from __future__ import annotations

from typing import Iterable


def compute_ect_acceptance(
    zni_ids: Iterable[int],
    *,
    acceptance_zni_ids: set[int],
) -> dict[int, bool]:
    """ДА, если у ЗНИ есть Related на элемент типа «Приемка ЕЦТ»."""
    return {zni_id: zni_id in acceptance_zni_ids for zni_id in zni_ids}
