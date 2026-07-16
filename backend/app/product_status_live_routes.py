from __future__ import annotations

import json
import logging

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect

from app.app_access import is_roadmap_role
from app.auth_sessions import get_session_with_meta
from app.product_status_live import ALLOWED_WORKBOOKS, product_status_live_broker

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/product-status/live", tags=["product-status-live"])


def _require_live_session(session_id: str | None) -> dict[str, str | None]:
    auth, meta = get_session_with_meta(session_id)
    if auth is None:
        raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")
    if is_roadmap_role(meta.get("app_role")):
        raise HTTPException(status_code=403, detail="Недостаточно прав.")
    return meta


@router.websocket("/ws")
async def product_status_live_ws(
    websocket: WebSocket,
    workbook: str = Query(...),
    x_session_id: str | None = Query(default=None, alias="X-Session-Id"),
) -> None:
    if workbook not in ALLOWED_WORKBOOKS:
        await websocket.close(code=4400)
        return
    try:
        _require_live_session(x_session_id)
    except HTTPException:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    product_status_live_broker.subscribe(workbook, websocket)
    try:
        await websocket.send_json({"type": "ready", "workbook": workbook})
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            text = message.get("text")
            if not text:
                continue
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            message_type = payload.get("type")
            if message_type == "register":
                connection_id = payload.get("connectionId")
                if isinstance(connection_id, str):
                    product_status_live_broker.register_connection_id(websocket, connection_id)
                await websocket.send_json({"type": "registered"})
                continue
            if message_type == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.debug("product_status_live_ws_failed workbook=%s", workbook, exc_info=True)
    finally:
        product_status_live_broker.unsubscribe(workbook, websocket)
