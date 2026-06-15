from __future__ import annotations

import csv
import io
import json
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Mapping
from urllib.parse import parse_qs, urlparse

import httpx
from fastapi import HTTPException

from app.config import settings
from app.product_status_sheets_api import fetch_sheet_with_formatting
from app.product_status_xlsx_source import fetch_sheet_from_xlsx
from app.schemas import ProductStatusB2BOut, ProductStatusSheetOut

logger = logging.getLogger(__name__)

_workbook_cache: dict[tuple[str, str], tuple[float, ProductStatusB2BOut]] = {}
_sheet_tabs_cache: dict[str, tuple[float, list[dict[str, str]]]] = {}
_SHEET_TABS_CACHE_TTL_SECONDS = 3600

_SHEET_META_PATTERN = re.compile(
    r'"sheetId":(\d+),"title":"((?:\\.|[^"\\])*)"',
)
_TAB_CAPTION_PATTERN = re.compile(r'docs-sheet-tab-caption">([^<]+)</div>')
_GID_PATTERN = re.compile(r"gid=(\d+)")
_VALID_GID_PATTERN = re.compile(r"^\d+$")
_API_KEY_PATTERN = re.compile(r"^AIza[0-9A-Za-z_-]{10,}$")


@dataclass(frozen=True)
class GoogleSheetsWorkbookSource:
    spreadsheet_id: str
    sheet_url: str
    sheets_config: str
    sheet_public_url: str
    title: str
    fallback_sheet_name: str
    spreadsheet_id_missing_detail: str
    default_sheets_by_spreadsheet: Mapping[str, list[dict[str, str]]] = field(
        default_factory=dict
    )


def _spreadsheet_id_from_source(source: GoogleSheetsWorkbookSource) -> str:
    configured = source.spreadsheet_id.strip()
    if configured:
        return configured
    parsed = urlparse(source.sheet_url.strip())
    match = re.search(r"/spreadsheets/d/([^/]+)", parsed.path)
    if match:
        return match.group(1)
    raise HTTPException(
        status_code=503,
        detail=source.spreadsheet_id_missing_detail,
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
        logger.warning("google_sheets_edit_fetch_failed id=%s", spreadsheet_id)

    if not gids:
        try:
            response = client.get(htmlview_url)
            response.raise_for_status()
            gids = _unique_gids(_GID_PATTERN.findall(response.text))
        except httpx.HTTPError:
            logger.warning("google_sheets_htmlview_fetch_failed id=%s", spreadsheet_id)

    paired = _pair_captions_with_gids(captions, gids)
    if paired:
        return paired

    logger.warning("google_sheets_discovery_empty id=%s", spreadsheet_id)
    return []


def _is_valid_sheet_gid(gid: str) -> bool:
    return bool(_VALID_GID_PATTERN.match(gid.strip()))


def _looks_like_url(value: str) -> bool:
    lowered = value.strip().casefold()
    return lowered.startswith("http://") or lowered.startswith("https://")


def normalize_google_sheets_api_key(raw: str) -> str:
    value = raw.strip()
    if not value:
        return ""
    if _looks_like_url(value):
        logger.warning(
            "google_sheets_api_key_looks_like_url — укажите API-ключ AIza…, "
            "а ссылку на таблицу задайте в B2B_*_SHEET_PUBLIC_URL"
        )
        return ""
    if not _API_KEY_PATTERN.match(value):
        logger.warning(
            "google_sheets_api_key_invalid_format — ожидается ключ вида AIza…; "
            "чтение стилей через Sheets API отключено"
        )
        return ""
    return value


def _sheet_tab_from_parts(gid: str, name: str) -> dict[str, str] | None:
    gid = gid.strip()
    name = name.strip()
    if not gid or not name:
        return None
    if not _is_valid_sheet_gid(gid):
        logger.warning(
            "google_sheets_invalid_sheet_gid gid=%r name=%r — gid должен быть числом",
            gid,
            name,
        )
        return None
    return {"gid": gid, "name": name}


def parse_sheets_config(raw: str) -> list[dict[str, str]]:
    value = raw.strip()
    if not value:
        return []

    if _looks_like_url(value):
        logger.warning(
            "google_sheets_sheets_looks_like_url — укажите gid:имя;gid2:имя2 "
            "или оставьте пустым для автоопределения листов"
        )
        return []

    if value.startswith("["):
        parsed = json.loads(value)
        if not isinstance(parsed, list):
            raise ValueError("B2B_*_SHEETS must be a JSON array")
        sheets: list[dict[str, str]] = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            tab = _sheet_tab_from_parts(
                str(item.get("gid", "")),
                str(item.get("name", "")),
            )
            if tab:
                sheets.append(tab)
        return sheets

    sheets = []
    for chunk in value.split(";"):
        part = chunk.strip()
        if not part or ":" not in part:
            continue
        gid, name = part.split(":", 1)
        tab = _sheet_tab_from_parts(gid, name)
        if tab:
            sheets.append(tab)
    return sheets


def resolve_sheet_tabs(
    source: GoogleSheetsWorkbookSource,
    *,
    client: httpx.Client,
) -> list[dict[str, str]]:
    configured = parse_sheets_config(source.sheets_config)
    if configured:
        return configured

    spreadsheet_id = _spreadsheet_id_from_source(source)
    cached_tabs = _sheet_tabs_cache.get(spreadsheet_id)
    if cached_tabs is not None:
        cached_at, tabs = cached_tabs
        if time.time() - cached_at <= _SHEET_TABS_CACHE_TTL_SECONDS:
            return tabs

    discovered = discover_sheet_tabs(spreadsheet_id, client=client)
    if discovered:
        _sheet_tabs_cache[spreadsheet_id] = (time.time(), discovered)
        return discovered

    default_sheets = source.default_sheets_by_spreadsheet.get(spreadsheet_id, [])
    if default_sheets:
        _sheet_tabs_cache[spreadsheet_id] = (time.time(), default_sheets)
        return default_sheets

    parsed = urlparse(source.sheet_url.strip())
    query_gid = parse_qs(parsed.query).get("gid", ["0"])[0]
    fallback = [{"gid": query_gid or "0", "name": source.fallback_sheet_name}]
    _sheet_tabs_cache[spreadsheet_id] = (time.time(), fallback)
    return fallback


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


def _google_http_client() -> httpx.Client:
    proxy = settings.outbound_http_proxy.strip() or None
    return httpx.Client(timeout=45.0, follow_redirects=True, proxy=proxy)


def invalidate_workbook_cache(spreadsheet_id: str) -> None:
    spreadsheet_id = spreadsheet_id.strip()
    if not spreadsheet_id:
        return
    for key in list(_workbook_cache):
        if key[0] == spreadsheet_id:
            del _workbook_cache[key]
    _sheet_tabs_cache.pop(spreadsheet_id, None)


def _workbook_cache_key(spreadsheet_id: str, *, gid: str | None, meta_only: bool) -> tuple[str, str]:
    if meta_only:
        return spreadsheet_id, "__meta__"
    if gid:
        return spreadsheet_id, f"gid:{gid}"
    return spreadsheet_id, "__all__"


def _workbook_from_cache(
    spreadsheet_id: str,
    *,
    gid: str | None,
    meta_only: bool,
) -> ProductStatusB2BOut | None:
    key = _workbook_cache_key(spreadsheet_id, gid=gid, meta_only=meta_only)
    cached = _workbook_cache.get(key)
    if cached is None:
        return None
    cached_at, payload = cached
    if time.time() - cached_at > settings.google_sheets_workbook_cache_ttl_seconds:
        del _workbook_cache[key]
        return None
    return payload


def _store_workbook_cache(
    spreadsheet_id: str,
    *,
    gid: str | None,
    meta_only: bool,
    payload: ProductStatusB2BOut,
) -> None:
    key = _workbook_cache_key(spreadsheet_id, gid=gid, meta_only=meta_only)
    _workbook_cache[key] = (time.time(), payload)


def _empty_sheet_tab(tab: dict[str, str]) -> ProductStatusSheetOut:
    return ProductStatusSheetOut(
        gid=tab["gid"],
        name=tab["name"],
        columns=[],
        rows=[],
        totalShown=0,
    )


def _load_sheet_tab_isolated(
    *,
    spreadsheet_id: str,
    gid: str,
    name: str,
    api_key: str,
) -> tuple[str, str, list[str], list[dict[str, str]], str | None]:
    with _google_http_client() as client:
        columns, rows, error = _load_sheet_tab(
            spreadsheet_id=spreadsheet_id,
            gid=gid,
            name=name,
            api_key=api_key,
            client=client,
        )
    return gid, name, columns, rows, error


def _load_sheet_tabs_parallel(
    *,
    spreadsheet_id: str,
    sheet_tabs: list[dict[str, str]],
    api_key: str,
) -> tuple[list[ProductStatusSheetOut], list[str]]:
    if not sheet_tabs:
        return [], []

    if len(sheet_tabs) == 1:
        tab = sheet_tabs[0]
        gid, name, columns, rows, error = _load_sheet_tab_isolated(
            spreadsheet_id=spreadsheet_id,
            gid=tab["gid"],
            name=tab["name"],
            api_key=api_key,
        )
        load_errors = [error] if error else []
        if not columns:
            return [], load_errors
        return [
            ProductStatusSheetOut(
                gid=gid,
                name=name,
                columns=columns,
                rows=rows,
                totalShown=len(rows),
            )
        ], load_errors

    loaded_by_gid: dict[str, tuple[list[str], list[dict[str, str]], str | None]] = {}
    load_errors: list[str] = []
    max_workers = min(len(sheet_tabs), 6)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(
                _load_sheet_tab_isolated,
                spreadsheet_id=spreadsheet_id,
                gid=tab["gid"],
                name=tab["name"],
                api_key=api_key,
            ): tab
            for tab in sheet_tabs
        }
        for future in as_completed(futures):
            gid, name, columns, rows, error = future.result()
            loaded_by_gid[gid] = (columns, rows, error)
            if error:
                load_errors.append(error)

    sheets: list[ProductStatusSheetOut] = []
    for tab in sheet_tabs:
        gid = tab["gid"]
        name = tab["name"]
        columns, rows, error = loaded_by_gid.get(gid, ([], [], None))
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
    return sheets, load_errors


def _load_sheet_tab(
    *,
    spreadsheet_id: str,
    gid: str,
    name: str,
    api_key: str,
    client: httpx.Client,
) -> tuple[list[str], list[dict[str, str]], str | None]:
    columns: list[str] = []
    rows: list[dict[str, str]] = []
    last_error: str | None = None

    if api_key:
        formatted = fetch_sheet_with_formatting(
            spreadsheet_id=spreadsheet_id,
            sheet_name=name,
            gid=gid,
            api_key=api_key,
            client=client,
        )
        if formatted:
            columns, rows = formatted
        else:
            last_error = f"{name}: Sheets API недоступен"

    if not columns:
        xlsx_formatted = fetch_sheet_from_xlsx(
            spreadsheet_id=spreadsheet_id,
            gid=gid,
            client=client,
        )
        if xlsx_formatted:
            columns, rows = xlsx_formatted
        elif last_error is None:
            last_error = f"{name}: XLSX-экспорт недоступен"

    if not columns:
        url = _csv_export_url(spreadsheet_id, gid)
        try:
            response = client.get(url)
            response.raise_for_status()
            columns, rows = parse_sheet_csv(response.text)
            if not columns:
                last_error = f"{name}: CSV пустой или без заголовков"
        except httpx.HTTPError as exc:
            last_error = f"{name}: CSV {exc.__class__.__name__}"
            logger.warning(
                "google_sheets_tab_fetch_failed gid=%s name=%s error=%s",
                gid,
                name,
                exc,
            )

    if columns:
        return columns, rows, None
    return [], [], last_error


def load_google_sheets_workbook(
    source: GoogleSheetsWorkbookSource,
    *,
    presentation_reference_url: str | None = None,
    gid: str | None = None,
    meta_only: bool = False,
    use_cache: bool = True,
) -> ProductStatusB2BOut:
    spreadsheet_id = _spreadsheet_id_from_source(source)

    if use_cache:
        cached = _workbook_from_cache(spreadsheet_id, gid=gid, meta_only=meta_only)
        if cached is not None:
            return cached

    try:
        with _google_http_client() as client:
            sheet_tabs = resolve_sheet_tabs(source, client=client)
            if not sheet_tabs:
                raise HTTPException(
                    status_code=502,
                    detail=(
                        "Не удалось определить листы Google Sheets. "
                        "Задайте список листов в .env."
                    ),
                )

            public_url = source.sheet_public_url.strip() or None
            if meta_only:
                payload = ProductStatusB2BOut(
                    title=source.title,
                    sourceUrl=public_url,
                    presentationReferenceUrl=presentation_reference_url,
                    sheets=[_empty_sheet_tab(tab) for tab in sheet_tabs],
                )
                if use_cache:
                    _store_workbook_cache(
                        spreadsheet_id,
                        gid=None,
                        meta_only=True,
                        payload=payload,
                    )
                return payload

            api_key = normalize_google_sheets_api_key(settings.google_sheets_api_key)
            tabs_to_load = sheet_tabs
            if gid:
                tabs_to_load = [tab for tab in sheet_tabs if tab["gid"] == gid]
                if not tabs_to_load:
                    raise HTTPException(
                        status_code=404,
                        detail=f"Лист с gid={gid} не найден.",
                    )

            loaded_sheets, load_errors = _load_sheet_tabs_parallel(
                spreadsheet_id=spreadsheet_id,
                sheet_tabs=tabs_to_load,
                api_key=api_key,
            )

            if gid:
                loaded = loaded_sheets[0] if loaded_sheets else None
                if loaded is None:
                    sample = "; ".join(load_errors[:3]) if load_errors else "нет данных"
                    raise HTTPException(
                        status_code=502,
                        detail=f"Не удалось загрузить лист gid={gid}. {sample}",
                    )
                sheets = [
                    loaded if tab["gid"] == gid else _empty_sheet_tab(tab)
                    for tab in sheet_tabs
                ]
            else:
                sheets = loaded_sheets
                if not sheets:
                    hint = (
                        "Проверьте доступ сервера к docs.google.com "
                        "(curl export?format=csv) и настройки Google Sheets в .env."
                    )
                    if load_errors:
                        sample = "; ".join(load_errors[:3])
                        raise HTTPException(
                            status_code=502,
                            detail=(
                                "Не удалось загрузить ни одного листа Google Sheets. "
                                f"Ошибки: {sample}. {hint}"
                            ),
                        )
                    raise HTTPException(
                        status_code=502,
                        detail=f"Не удалось загрузить ни одного листа Google Sheets. {hint}",
                    )

            payload = ProductStatusB2BOut(
                title=source.title,
                sourceUrl=public_url,
                presentationReferenceUrl=presentation_reference_url,
                sheets=sheets,
            )
            if use_cache:
                _store_workbook_cache(
                    spreadsheet_id,
                    gid=gid,
                    meta_only=False,
                    payload=payload,
                )
            return payload
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=500,
            detail="Некорректный формат списка листов в .env.",
        ) from exc
    except httpx.HTTPError as exc:
        logger.exception("google_sheets_workbook_fetch_failed title=%s", source.title)
        raise HTTPException(
            status_code=502,
            detail=f"Не удалось загрузить таблицу «{source.title}».",
        ) from exc
