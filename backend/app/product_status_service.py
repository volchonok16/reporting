import csv
import io
import json
import logging
import re
import time
from urllib.parse import parse_qs, urlparse

import httpx
from fastapi import HTTPException

from app.config import settings
from app.product_status_sheets_api import fetch_sheet_with_formatting
from app.schemas import ProductStatusB2BOut, ProductStatusSheetOut

logger = logging.getLogger(__name__)

_SHEET_META_PATTERN = re.compile(
    r'"sheetId":(\d+),"title":"((?:\\.|[^"\\])*)"',
)
_TAB_CAPTION_PATTERN = re.compile(r'docs-sheet-tab-caption">([^<]+)</div>')
_GID_PATTERN = re.compile(r"gid=(\d+)")

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


def _spreadsheet_id() -> str:
    configured = settings.b2b_product_status_spreadsheet_id.strip()
    if configured:
        return configured
    parsed = urlparse(settings.b2b_product_status_sheet_url.strip())
    match = re.search(r"/spreadsheets/d/([^/]+)", parsed.path)
    if match:
        return match.group(1)
    raise HTTPException(
        status_code=503,
        detail="ID Google Sheets для статуса продукта B2B не настроен.",
    )


def _csv_export_url(spreadsheet_id: str, gid: str) -> str:
    cache_bust = int(time.time())
    return (
        "https://docs.google.com/spreadsheets/d/"
        f"{spreadsheet_id}/export?format=csv&gid={gid}&_={cache_bust}"
    )


def _unescape_google_title(value: str) -> str:
    return value.replace("\\u0026", "&").replace('\\"', '"').replace("\\\\", "\\")


def _unique_gids(values: list[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        unique.append(value)
    return unique


def _pair_captions_with_gids(
    captions: list[str],
    gids: list[str],
) -> list[dict[str, str]]:
    if captions and gids and len(captions) == len(gids):
        return [
            {"gid": gid, "name": _unescape_google_title(name)}
            for gid, name in zip(gids, captions, strict=True)
        ]

    if gids:
        return [
            {
                "gid": gid,
                "name": captions[index] if index < len(captions) else f"Лист {index + 1}",
            }
            for index, gid in enumerate(gids)
        ]

    return []


def discover_sheet_tabs(spreadsheet_id: str, *, client: httpx.Client) -> list[dict[str, str]]:
    captions: list[str] = []
    gids: list[str] = []

    edit_url = (
        "https://docs.google.com/spreadsheets/d/"
        f"{spreadsheet_id}/edit?hl=ru"
    )
    htmlview_url = (
        "https://docs.google.com/spreadsheets/d/"
        f"{spreadsheet_id}/htmlview"
    )

    try:
        response = client.get(edit_url)
        response.raise_for_status()
        captions = _TAB_CAPTION_PATTERN.findall(response.text)
        for gid, title in _SHEET_META_PATTERN.findall(response.text):
            gids.append(gid)
            if title and not captions:
                captions.append(_unescape_google_title(title))
    except httpx.HTTPError:
        logger.warning("product_status_edit_fetch_failed id=%s", spreadsheet_id)

    if not gids:
        try:
            response = client.get(htmlview_url)
            response.raise_for_status()
            gids = _unique_gids(_GID_PATTERN.findall(response.text))
        except httpx.HTTPError:
            logger.warning("product_status_htmlview_fetch_failed id=%s", spreadsheet_id)

    paired = _pair_captions_with_gids(captions, gids)
    if paired:
        return paired

    logger.warning("product_status_sheet_discovery_empty id=%s", spreadsheet_id)
    return []


def parse_sheets_config(raw: str) -> list[dict[str, str]]:
    value = raw.strip()
    if not value:
        return []

    if value.startswith("["):
        parsed = json.loads(value)
        if not isinstance(parsed, list):
            raise ValueError("B2B_PRODUCT_STATUS_SHEETS must be a JSON array")
        sheets: list[dict[str, str]] = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            gid = str(item.get("gid", "")).strip()
            name = str(item.get("name", "")).strip()
            if gid and name:
                sheets.append({"gid": gid, "name": name})
        return sheets

    sheets = []
    for chunk in value.split(";"):
        part = chunk.strip()
        if not part or ":" not in part:
            continue
        gid, name = part.split(":", 1)
        gid = gid.strip()
        name = name.strip()
        if gid and name:
            sheets.append({"gid": gid, "name": name})
    return sheets


def resolve_sheet_tabs(*, client: httpx.Client) -> list[dict[str, str]]:
    configured = parse_sheets_config(settings.b2b_product_status_sheets)
    if configured:
        return configured

    spreadsheet_id = _spreadsheet_id()
    discovered = discover_sheet_tabs(spreadsheet_id, client=client)
    if discovered:
        return discovered

    default_sheets = _DEFAULT_SHEETS_BY_SPREADSHEET.get(spreadsheet_id, [])
    if default_sheets:
        return default_sheets

    parsed = urlparse(settings.b2b_product_status_sheet_url.strip())
    query_gid = parse_qs(parsed.query).get("gid", ["0"])[0]
    return [{"gid": query_gid or "0", "name": "Статус продукта B2B"}]


def parse_sheet_csv(text: str) -> tuple[list[str], list[dict[str, str]]]:
    reader = csv.reader(io.StringIO(text))
    raw_rows = list(reader)
    if not raw_rows:
        return [], []

    headers = [header.strip() for header in raw_rows[0]]
    if not any(headers):
        return [], []

    rows: list[dict[str, str]] = []
    for raw in raw_rows[1:]:
        padded = raw + [""] * max(0, len(headers) - len(raw))
        values = {
            headers[index]: (padded[index] if index < len(padded) else "").strip()
            for index in range(len(headers))
        }
        if not any(cell for cell in values.values()):
            continue
        rows.append(values)
    return headers, rows


def load_b2b_product_status() -> ProductStatusB2BOut:
    spreadsheet_id = _spreadsheet_id()

    try:
        with httpx.Client(timeout=30.0, follow_redirects=True) as client:
            sheet_tabs = resolve_sheet_tabs(client=client)
            sheets: list[ProductStatusSheetOut] = []

            api_key = settings.google_sheets_api_key.strip()

            for tab in sheet_tabs:
                gid = tab["gid"]
                name = tab["name"]
                columns: list[str] = []
                rows: list[dict[str, str]] = []

                if api_key:
                    formatted = fetch_sheet_with_formatting(
                        spreadsheet_id=spreadsheet_id,
                        sheet_name=name,
                        api_key=api_key,
                        client=client,
                    )
                    if formatted:
                        columns, rows = formatted

                if not columns:
                    url = _csv_export_url(spreadsheet_id, gid)
                    try:
                        response = client.get(url)
                        response.raise_for_status()
                    except httpx.HTTPError:
                        logger.warning(
                            "product_status_sheet_fetch_failed gid=%s name=%s",
                            gid,
                            name,
                        )
                        continue
                    columns, rows = parse_sheet_csv(response.text)

                if not columns:
                    continue

                sheets.append(
                    ProductStatusSheetOut(
                        gid=gid,
                        name=name,
                        columns=columns,
                        rows=rows,
                        totalShown=len(rows),
                    )
                )
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=500,
            detail="Некорректный формат B2B_PRODUCT_STATUS_SHEETS.",
        ) from exc
    except httpx.HTTPError as exc:
        logger.exception("product_status_workbook_fetch_failed")
        raise HTTPException(
            status_code=502,
            detail="Не удалось загрузить таблицу статуса продукта B2B.",
        ) from exc

    if not sheets:
        raise HTTPException(
            status_code=502,
            detail="Не удалось загрузить ни одного листа Google Sheets.",
        )

    return ProductStatusB2BOut(
        title="Статус продукта B2B",
        sourceUrl=settings.b2b_product_status_sheet_public_url or None,
        presentationReferenceUrl=settings.b2b_product_status_presentation_reference_url or None,
        sheets=sheets,
    )
