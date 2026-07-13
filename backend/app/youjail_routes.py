from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.auth_sessions import get_session_with_meta
from app.db import get_db
from app.youjail_schemas import (
    YouJailAttachmentOut,
    YouJailBoardIn,
    YouJailBoardMetaOut,
    YouJailBoardOut,
    YouJailBoardTeamsIn,
    YouJailCardIn,
    YouJailCardMoveIn,
    YouJailCardOut,
    YouJailCardUpdateIn,
    YouJailColumnIn,
    YouJailColumnOut,
    YouJailColumnUpdateIn,
    YouJailExecuteIn,
    YouJailExecutionOut,
    YouJailProjectIn,
    YouJailProjectOut,
    YouJailProjectUpdateIn,
    YouJailTaskTypeIn,
    YouJailTaskTypeOut,
    YouJailTeamIn,
    YouJailTeamMemberIn,
    YouJailTeamOut,
    YouJailTeamUpdateIn,
)
from app.youjail_service import (
    add_team_member,
    create_board,
    create_card,
    create_column,
    create_project,
    create_task_type,
    create_team,
    delete_attachment,
    delete_board,
    delete_card,
    delete_team,
    get_card,
    get_execution,
    list_boards,
    list_card_executions,
    list_projects,
    list_task_types,
    list_teams,
    load_attachment_file,
    load_board,
    move_card,
    remove_team_member,
    save_attachment,
    set_board_teams,
    set_card_flag,
    start_execution,
    update_card,
    update_column,
    update_project,
    update_team,
)
from app.youjail_terminal import (
    resize_execution_terminal,
    terminal_broker,
    write_execution_input,
)

router = APIRouter(prefix="/api/youjail", tags=["youjail"])


def _require_session_meta(x_session_id: str | None) -> dict:
    auth, meta = get_session_with_meta(x_session_id)
    if auth is None:
        raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")
    return meta


def _load_session_meta(x_session_id: str | None = Header(default=None, alias="X-Session-Id")) -> dict:
    return _require_session_meta(x_session_id)


@router.get("/teams", response_model=list[YouJailTeamOut])
def api_list_teams(
    detailed: bool = Query(default=False),
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> list[dict]:
    return list_teams(db, meta=meta, detailed=detailed)


@router.post("/teams", response_model=YouJailTeamOut)
def api_create_team(
    payload: YouJailTeamIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return create_team(db, payload.model_dump(), meta=meta)


@router.patch("/teams/{team_id}", response_model=YouJailTeamOut)
def api_update_team(
    team_id: int,
    payload: YouJailTeamUpdateIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return update_team(db, team_id, payload.model_dump(exclude_unset=True), meta=meta)


@router.delete("/teams/{team_id}")
def api_delete_team(
    team_id: int,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict[str, bool]:
    delete_team(db, team_id, meta=meta)
    return {"ok": True}


@router.post("/teams/{team_id}/members", response_model=YouJailTeamOut)
def api_add_team_member(
    team_id: int,
    payload: YouJailTeamMemberIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return add_team_member(db, team_id, payload.model_dump(), meta=meta)


@router.delete("/teams/{team_id}/members/{employee_id}", response_model=YouJailTeamOut)
def api_remove_team_member(
    team_id: int,
    employee_id: int,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return remove_team_member(db, team_id, employee_id, meta=meta)


@router.get("/boards", response_model=list[YouJailBoardMetaOut])
def api_list_boards(
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> list[dict]:
    return list_boards(db, meta=meta)


@router.post("/boards", response_model=YouJailBoardMetaOut)
def api_create_board(
    payload: YouJailBoardIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return create_board(db, payload.model_dump(), meta=meta)


@router.delete("/boards/{board_id}")
def api_delete_board(
    board_id: int,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict[str, bool]:
    delete_board(db, board_id, meta=meta)
    return {"ok": True}


@router.put("/boards/{board_id}/teams", response_model=YouJailBoardMetaOut)
def api_set_board_teams(
    board_id: int,
    payload: YouJailBoardTeamsIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return set_board_teams(db, board_id, payload.teamIds, meta=meta)


@router.post("/boards/{board_id}/columns", response_model=YouJailColumnOut)
def api_create_column(
    board_id: int,
    payload: YouJailColumnIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return create_column(db, board_id, payload.model_dump(), meta=meta)


@router.patch("/columns/{column_id}", response_model=YouJailColumnOut)
def api_update_column(
    column_id: int,
    payload: YouJailColumnUpdateIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return update_column(db, column_id, payload.model_dump(exclude_unset=True), meta=meta)


@router.get("/board", response_model=YouJailBoardOut)
def api_load_board(
    board_id: int | None = Query(default=None, alias="boardId"),
    search: str | None = Query(default=None),
    archived: str = Query(default="false", pattern="^(false|true|all)$"),
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return load_board(db, meta=meta, board_id=board_id, search=search, archived=archived)


@router.get("/cards/{card_id}", response_model=YouJailCardOut)
def api_get_card(
    card_id: int,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return get_card(db, card_id, meta=meta)


@router.post("/cards", response_model=YouJailCardOut)
def api_create_card(
    payload: YouJailCardIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    created_by = meta.get("account_label") or meta.get("login")
    return create_card(db, payload.model_dump(), created_by=created_by, meta=meta)


@router.patch("/cards/{card_id}", response_model=YouJailCardOut)
def api_update_card(
    card_id: int,
    payload: YouJailCardUpdateIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return update_card(db, card_id, payload.model_dump(exclude_unset=True), meta=meta)


@router.post("/cards/{card_id}/move", response_model=YouJailCardOut)
def api_move_card(
    card_id: int,
    payload: YouJailCardMoveIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return move_card(db, card_id, column_id=payload.columnId, sort_order=payload.sortOrder, meta=meta)


@router.delete("/cards/{card_id}")
def api_delete_card(
    card_id: int,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict[str, bool]:
    delete_card(db, card_id, meta=meta)
    return {"ok": True}


@router.post("/cards/{card_id}/pin", response_model=YouJailCardOut)
def api_pin_card(
    card_id: int,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    card = get_card(db, card_id, meta=meta)
    return set_card_flag(db, card_id, meta=meta, pinned=not card["pinned"])


@router.post("/cards/{card_id}/archive", response_model=YouJailCardOut)
def api_archive_card(
    card_id: int,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    card = get_card(db, card_id, meta=meta)
    return set_card_flag(db, card_id, meta=meta, archived=not card["archived"])


@router.post("/cards/{card_id}/close", response_model=YouJailCardOut)
def api_close_card(
    card_id: int,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    from datetime import datetime, timezone

    card = get_card(db, card_id, meta=meta)
    closed_at = None if card["closedAt"] else datetime.now(timezone.utc)
    return set_card_flag(db, card_id, meta=meta, closedAt=closed_at)


@router.post("/cards/{card_id}/execute", response_model=YouJailExecutionOut)
def api_execute_card(
    card_id: int,
    payload: YouJailExecuteIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return start_execution(db, card_id, executor=payload.executor, feedback=None, meta=meta)


@router.post("/cards/{card_id}/retry", response_model=YouJailExecutionOut)
def api_retry_card(
    card_id: int,
    payload: YouJailExecuteIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return start_execution(db, card_id, executor=payload.executor, feedback=payload.retryFeedback, meta=meta)


@router.get("/cards/{card_id}/executions", response_model=list[YouJailExecutionOut])
def api_list_card_executions(
    card_id: int,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> list[dict]:
    return list_card_executions(db, card_id, meta=meta)


@router.get("/executions/{execution_id}", response_model=YouJailExecutionOut)
def api_get_execution(
    execution_id: int,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return get_execution(db, execution_id, meta=meta, with_logs=True)


@router.websocket("/executions/{execution_id}/terminal")
async def api_execution_terminal(
    websocket: WebSocket,
    execution_id: int,
    x_session_id: str | None = Query(default=None, alias="X-Session-Id"),
) -> None:
    try:
        _require_session_meta(x_session_id)
    except HTTPException:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    terminal_broker.subscribe(execution_id, websocket)
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if "bytes" in message and message["bytes"] is not None:
                write_execution_input(execution_id, message["bytes"])
            elif "text" in message and message["text"] is not None:
                payload = message["text"]
                if payload.startswith("{"):
                    import json

                    try:
                        data = json.loads(payload)
                    except json.JSONDecodeError:
                        write_execution_input(execution_id, payload.encode("utf-8"))
                        continue
                    if data.get("type") == "resize":
                        rows = int(data.get("rows") or 24)
                        cols = int(data.get("cols") or 80)
                        resize_execution_terminal(execution_id, rows, cols)
                        continue
                write_execution_input(execution_id, payload.encode("utf-8"))
    except WebSocketDisconnect:
        pass
    finally:
        terminal_broker.unsubscribe(execution_id, websocket)


@router.get("/projects", response_model=list[YouJailProjectOut])
def api_list_projects(
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[dict]:
    return list_projects(db)


@router.post("/projects", response_model=YouJailProjectOut)
def api_create_project(
    payload: YouJailProjectIn,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict:
    return create_project(db, payload.model_dump())


@router.patch("/projects/{project_id}", response_model=YouJailProjectOut)
def api_update_project(
    project_id: int,
    payload: YouJailProjectUpdateIn,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict:
    return update_project(db, project_id, payload.model_dump(exclude_unset=True))


@router.get("/task-types", response_model=list[YouJailTaskTypeOut])
def api_list_task_types(
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[dict]:
    return list_task_types(db)


@router.post("/task-types", response_model=YouJailTaskTypeOut)
def api_create_task_type(
    payload: YouJailTaskTypeIn,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict:
    return create_task_type(db, payload.model_dump())


@router.post("/cards/{card_id}/attachments", response_model=YouJailAttachmentOut)
async def api_upload_attachment(
    card_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    return await save_attachment(db, card_id, file, meta=meta)


@router.get("/attachments/{attachment_id}/download")
def api_download_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> FileResponse:
    path, filename, content_type = load_attachment_file(db, attachment_id, meta=meta)
    return FileResponse(path, filename=filename, media_type=content_type or "application/octet-stream")


@router.delete("/attachments/{attachment_id}")
def api_delete_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict[str, bool]:
    delete_attachment(db, attachment_id, meta=meta)
    return {"ok": True}
