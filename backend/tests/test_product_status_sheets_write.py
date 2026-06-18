import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.product_status_sheets_write import (
    _cell_update_requests,
    _load_service_account_info,
    _service_account_json_candidates,
    save_workbook_cells_to_google,
)
from app.schemas import ProductStatusCellUpdate, ProductStatusSaveIn


def test_service_account_json_candidates_include_repo_secrets() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    candidates = _service_account_json_candidates("/app/secrets/google-sheets-sa.json")
    assert repo_root / "secrets" / "google-sheets-sa.json" in candidates


def test_load_service_account_info_from_file_path(tmp_path: Path) -> None:
    key_path = tmp_path / "sa.json"
    payload = {"type": "service_account", "client_email": "sa@example.iam.gserviceaccount.com"}
    key_path.write_text(json.dumps(payload), encoding="utf-8")

    info, error = _load_service_account_info(str(key_path))
    assert error is None
    assert info is not None
    assert info["client_email"] == "sa@example.iam.gserviceaccount.com"


def test_load_service_account_info_inline_json() -> None:
    raw = '{"type":"service_account","client_email":"inline@example.com"}'
    info, error = _load_service_account_info(raw)
    assert error is None
    assert info is not None
    assert info["client_email"] == "inline@example.com"


def test_load_service_account_info_missing_reports_reason(monkeypatch, tmp_path: Path) -> None:
    missing = tmp_path / "missing.json"
    monkeypatch.setattr(
        "app.product_status_sheets_write._service_account_json_candidates",
        lambda _raw: [missing],
    )
    info, error = _load_service_account_info(str(missing))
    assert info is None
    assert error is not None
    assert "не найден" in error


def test_cell_update_requests_zni_column_uses_number_value() -> None:
    updates = [
        ProductStatusCellUpdate(
            gid="102191664",
            rowIndex=2,
            columnIndex=6,
            value="441181",
            column="ЗНИ",
        ),
    ]
    requests = _cell_update_requests(sheet_gid=102191664, updates=updates)
    cell = requests[0]["updateCells"]["rows"][0]["values"][0]
    assert cell["userEnteredValue"] == {"numberValue": 441181}


def test_cell_update_requests_single_data_cell() -> None:
    updates = [
        ProductStatusCellUpdate(gid="102191664", rowIndex=2, columnIndex=3, value="новое значение"),
    ]
    requests = _cell_update_requests(sheet_gid=102191664, updates=updates)
    assert len(requests) == 1
    request = requests[0]["updateCells"]
    assert request["range"] == {
        "sheetId": 102191664,
        "startRowIndex": 2,
        "endRowIndex": 3,
        "startColumnIndex": 3,
        "endColumnIndex": 4,
    }
    assert request["fields"] == "userEnteredValue,userEnteredFormat,textFormatRuns"
    assert request["rows"][0]["values"][0]["userEnteredValue"]["stringValue"] == "новое значение"


def test_cell_update_requests_header_cell_is_bold() -> None:
    updates = [ProductStatusCellUpdate(gid="0", rowIndex=0, columnIndex=1, value="Новый столбец")]
    requests = _cell_update_requests(sheet_gid=0, updates=updates)
    cell = requests[0]["updateCells"]["rows"][0]["values"][0]
    assert cell["userEnteredFormat"]["textFormat"]["bold"] is True
    assert requests[0]["updateCells"]["fields"] == "userEnteredValue,userEnteredFormat"


def test_save_workbook_cells_to_google_rejects_empty_payload() -> None:
    with pytest.raises(HTTPException) as exc:
        save_workbook_cells_to_google(
            spreadsheet_id="spreadsheet-id",
            data=ProductStatusSaveIn(updates=[]),
        )
    assert exc.value.status_code == 400


@patch("app.product_status_sheets_write._access_token", return_value="token")
@patch("app.product_status_sheets_write.normalize_google_sheets_api_key", return_value="api-key")
@patch("app.product_status_sheets_write._resolve_sheet_title", return_value="Лист 1")
def test_save_workbook_cells_to_google_posts_only_changed_cells(
    mock_resolve_title: MagicMock,
    _mock_api_key: MagicMock,
    _mock_token: MagicMock,
) -> None:
    captured: dict = {}

    class FakeResponse:
        status_code = 200

        @staticmethod
        def json() -> dict:
            return {}

    class FakeClient:
        def __enter__(self) -> "FakeClient":
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def post(self, url: str, *, headers: dict, json: dict) -> FakeResponse:
            captured["url"] = url
            captured["headers"] = headers
            captured["json"] = json
            return FakeResponse()

    with patch("app.product_status_sheets_write.httpx.Client", return_value=FakeClient()):
        save_workbook_cells_to_google(
            spreadsheet_id="spreadsheet-id",
            data=ProductStatusSaveIn(
                updates=[
                    ProductStatusCellUpdate(gid="42", rowIndex=1, columnIndex=0, value="A1"),
                    ProductStatusCellUpdate(gid="42", rowIndex=2, columnIndex=1, value="B2"),
                ]
            ),
        )

    assert captured["url"].endswith("/spreadsheet-id:batchUpdate")
    requests = captured["json"]["requests"]
    assert len(requests) == 2
    assert requests[0]["updateCells"]["range"]["startRowIndex"] == 1
    assert requests[1]["updateCells"]["range"]["startColumnIndex"] == 1
    mock_resolve_title.assert_called_once()
