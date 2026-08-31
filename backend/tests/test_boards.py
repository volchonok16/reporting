from app.boards import (
    ALL_BOARDS_CODE,
    BoardConfig,
    board_by_code,
    boards_for_sync,
    boards_sharing_alias,
    ensure_boards_loaded,
    get_boards,
    grouped_boards_for_ui,
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


def _extra_products_board() -> BoardConfig:
    return BoardConfig(
        code="products_other",
        name="Другие продукты",
        display_name="Продукты",
        project="Tele2",
        project_id="pid",
        team_id="tid",
        area_path=r"Tele2\Other\Products",
        sync_tags=("b2b_product",),
    )


def test_same_alias_boards_collapse_in_ui_and_expand_for_sync() -> None:
    boards = [*get_boards(), _extra_products_board()]
    ui = grouped_boards_for_ui(boards)
    display_names = [board.display_name for board in ui]
    assert display_names.count("Продукты") == 1
    assert all(board.code != "products_other" for board in ui)

    by_first = boards_for_sync("tele2_products", boards)
    by_second = boards_for_sync("products_other", boards)
    assert {board.code for board in by_first} == {"tele2_products", "products_other"}
    assert {board.code for board in by_second} == {"tele2_products", "products_other"}
    assert [board.code for board in boards_sharing_alias(by_first[0], boards)] == [
        "tele2_products",
        "products_other",
    ]


def test_same_alias_and_board_name_still_expands_all_area_paths() -> None:
    crm = BoardConfig(
        code="crm",
        name="CRM&DocOut",
        display_name="CRM",
        project="Tele2",
        project_id="pid",
        team_id="tid",
        area_path=r"Tele2\CRM\Prometheus",
    )
    docout = BoardConfig(
        code="docout",
        name="CRM&DocOut",
        display_name="CRM",
        project="Tele2",
        project_id="pid",
        team_id="tid",
        area_path=r"Tele2\CRM\CRM Team DoC",
    )
    extra = BoardConfig(
        code="crm_more",
        name="CRM Extra",
        display_name="CRM",
        project="Tele2",
        project_id="pid",
        team_id="tid",
        area_path=r"Tele2\CRM\Other",
    )
    boards = [*get_boards(), crm, docout, extra]
    ui = grouped_boards_for_ui(boards)
    assert sum(1 for board in ui if board.display_name == "CRM") == 1
    synced = boards_for_sync("crm", boards)
    assert {board.code for board in synced} == {"crm", "docout", "crm_more"}
    assert {board.area_path for board in synced} == {
        r"Tele2\CRM\Prometheus",
        r"Tele2\CRM\CRM Team DoC",
        r"Tele2\CRM\Other",
    }


def test_same_alias_is_case_and_space_insensitive() -> None:
    extra = BoardConfig(
        code="products_spaced",
        name="Products Spaced",
        display_name="  продукты  ",
        project="Tele2",
        project_id="pid",
        team_id="tid",
        area_path=r"Tele2\Spaced\Products",
    )
    boards = [*get_boards(), extra]
    ui = grouped_boards_for_ui(boards)
    assert sum(1 for board in ui if board.code in {"tele2_products", "products_spaced"}) == 1
    assert {board.code for board in boards_for_sync("tele2_products", boards)} == {
        "tele2_products",
        "products_spaced",
    }
