from __future__ import annotations

import logging
import re

import httpx

from app.product_status_rich_text import cell_text_with_highlights

logger = logging.getLogger(__name__)

_SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
_A1_ESCAPE = re.compile(r"['\\]")


def _quote_sheet_range(sheet_name: str) -> str:
    escaped = _A1_ESCAPE.sub(lambda match: f"\\{match.group(0)}", sheet_name)
    return f"'{escaped}'"


def _cell_plain_text(cell: dict) -> str:
    effective = cell.get("effectiveValue") or cell.get("userEnteredValue") or {}
    if "stringValue" in effective:
        return str(effective["stringValue"]).strip()
    if "numberValue" in effective:
        number = effective["numberValue"]
        return str(int(number)) if float(number).is_integer() else str(number)
    if "boolValue" in effective:
        return "TRUE" if effective["boolValue"] else "FALSE"
    return str(cell.get("formattedValue") or "").strip()


def _parse_grid_sheet(
    *,
    sheet_name: str,
    row_data: list[dict],
) -> tuple[list[str], list[dict[str, str]]]:
    if not row_data:
        return [], []

    header_cells = (row_data[0].get("values") or []) if row_data else []
    headers = [_cell_plain_text(cell) for cell in header_cells]
    headers = [header for header in headers if header]
    if not headers:
        return [], []

    rows: list[dict[str, str]] = []
    for raw_row in row_data[1:]:
        values = raw_row.get("values") or []
        if not values:
            continue
        row_values: dict[str, str] = {}
        has_content = False
        for index, header in enumerate(headers):
            cell = values[index] if index < len(values) else {}
            value = cell_text_with_highlights(cell) if cell else ""
            row_values[header] = value.strip()
            if value.strip():
                has_content = True
        if has_content:
            rows.append(row_values)
    return headers, rows


def fetch_sheet_with_formatting(
    *,
    spreadsheet_id: str,
    sheet_name: str,
    api_key: str,
    client: httpx.Client,
) -> tuple[list[str], list[dict[str, str]]] | None:
    sheet_range = f"{_quote_sheet_range(sheet_name)}!A1:Z500"
    params = {
        "includeGridData": "true",
        "ranges": sheet_range,
        "fields": (
            "sheets(data/rowData/values("
            "formattedValue,effectiveValue,userEnteredValue,"
            "userEnteredFormat.backgroundColor,effectiveFormat.backgroundColor,"
            "textFormatRuns(format.backgroundColor)"
            "))"
        ),
        "key": api_key,
    }
    try:
        response = client.get(f"{_SHEETS_API}/{spreadsheet_id}", params=params)
        response.raise_for_status()
    except httpx.HTTPError:
        logger.warning(
            "product_status_sheets_api_fetch_failed sheet=%s",
            sheet_name,
            exc_info=True,
        )
        return None

    payload = response.json()
    for sheet in payload.get("sheets", []):
        data_blocks = sheet.get("data") or []
        if not data_blocks:
            continue
        row_data = data_blocks[0].get("rowData") or []
        return _parse_grid_sheet(sheet_name=sheet_name, row_data=row_data)

    return None
