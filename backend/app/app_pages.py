from __future__ import annotations

from typing import TypedDict


class AppPageDef(TypedDict):
    page_key: str
    label: str
    sort_order: int


# Единый реестр вкладок WorkbookApp (frontend/src/WorkbookApp.tsx, uiState.ts).
APP_PAGES: list[AppPageDef] = [
    {"page_key": "zni", "label": "ЗНИ", "sort_order": 10},
    {"page_key": "product-status-b2b", "label": "Статус продукта B2B", "sort_order": 20},
    {"page_key": "revenue-activities", "label": "Активности по выручкам", "sort_order": 30},
    {"page_key": "roadmap", "label": "Планы Digital", "sort_order": 40},
    {"page_key": "youjail-board", "label": "Доска", "sort_order": 50},
    {"page_key": "departments", "label": "Staffing", "sort_order": 60},
    {"page_key": "diagrams", "label": "Диаграммы", "sort_order": 70},
    {"page_key": "planning", "label": "Планирование", "sort_order": 80},
    {"page_key": "voice", "label": "Voice", "sort_order": 90},
]

APP_PAGE_KEYS: frozenset[str] = frozenset(page["page_key"] for page in APP_PAGES)
