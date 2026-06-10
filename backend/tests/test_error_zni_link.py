from app.boards import board_by_code
from app.sync_service import has_required_tags


def test_digital_boards_do_not_filter_errors_by_tags() -> None:
    board = board_by_code("digital_streams_b2b")
    assert board is not None
    assert board.error_sync_tags == ()


def test_digital_error_sync_accepts_any_tags_in_area() -> None:
    board = board_by_code("digital_streams_b2b")
    assert board is not None
    fields = {"System.Tags": "B2B; HOLD; QA 8; TechTask"}
    assert has_required_tags(fields, board.error_sync_tags)


def test_be_board_still_filters_errors_by_tags() -> None:
    board = board_by_code("be_t2_team")
    assert board is not None
    assert board.error_sync_tags == ("FE B2B", "microservice")
