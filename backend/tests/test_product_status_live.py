from app.product_status_live import (
    WORKBOOK_B2B,
    gids_from_save_payload,
    product_status_live_broker,
)
from app.schemas import (
    ProductStatusCellUpdate,
    ProductStatusRowDelete,
    ProductStatusSaveIn,
    ProductStatusSheetRowOrder,
)


def test_gids_from_save_payload_collects_all_gids() -> None:
    payload = ProductStatusSaveIn(
        updates=[
            ProductStatusCellUpdate(gid="1512199647", rowIndex=1, columnIndex=0, value="a"),
            ProductStatusCellUpdate(gid="1699821818", rowIndex=2, columnIndex=1, value="b"),
        ],
        deletedRows=[ProductStatusRowDelete(gid="1512199647", rowId=10)],
        rowOrder=[ProductStatusSheetRowOrder(gid="0", rowIds=[1, 2, 3])],
    )
    assert gids_from_save_payload(payload) == ["0", "1512199647", "1699821818"]


def test_schedule_saved_ignores_unknown_workbook() -> None:
    product_status_live_broker.schedule_saved(
        workbook="unknown",
        gids=["1512199647"],
        changed_by="alex",
    )


def test_workbook_constants() -> None:
    assert WORKBOOK_B2B == "b2b"
