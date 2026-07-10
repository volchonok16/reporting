from __future__ import annotations

import logging
import re
import time

import httpx

from app.product_status_rich_text import cell_text_with_highlights

logger = logging.getLogger(__name__)

_SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
_A1_ESCAPE = re.compile(r"['\\]")
_GENERIC_SHEET_NAME = re.compile(r"^Лист \d+$", re.IGNORECASE)
_SHEET_TITLES_CACHE_TTL_SECONDS = 3600
_spreadsheet_sheet_titles_cache: dict[str, tuple[float, dict[str, str]]] = {}
_GRID_DATA_FIELDS = (
    "sheets(data/rowData/values("
    "formattedValue,effectiveValue,userEnteredValue,"
    "userEnteredFormat.backgroundColor,userEnteredFormat.borders,"
    "userEnteredFormat.textFormat,"
    "effectiveFormat.backgroundColor,effectiveFormat.borders,"
    "effectiveFormat.textFormat,"
    "textFormatRuns(format.foregroundColor,format.backgroundColor,format.bold,"
    "format.italic,format.strikethrough,format.underline)"
    "))"
)


def _quote_sheet_range(sheet_name: str) -> str:
    escaped = _A1_ESCAPE.sub(lambda match: f"\\{match.group(0)}", sheet_name)
    return f"'{escaped}'"


def _sheet_titles_for_fetch(
    *,
    spreadsheet_id: str,
    sheet_name: str,
    gid: str,
    api_key: str,
    client: httpx.Client,
) -> list[str]:
    """Точное имя листа из metadata (gid) — приоритет над подписью в .env."""
    titles: list[str] = []
    resolved = _resolve_sheet_title(
        spreadsheet_id=spreadsheet_id,
        gid=gid,
        api_key=api_key,
        client=client,
    )
    if resolved:
        titles.append(resolved)

    configured = sheet_name.strip()
    if configured and not _GENERIC_SHEET_NAME.match(configured) and configured not in titles:
        titles.append(configured)

    if not titles and configured:
        titles.append(configured)
    return titles


def _fetch_grid_sheet(
    *,
    spreadsheet_id: str,
    sheet_title: str,
    api_key: str,
    client: httpx.Client,
) -> tuple[list[str], list[dict[str, str]]] | None:
    sheet_range = f"{_quote_sheet_range(sheet_title)}!A1:Z500"
    params = {
        "includeGridData": "true",
        "ranges": sheet_range,
        "fields": _GRID_DATA_FIELDS,
        "key": api_key,
    }
    response = client.get(f"{_SHEETS_API}/{spreadsheet_id}", params=params)
    response.raise_for_status()

    payload = response.json()
    for sheet in payload.get("sheets", []):
        data_blocks = sheet.get("data") or []
        if not data_blocks:
            continue
        row_data = data_blocks[0].get("rowData") or []
        return _parse_grid_sheet(sheet_name=sheet_title, row_data=row_data)
    return None


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


def _fetch_sheet_titles_by_gid(
    *,
    spreadsheet_id: str,
    api_key: str,
    client: httpx.Client,
) -> dict[str, str]:
    cached = _spreadsheet_sheet_titles_cache.get(spreadsheet_id)
    if cached is not None:
        cached_at, mapping = cached
        if time.time() - cached_at <= _SHEET_TITLES_CACHE_TTL_SECONDS:
            return mapping

    params = {
        "fields": "sheets(properties(sheetId,title))",
        "key": api_key,
    }
    try:
        response = client.get(f"{_SHEETS_API}/{spreadsheet_id}", params=params)
        response.raise_for_status()
    except httpx.HTTPError:
        logger.warning(
            "product_status_sheets_metadata_fetch_failed spreadsheet_id=%s",
            spreadsheet_id,
            exc_info=True,
        )
        return {}

    mapping: dict[str, str] = {}
    for sheet in response.json().get("sheets", []):
        props = sheet.get("properties") or {}
        gid = str(props.get("sheetId", "")).strip()
        title = str(props.get("title", "")).strip()
        if gid and title:
            mapping[gid] = title

    if mapping:
        _spreadsheet_sheet_titles_cache[spreadsheet_id] = (time.time(), mapping)
    return mapping


def _resolve_sheet_title(
    *,
    spreadsheet_id: str,
    gid: str,
    api_key: str,
    client: httpx.Client,
) -> str | None:
    mapping = _fetch_sheet_titles_by_gid(
        spreadsheet_id=spreadsheet_id,
        api_key=api_key,
        client=client,
    )
    return mapping.get(str(gid))


def fetch_sheet_with_formatting(
    *,
    spreadsheet_id: str,
    sheet_name: str,
    gid: str,
    api_key: str,
    client: httpx.Client,
) -> tuple[list[str], list[dict[str, str]]] | None:
    titles = _sheet_titles_for_fetch(
        spreadsheet_id=spreadsheet_id,
        sheet_name=sheet_name,
        gid=gid,
        api_key=api_key,
        client=client,
    )
    last_error: httpx.HTTPError | None = None
    for sheet_title in titles:
        try:
            parsed = _fetch_grid_sheet(
                spreadsheet_id=spreadsheet_id,
                sheet_title=sheet_title,
                api_key=api_key,
                client=client,
            )
            if parsed is not None:
                return parsed
        except httpx.HTTPError as exc:
            last_error = exc
            logger.info(
                "product_status_sheets_api_fetch_retry sheet=%s tried_title=%r",
                sheet_name,
                sheet_title,
            )

    if last_error is not None:
        logger.warning(
            "product_status_sheets_api_fetch_failed sheet=%s titles=%s",
            sheet_name,
            titles,
            exc_info=last_error,
        )
    return None
