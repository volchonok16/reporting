from __future__ import annotations

import logging
import re

import httpx

logger = logging.getLogger(__name__)

_PRESENTATION_ID_PATTERN = re.compile(r"/presentation/d/([a-zA-Z0-9_-]+)")


def google_slides_presentation_id(reference_url: str) -> str | None:
    match = _PRESENTATION_ID_PATTERN.search(reference_url.strip())
    return match.group(1) if match else None


def google_slides_pptx_export_url(presentation_id: str) -> str:
    return f"https://docs.google.com/presentation/d/{presentation_id}/export/pptx"


def fetch_google_slides_pptx(*, reference_url: str, client: httpx.Client) -> bytes:
    presentation_id = google_slides_presentation_id(reference_url)
    if not presentation_id:
        raise ValueError(f"Некорректная ссылка на Google Slides: {reference_url}")

    response = client.get(google_slides_pptx_export_url(presentation_id))
    response.raise_for_status()
    content = response.content
    if len(content) < 1024:
        raise ValueError("Экспорт Google Slides пустой или слишком маленький")
    logger.info(
        "google_slides_template_fetched id=%s bytes=%s",
        presentation_id,
        len(content),
    )
    return content
