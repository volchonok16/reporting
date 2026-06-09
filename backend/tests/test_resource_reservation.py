from app.resource_reservation import (
    compute_ect_resource_reservation,
    ect_resource_reservation_label,
)


def test_compute_ect_resource_reservation() -> None:
    flags = compute_ect_resource_reservation(
        [100, 200],
        reservation_zni_ids={100},
    )
    assert flags == {100: True, 200: False}


def test_ect_resource_reservation_label() -> None:
    assert ect_resource_reservation_label(True) == "ДА"
    assert ect_resource_reservation_label(False) == "НЕТ"
    assert ect_resource_reservation_label(None) == "НЕТ"
