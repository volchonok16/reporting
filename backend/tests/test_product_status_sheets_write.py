import json
from pathlib import Path

from app.product_status_sheets_write import _load_service_account_info, _service_account_json_candidates


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
