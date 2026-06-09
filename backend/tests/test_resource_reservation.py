from app.resource_reservation import (
    compute_ect_resource_reservation,
    ect_resource_reservation_label,
    merge_undirected_pairs,
)


def test_merge_undirected_pairs() -> None:
    graph = merge_undirected_pairs([(1, 2), (2, 3)])
    assert graph[1] == {2}
    assert graph[2] == {1, 3}
    assert graph[3] == {2}


def test_compute_ect_resource_reservation_direct() -> None:
    flags = compute_ect_resource_reservation(
        [100, 200],
        direct_reservation_zni_ids={100},
        related_zni_ids={},
    )
    assert flags == {100: True, 200: False}


def test_compute_ect_resource_reservation_via_related_zni() -> None:
    flags = compute_ect_resource_reservation(
        [100],
        direct_reservation_zni_ids={200},
        related_zni_ids={100: {200}},
    )
    assert flags == {100: True}


def test_compute_ect_resource_reservation_without_link() -> None:
    flags = compute_ect_resource_reservation(
        [100],
        direct_reservation_zni_ids={200},
        related_zni_ids={100: {300}},
    )
    assert flags == {100: False}


def test_ect_resource_reservation_label() -> None:
    assert ect_resource_reservation_label(True) == "ДА"
    assert ect_resource_reservation_label(False) == "НЕТ"
    assert ect_resource_reservation_label(None) == "НЕТ"
