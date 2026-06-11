from app.product_status_service import (
    _pair_captions_with_gids,
    discover_sheet_tabs,
    normalize_google_sheets_api_key,
    parse_sheet_csv,
    parse_sheets_config,
    resolve_sheet_tabs,
)


def test_parse_sheet_csv() -> None:
    csv_text = (
        "Дата запуска,Проект,Описание проекта\n"
        "09.06,Ремонт,Убираем 300 рублевые офферы\n"
        ",CORE,Перенос номеров\n"
    )
    columns, rows = parse_sheet_csv(csv_text)
    assert columns == ["Дата запуска", "Проект", "Описание проекта"]
    assert len(rows) == 2
    assert rows[0]["Проект"] == "Ремонт"
    assert rows[1]["Проект"] == "CORE"


def test_parse_sheet_csv_skips_empty_rows() -> None:
    csv_text = "A,B\n,,\n"
    columns, rows = parse_sheet_csv(csv_text)
    assert columns == ["A", "B"]
    assert rows == []


def test_parse_sheets_config_json() -> None:
    raw = '[{"gid":"0","name":"Лист 1"},{"gid":"123","name":"Лист 2"}]'
    assert parse_sheets_config(raw) == [
        {"gid": "0", "name": "Лист 1"},
        {"gid": "123", "name": "Лист 2"},
    ]


def test_parse_sheets_config_compact() -> None:
    assert parse_sheets_config("0:Статус;123456:Архив") == [
        {"gid": "0", "name": "Статус"},
        {"gid": "123456", "name": "Архив"},
    ]


def test_parse_sheets_config_rejects_url() -> None:
    assert parse_sheets_config(
        "https://docs.google.com/presentation/d/abc/edit"
    ) == []


def test_parse_sheets_config_skips_invalid_gid() -> None:
    assert parse_sheets_config("https:broken;0:CORE") == [
        {"gid": "0", "name": "CORE"},
    ]


def test_normalize_google_sheets_api_key_rejects_sheet_url() -> None:
    assert (
        normalize_google_sheets_api_key(
            "https://docs.google.com/spreadsheets/d/abc/edit?usp=sharing"
        )
        == ""
    )


def test_normalize_google_sheets_api_key_accepts_api_key() -> None:
    assert normalize_google_sheets_api_key("AIzaSyAbcdefghijklmnop") == "AIzaSyAbcdefghijklmnop"


def test_pair_captions_with_gids() -> None:
    paired = _pair_captions_with_gids(
        ["Продуктовый офис: CORE", "Продуктовый офис: SMS"],
        ["0", "1512199647"],
    )
    assert paired == [
        {"gid": "0", "name": "Продуктовый офис: CORE"},
        {"gid": "1512199647", "name": "Продуктовый офис: SMS"},
    ]


def test_discover_sheet_tabs_from_html() -> None:
    edit_html = (
        '<div class="docs-sheet-tab-caption">Продуктовый офис: CORE</div>'
        '<div class="docs-sheet-tab-caption">Продуктовый офис: SMS</div>'
    )
    htmlview_html = '<a href="#gid=0">one</a><a href="#gid=1512199647">two</a>'

    class FakeResponse:
        def __init__(self, text: str) -> None:
            self.text = text

        def raise_for_status(self) -> None:
            return None

    class FakeClient:
        def get(self, url: str) -> FakeResponse:
            if url.endswith("/htmlview"):
                return FakeResponse(htmlview_html)
            return FakeResponse(edit_html)

    sheets = discover_sheet_tabs("spreadsheet-id", client=FakeClient())  # type: ignore[arg-type]
    assert sheets == [
        {"gid": "0", "name": "Продуктовый офис: CORE"},
        {"gid": "1512199647", "name": "Продуктовый офис: SMS"},
    ]


def test_resolve_sheet_tabs_uses_known_defaults(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.product_status_service.settings.b2b_product_status_sheets",
        "",
    )
    monkeypatch.setattr(
        "app.product_status_service.settings.b2b_product_status_spreadsheet_id",
        "1zTxzUqa1p6wFUjmk-8_2czfsJaSm3eTrNGazN0oFKqI",
    )
    monkeypatch.setattr(
        "app.product_status_service.discover_sheet_tabs",
        lambda *_args, **_kwargs: [],
    )

    class EmptyClient:
        pass

    sheets = resolve_sheet_tabs(client=EmptyClient())  # type: ignore[arg-type]
    assert len(sheets) == 6
    assert sheets[0]["name"] == "Продуктовый офис: CORE"
