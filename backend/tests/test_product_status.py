from app.product_status_service import (
    discover_sheet_tabs,
    parse_sheet_csv,
    parse_sheets_config,
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


def test_discover_sheet_tabs_from_html() -> None:
    html = (
        '{"sheetId":0,"title":"Статус продукта"},'
        '{"sheetId":123456789,"title":"Планы 2026"}'
    )

    class FakeResponse:
        text = html

        def raise_for_status(self) -> None:
            return None

    class FakeClient:
        def get(self, _url: str) -> FakeResponse:
            return FakeResponse()

    sheets = discover_sheet_tabs("spreadsheet-id", client=FakeClient())  # type: ignore[arg-type]
    assert sheets == [
        {"gid": "0", "name": "Статус продукта"},
        {"gid": "123456789", "name": "Планы 2026"},
    ]
