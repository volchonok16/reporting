import csv
import io
import logging

import httpx
from fastapi import HTTPException

from app.config import settings
from app.schemas import ProductStatusB2BOut, ProductStatusRowOut

logger = logging.getLogger(__name__)

_HEADER_MAP = {
    "Дата запуска": "launchDate",
    "Проект": "project",
    "Описание проекта": "description",
    "Зачем и для чего делаем": "purpose",
}


def parse_product_status_csv(text: str) -> list[ProductStatusRowOut]:
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        return []

    rows: list[ProductStatusRowOut] = []
    for raw in reader:
        values = {
            en_key: (raw.get(ru_key) or "").strip()
            for ru_key, en_key in _HEADER_MAP.items()
        }
        if not any(values.values()):
            continue
        rows.append(ProductStatusRowOut(**values))
    return rows


def load_b2b_product_status() -> ProductStatusB2BOut:
    url = settings.b2b_product_status_sheet_url.strip()
    if not url:
        raise HTTPException(
            status_code=503,
            detail="URL таблицы статуса продукта B2B не настроен.",
        )

    try:
        with httpx.Client(timeout=30.0, follow_redirects=True) as client:
            response = client.get(url)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        logger.exception("product_status_sheet_fetch_failed")
        raise HTTPException(
            status_code=502,
            detail="Не удалось загрузить таблицу статуса продукта B2B.",
        ) from exc

    rows = parse_product_status_csv(response.text)
    return ProductStatusB2BOut(
        title="Статус продукта B2B",
        sourceUrl=settings.b2b_product_status_sheet_public_url or None,
        items=rows,
        totalShown=len(rows),
    )
