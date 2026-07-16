from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from app.schemas import ProductStatusSaveIn

if TYPE_CHECKING:
    from fastapi import WebSocket

logger = logging.getLogger(__name__)

WORKBOOK_B2B = "b2b"
WORKBOOK_B2B_NEWS = "b2b-news"
WORKBOOK_REVENUE_ACTIVITIES = "revenue-activities"

ALLOWED_WORKBOOKS = frozenset(
    {
        WORKBOOK_B2B,
        WORKBOOK_B2B_NEWS,
        WORKBOOK_REVENUE_ACTIVITIES,
    }
)

_main_loop: asyncio.AbstractEventLoop | None = None


def set_main_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _main_loop
    _main_loop = loop


def gids_from_save_payload(payload: ProductStatusSaveIn) -> list[str]:
    gids: set[str] = set()
    for update in payload.updates:
        gids.add(update.gid)
    for item in payload.deletedRows:
        gids.add(item.gid)
    for item in payload.rowOrder:
        gids.add(item.gid)
    return sorted(gids)


class ProductStatusLiveBroker:
    def __init__(self) -> None:
        self._subscribers: dict[str, set[WebSocket]] = {}
        self._connection_ids: dict[WebSocket, str] = {}

    def subscribe(self, workbook: str, websocket: WebSocket) -> None:
        self._subscribers.setdefault(workbook, set()).add(websocket)

    def unsubscribe(self, workbook: str, websocket: WebSocket) -> None:
        subscribers = self._subscribers.get(workbook)
        if subscribers is None:
            return
        subscribers.discard(websocket)
        if not subscribers:
            self._subscribers.pop(workbook, None)
        self._connection_ids.pop(websocket, None)

    def register_connection_id(self, websocket: WebSocket, connection_id: str) -> None:
        if connection_id.strip():
            self._connection_ids[websocket] = connection_id.strip()

    def schedule_saved(
        self,
        *,
        workbook: str,
        gids: list[str],
        changed_by: str | None,
        origin_connection_id: str | None = None,
    ) -> None:
        if workbook not in ALLOWED_WORKBOOKS:
            return
        unique_gids = sorted({gid for gid in gids if gid})
        if not unique_gids:
            return
        if _main_loop is None or _main_loop.is_closed():
            logger.debug("product_status_live_skip_no_event_loop workbook=%s", workbook)
            return
        asyncio.run_coroutine_threadsafe(
            self._broadcast_saved(
                workbook=workbook,
                gids=unique_gids,
                changed_by=changed_by,
                origin_connection_id=origin_connection_id,
            ),
            _main_loop,
        )

    async def _broadcast_saved(
        self,
        *,
        workbook: str,
        gids: list[str],
        changed_by: str | None,
        origin_connection_id: str | None,
    ) -> None:
        subscribers = list(self._subscribers.get(workbook, set()))
        if not subscribers:
            return
        payload: dict[str, Any] = {
            "type": "saved",
            "workbook": workbook,
            "gids": gids,
            "changedBy": changed_by,
            "at": datetime.now(UTC).isoformat(),
        }
        if origin_connection_id:
            payload["originConnectionId"] = origin_connection_id
        message = json.dumps(payload, ensure_ascii=False)
        dead: list[WebSocket] = []
        for websocket in subscribers:
            connection_id = self._connection_ids.get(websocket)
            if origin_connection_id and connection_id == origin_connection_id:
                continue
            try:
                await websocket.send_text(message)
            except Exception:
                dead.append(websocket)
        for websocket in dead:
            for workbook_key in list(self._subscribers):
                self.unsubscribe(workbook_key, websocket)


product_status_live_broker = ProductStatusLiveBroker()


def notify_product_status_saved(
    *,
    workbook: str,
    gids: list[str],
    changed_by: str | None,
    origin_connection_id: str | None = None,
) -> None:
    product_status_live_broker.schedule_saved(
        workbook=workbook,
        gids=gids,
        changed_by=changed_by,
        origin_connection_id=origin_connection_id,
    )
