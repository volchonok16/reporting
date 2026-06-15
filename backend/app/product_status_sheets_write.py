from __future__ import annotations

import json
import logging
from pathlib import Path

import httpx
from fastapi import HTTPException

from app.config import settings
from app.product_status_google_encode import sheet_grid_to_google_rows
from app.product_status_sheets_api import _resolve_sheet_title
from app.google_sheets_workbook import normalize_google_sheets_api_key
from app.schemas import ProductStatusB2BOut, ProductStatusSheetOut

logger = logging.getLogger(__name__)

_SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
_SCOPES = ("https://www.googleapis.com/auth/spreadsheets",)


def _service_account_json_candidates(raw: str) -> list[Path]:
    value = raw.strip()
    repo_root = Path(__file__).resolve().parents[2]
    candidates: list[Path] = []
    if value and not value.startswith("{"):
        candidates.append(Path(value))
    candidates.extend(
        [
            Path("/app/secrets/google-sheets-sa.json"),
            repo_root / "secrets" / "google-sheets-sa.json",
        ]
    )
    unique: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        key = str(path)
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique


def _load_service_account_info(raw: str) -> tuple[dict | None, str | None]:
    value = raw.strip()
    if value.startswith("{"):
        parsed = json.loads(value)
        return (parsed, None) if isinstance(parsed, dict) else (None, "некорректный JSON в переменной")
    for path in _service_account_json_candidates(value):
        if path.is_file():
            parsed = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(parsed, dict):
                return parsed, None
            return None, f"файл {path} не содержит JSON-объект"
    if value:
        return None, f"файл не найден: {value}"
    return None, "переменная GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON не задана"


def _google_sheets_error_message(response: httpx.Response) -> str | None:
    try:
        payload = response.json()
        error = payload.get("error") or {}
        message = error.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()
    except (json.JSONDecodeError, AttributeError):
        pass
    text = response.text.strip()
    return text[:300] if text else None


def _access_token() -> str:
    info, config_error = _load_service_account_info(settings.google_sheets_service_account_json)
    if not info:
        raise HTTPException(
            status_code=503,
            detail=(
                "Запись в Google Sheets не настроена: "
                f"{config_error or 'укажите GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON'}. "
                "Положите ключ в secrets/google-sheets-sa.json (Docker: /app/secrets/…). "
                "Сервисному аккаунту нужен доступ «Редактор» к таблице."
            ),
        )
    try:
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Для записи в Google Sheets установите пакеты google-auth и requests "
                "(pip install -r backend/requirements.txt или пересборка Docker-образа backend)."
            ),
        ) from exc

    credentials = service_account.Credentials.from_service_account_info(info, scopes=_SCOPES)
    credentials.refresh(Request())
    token = credentials.token
    if not token:
        raise HTTPException(status_code=503, detail="Не удалось получить токен Google Sheets.")
    return token


def _sheet_write_requests(
    *,
    sheet: ProductStatusSheetOut,
    spreadsheet_id: str,
    api_key: str,
    client: httpx.Client,
) -> list[dict]:
    gid = int(sheet.gid)
    columns = sheet.columns
    row_count = len(sheet.rows) + 1
    col_count = max(len(columns), 1)

    resolved_title = _resolve_sheet_title(
        spreadsheet_id=spreadsheet_id,
        gid=sheet.gid,
        api_key=api_key,
        client=client,
    )
    if not resolved_title and not sheet.name:
        raise HTTPException(
            status_code=502,
            detail=f"Не удалось определить лист для gid={sheet.gid}.",
        )

    grid_rows = sheet_grid_to_google_rows(columns, sheet.rows)
    return [
        {
            "updateCells": {
                "range": {
                    "sheetId": gid,
                    "startRowIndex": 0,
                    "endRowIndex": row_count,
                    "startColumnIndex": 0,
                    "endColumnIndex": col_count,
                },
                "rows": grid_rows,
                "fields": "userEnteredValue,userEnteredFormat,textFormatRuns",
            }
        }
    ]


def save_workbook_to_google(*, spreadsheet_id: str, data: ProductStatusB2BOut) -> None:
    spreadsheet_id = spreadsheet_id.strip()
    if not spreadsheet_id:
        raise HTTPException(
            status_code=503,
            detail="ID Google Sheets не настроен.",
        )

    api_key = normalize_google_sheets_api_key(settings.google_sheets_api_key)
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail=(
                "GOOGLE_SHEETS_API_KEY нужен для определения листов при записи "
                "(ключ вида AIza…, не ссылка на таблицу)."
            ),
        )

    token = _access_token()
    requests: list[dict] = []

    with httpx.Client(timeout=60.0) as client:
        for sheet in data.sheets:
            if not sheet.columns:
                continue
            requests.extend(
                _sheet_write_requests(
                    sheet=sheet,
                    spreadsheet_id=spreadsheet_id,
                    api_key=api_key,
                    client=client,
                )
            )

        if not requests:
            raise HTTPException(status_code=400, detail="Нет данных для сохранения.")

        response = client.post(
            f"{_SHEETS_API}/{spreadsheet_id}:batchUpdate",
            headers={"Authorization": f"Bearer {token}"},
            json={"requests": requests},
        )
        if response.status_code >= 400:
            logger.warning(
                "product_status_sheets_save_failed status=%s body=%s",
                response.status_code,
                response.text[:500],
            )
            google_error = _google_sheets_error_message(response)
            detail = "Google Sheets отклонил сохранение."
            if google_error:
                detail = f"{detail} {google_error}"
            else:
                detail = f"{detail} Проверьте доступ сервисного аккаунта."
            raise HTTPException(
                status_code=502,
                detail=detail,
            )


def save_b2b_product_status_to_google(data: ProductStatusB2BOut) -> None:
    save_workbook_to_google(
        spreadsheet_id=settings.b2b_product_status_spreadsheet_id,
        data=data,
    )


def save_b2b_news_to_google(data: ProductStatusB2BOut) -> None:
    save_workbook_to_google(
        spreadsheet_id=settings.b2b_news_spreadsheet_id,
        data=data,
    )
