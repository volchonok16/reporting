from app.b2b_news_service import load_b2b_news
from app.google_sheets_workbook import GoogleSheetsWorkbookSource, resolve_sheet_tabs


def test_b2b_news_resolve_sheet_tabs_from_sheet_url(monkeypatch) -> None:
    monkeypatch.setattr("app.b2b_news_service.settings.b2b_news_spreadsheet_id", "")
    monkeypatch.setattr(
        "app.b2b_news_service.settings.b2b_news_sheet_url",
        "https://docs.google.com/spreadsheets/d/news-sheet-id/export?format=csv&gid=42",
    )
    monkeypatch.setattr("app.b2b_news_service.settings.b2b_news_sheets", "")
    monkeypatch.setattr(
        "app.google_sheets_workbook.discover_sheet_tabs",
        lambda *_args, **_kwargs: [],
    )

    class EmptyClient:
        pass

    source = GoogleSheetsWorkbookSource(
        spreadsheet_id="",
        sheet_url="https://docs.google.com/spreadsheets/d/news-sheet-id/export?format=csv&gid=42",
        sheets_config="",
        sheet_public_url="",
        title="Новости и запуски",
        fallback_sheet_name="Новости и запуски",
        spreadsheet_id_missing_detail="not configured",
    )
    sheets = resolve_sheet_tabs(source, client=EmptyClient())  # type: ignore[arg-type]
    assert sheets == [{"gid": "42", "name": "Новости и запуски"}]


def test_load_b2b_news_uses_settings(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.b2b_news_service.settings.b2b_news_spreadsheet_id",
        "news-spreadsheet",
    )
    monkeypatch.setattr("app.b2b_news_service.settings.b2b_news_sheet_public_url", "https://example.com/news")
    captured: dict[str, object] = {}

    def fake_load(source, **kwargs):
        captured["title"] = source.title
        captured["spreadsheet_id"] = source.spreadsheet_id
        captured["public_url"] = source.sheet_public_url
        captured["kwargs"] = kwargs
        from app.schemas import ProductStatusB2BOut

        return ProductStatusB2BOut(title=source.title, sourceUrl=source.sheet_public_url, sheets=[])

    monkeypatch.setattr("app.b2b_news_service.load_google_sheets_workbook", fake_load)

    payload = load_b2b_news()
    assert payload.title == "Новости и запуски"
    assert captured["spreadsheet_id"] == "news-spreadsheet"
    assert captured["public_url"] == "https://example.com/news"
    assert captured["kwargs"] == {"gid": None, "meta_only": False, "use_cache": True}
