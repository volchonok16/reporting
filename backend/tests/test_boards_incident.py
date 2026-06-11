from app.boards import board_by_code


def test_bercut_board_syncs_incident_errors() -> None:
    board = board_by_code("be_t2_team")
    assert board is not None
    assert board.incident_error_area_path == r"BE-T2\Incident management"
    assert board.incident_error_sync_tags == ("b2b_product",)


def test_esb_board_has_no_incident_errors() -> None:
    board = board_by_code("esb_analytics")
    assert board is not None
    assert board.incident_error_area_path is None
