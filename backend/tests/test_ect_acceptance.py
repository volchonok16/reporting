from app.ect_acceptance import compute_ect_acceptance


def test_compute_ect_acceptance() -> None:
    flags = compute_ect_acceptance(
        [100, 200],
        acceptance_zni_ids={100},
    )
    assert flags == {100: True, 200: False}
