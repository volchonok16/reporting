from app.boards import BOARDS, ALL_BOARDS_CODE, boards_for_sync, is_all_boards


def test_is_all_boards() -> None:
    assert is_all_boards("all")
    assert is_all_boards(" ALL ")
    assert not is_all_boards("digital_streams_b2b")


def test_boards_for_sync_all() -> None:
    boards = boards_for_sync(ALL_BOARDS_CODE)
    assert len(boards) == len(BOARDS)
    assert {board.code for board in boards} == {board.code for board in BOARDS}


def test_boards_for_sync_single() -> None:
    boards = boards_for_sync("b2b_product_core")
    assert len(boards) == 1
    assert boards[0].code == "b2b_product_core"


def test_tele2_products_board() -> None:
    boards = boards_for_sync("tele2_products")
    assert len(boards) == 1
    board = boards[0]
    assert board.display_name == "Продукты"
    assert board.area_path == r"Tele2\Продукты"
    assert board.sync_tags == ("b2b_product",)
