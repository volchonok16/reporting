from app.config import settings
from app.google_sheets_workbook import (
    GoogleSheetsWorkbookSource,
    discover_sheet_tabs,
    load_google_sheets_workbook,
    normalize_google_sheets_api_key,
    parse_sheet_csv,
    parse_sheets_config,
    resolve_sheet_tabs,
    _pair_captions_with_gids,
)
from app.schemas import ProductStatusB2BOut

_DEFAULT_SHEETS_BY_SPREADSHEET: dict[str, list[dict[str, str]]] = {
    "1zTxzUqa1p6wFUjmk-8_2czfsJaSm3eTrNGazN0oFKqI": [
        {"gid": "0", "name": "Продуктовый офис: CORE"},
        {"gid": "102191664", "name": "Продуктовый офис: M2M / IoT"},
        {"gid": "1512199647", "name": "Продуктовый офис: SMS"},
        {"gid": "1699821818", "name": "Продуктовый офис: VOICE"},
        {"gid": "1909385714", "name": "Продуктовый офис: Перспективные продукты"},
        {"gid": "128901598", "name": "Продуктовый офис: Продуктовый маркетинг"},
    ],
}


def _product_status_source() -> GoogleSheetsWorkbookSource:
    return GoogleSheetsWorkbookSource(
        spreadsheet_id=settings.b2b_product_status_spreadsheet_id,
        sheet_url=settings.b2b_product_status_sheet_url,
        sheets_config=settings.b2b_product_status_sheets,
        sheet_public_url=settings.b2b_product_status_sheet_public_url,
        title="Статус продукта B2B",
        fallback_sheet_name="Статус продукта B2B",
        spreadsheet_id_missing_detail=(
            "ID Google Sheets для статуса продукта B2B не настроен."
        ),
        default_sheets_by_spreadsheet=_DEFAULT_SHEETS_BY_SPREADSHEET,
    )


def load_b2b_product_status() -> ProductStatusB2BOut:
    return load_google_sheets_workbook(
        _product_status_source(),
        presentation_reference_url=(
            settings.b2b_product_status_presentation_reference_url or None
        ),
    )


def resolve_product_status_sheet_tabs(*, client) -> list[dict[str, str]]:
    return resolve_sheet_tabs(_product_status_source(), client=client)
