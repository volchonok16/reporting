from app.config import settings
from app.google_sheets_workbook import GoogleSheetsWorkbookSource, load_google_sheets_workbook
from app.schemas import ProductStatusB2BOut


def _b2b_news_source() -> GoogleSheetsWorkbookSource:
    return GoogleSheetsWorkbookSource(
        spreadsheet_id=settings.b2b_news_spreadsheet_id,
        sheet_url=settings.b2b_news_sheet_url,
        sheets_config=settings.b2b_news_sheets,
        sheet_public_url=settings.b2b_news_sheet_public_url,
        title="Новости и запуски",
        fallback_sheet_name="Новости и запуски",
        spreadsheet_id_missing_detail="ID Google Sheets для раздела «Новости и запуски» не настроен.",
    )


def load_b2b_news(
    *,
    gid: str | None = None,
    meta_only: bool = False,
    use_cache: bool = True,
) -> ProductStatusB2BOut:
    return load_google_sheets_workbook(
        _b2b_news_source(),
        gid=gid,
        meta_only=meta_only,
        use_cache=use_cache,
    )
