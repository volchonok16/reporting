from app.boards import BoardConfig, normalize_tfs_path
from app.product_fields import board_for_area_path, product_owner_from_fields


def _board(code: str, area_path: str, display_name: str | None = None) -> BoardConfig:
    return BoardConfig(
        code=code,
        name=display_name or code,
        display_name=display_name or code,
        project="Tele2",
        project_id="proj",
        team_id="team",
        area_path=area_path,
    )


def test_product_owner_from_logrocon_po() -> None:
    fields = {
        "Logrocon.PO": {
            "displayName": "Иванов Иван",
            "uniqueName": "T2RU\\ivanov",
        }
    }
    assert product_owner_from_fields(fields) == "Иванов Иван"


def test_board_for_area_path_picks_most_specific() -> None:
    boards = [
        _board("b2b_product_core", r"Tele2\B2B Product", "CORE"),
        _board("b2b_voice_products", r"Tele2\B2B Product\B2B Voice Products", "Голосовые продукты"),
    ]
    matched = board_for_area_path(
        normalize_tfs_path(r"Tele2\B2B Product\B2B Voice Products"),
        boards,
    )
    assert matched is not None
    assert matched.code == "b2b_voice_products"
