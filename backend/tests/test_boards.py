from app.boards import (
    ALL_BOARDS_CODE,
    board_by_code,
    boards_for_sync,
    ensure_boards_loaded,
    get_boards,
    is_all_boards,
    load_boards,
    parse_csv_tags,
)


def test_parse_csv_tags() -> None:
    assert parse_csv_tags("") == ()
    assert parse_csv_tags(None) == ()
    assert parse_csv_tags("a, b") == ("a", "b")
    assert parse_csv_tags("EFO,not_product") == ("EFO", "not_product")


def test_is_all_boards() -> None:
    assert is_all_boards("all")
    assert is_all_boards(" ALL ")
    assert not is_all_boards("digital_streams_b2b")


def test_boards_for_sync_all() -> None:
    boards = boards_for_sync(ALL_BOARDS_CODE)
    cached = get_boards()
    assert len(boards) == len(cached)
    assert {board.code for board in boards} == {board.code for board in cached}


def test_boards_for_sync_single() -> None:
    boards = boards_for_sync("b2b_product_core")
    assert len(boards) == 1
    assert boards[0].code == "b2b_product_core"
    assert boards[0].display_name == "CORE"


def test_tele2_products_board() -> None:
    boards = boards_for_sync("tele2_products")
    assert len(boards) == 1
    board = boards[0]
    assert board.display_name == "Продукты"
    assert board.area_path == r"Tele2\Продукты"
    assert board.sync_tags == ("b2b_product",)


def test_reports_board() -> None:
    boards = boards_for_sync("reports")
    assert len(boards) == 1
    board = boards[0]
    assert board.display_name == "Reports"
    assert board.area_path == r"Tele2\Reports\Team A"
    assert board.sync_tags == ("b2b_product",)


def test_aliases() -> None:
    assert board_by_code("digital_streams_b2b").display_name == "Digital"
    assert board_by_code("be_t2_team").display_name == "Bercut"
    assert board_by_code("esb_analytics").display_name == "ESB"
    assert board_by_code("b2b_product_core").display_name == "CORE"


def test_board_by_code_is_case_insensitive() -> None:
    assert board_by_code("B2B_PRODUCT_CORE").display_name == "CORE"


def test_ensure_boards_loaded_keeps_cache_without_refresh() -> None:
    from unittest.mock import MagicMock

    before = [board.code for board in get_boards()]
    db = MagicMock()
    result = ensure_boards_loaded(db)
    db.scalars.assert_not_called()
    assert [board.code for board in result] == before


def test_load_boards_replaces_cache_with_db_rows() -> None:
    from types import SimpleNamespace

    row = SimpleNamespace(
        code="  New_Board  ",
        alias="Новая",
        board_name="New Board",
        project="Tele2",
        project_id="pid",
        team_id="tid",
        area_path="Tele2/New/Team",
        sync_tags="b2b_product",
        other_tags="",
        error_sync_tags="",
        exclude_sync_tags="EFO",
        exclude_sync_states="",
        launching_soon_states="UAT",
        launching_soon_triage_values="",
        launched_states="Pilot",
        in_progress_states="Development",
        incident_error_area_path=None,
        incident_error_sync_tags="",
    )

    class FakeDb:
        def scalars(self, _stmt):
            return [row]

    boards = load_boards(FakeDb())
    assert len(boards) == 1
    assert boards[0].code == "New_Board"
    assert boards[0].display_name == "Новая"
    assert boards[0].area_path == r"Tele2\New\Team"
    assert boards[0].sync_tags == ("b2b_product",)
    assert get_boards()[0].code == "New_Board"
    assert board_by_code("new_board") is not None
    assert board_by_code("  NEW_BOARD  ") is not None


def test_boards_for_sync_unknown_code_is_empty() -> None:
    assert boards_for_sync("does_not_exist") == []
