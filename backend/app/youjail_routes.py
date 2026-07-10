from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.auth_sessions import get_session_with_meta
from app.db import get_db
from app.youjail_schemas import (
    YouJailBoardOut,
    YouJailCardIn,
    YouJailCardMoveIn,
    YouJailCardOut,
    YouJailCardUpdateIn,
    YouJailExecuteIn,
    YouJailExecutionOut,
    YouJailProjectIn,
    YouJailProjectOut,
    YouJailProjectUpdateIn,
    YouJailTaskTypeIn,
    YouJailTaskTypeOut,
    YouJailAttachmentOut,
)
from app.youjail_service import (
    create_card,
    create_project,
    create_task_type,
    delete_attachment,
    delete_card,
    get_card,
    get_execution,
    list_card_executions,
    list_projects,
    list_task_types,
    load_attachment_file,
    load_board,
    move_card,
    save_attachment,
    set_card_flag,
    start_execution,
    update_card,
    update_project,
)

router = APIRouter(prefix="/api/youjail", tags=["youjail"])


def _load_session_meta(x_session_id: str | None = Header(default=None, alias="X-Session-Id")) -> dict:
    auth, meta = get_session_with_meta(x_session_id)
    if auth is None:
        raise HTTPException(status_code=401, detail="Сессия отсутствует. Войдите в систему.")
    return meta


@router.get("/board", response_model=YouJailBoardOut)
def api_load_board(
    search: str | None = Query(default=None),
    archived: str = Query(default="false", pattern="^(false|true|all)$"),
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict:
    return load_board(db, search=search, archived=archived)


@router.get("/cards/{card_id}", response_model=YouJailCardOut)
def api_get_card(
    card_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict:
    return get_card(db, card_id)


@router.post("/cards", response_model=YouJailCardOut)
def api_create_card(
    payload: YouJailCardIn,
    db: Session = Depends(get_db),
    meta: dict = Depends(_load_session_meta),
) -> dict:
    created_by = meta.get("account_label") or meta.get("login")
    return create_card(db, payload.model_dump(), created_by=created_by)


@router.patch("/cards/{card_id}", response_model=YouJailCardOut)
def api_update_card(
    card_id: int,
    payload: YouJailCardUpdateIn,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict:
    return update_card(db, card_id, payload.model_dump(exclude_unset=True))


@router.post("/cards/{card_id}/move", response_model=YouJailCardOut)
def api_move_card(
    card_id: int,
    payload: YouJailCardMoveIn,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict:
    return move_card(db, card_id, column_id=payload.columnId, sort_order=payload.sortOrder)


@router.delete("/cards/{card_id}")
def api_delete_card(
    card_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict[str, bool]:
    delete_card(db, card_id)
    return {"ok": True}


@router.post("/cards/{card_id}/pin", response_model=YouJailCardOut)
def api_pin_card(
    card_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict:
    card = get_card(db, card_id)
    return set_card_flag(db, card_id, pinned=not card["pinned"])


@router.post("/cards/{card_id}/archive", response_model=YouJailCardOut)
def api_archive_card(
    card_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict:
    card = get_card(db, card_id)
    return set_card_flag(db, card_id, archived=not card["archived"])


@router.post("/cards/{card_id}/close", response_model=YouJailCardOut)
def api_close_card(
    card_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict:
    from datetime import datetime, timezone

    card = get_card(db, card_id)
    closed_at = None if card["closedAt"] else datetime.now(timezone.utc)
    return set_card_flag(db, card_id, closedAt=closed_at)


@router.post("/cards/{card_id}/execute", response_model=YouJailExecutionOut)
def api_execute_card(
    card_id: int,
    payload: YouJailExecuteIn,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict:
    return start_execution(db, card_id, executor=payload.executor, feedback=None)


@router.post("/cards/{card_id}/retry", response_model=YouJailExecutionOut)
def api_retry_card(
    card_id: int,
    payload: YouJailExecuteIn,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict:
    return start_execution(db, card_id, executor=payload.executor, feedback=payload.retryFeedback)


@router.get("/cards/{card_id}/executions", response_model=list[YouJailExecutionOut])
def api_list_card_executions(
    card_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> list[dict]:
    return list_card_executions(db, card_id)


@router.get("/executions/{execution_id}", response_model=YouJailExecutionOut)
def api_get_execution(
    execution_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict:
    return get_execution(db, execution_id, with_logs=True)


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
    _: dict = Depends(_load_session_meta),
) -> dict:
    return await save_attachment(db, card_id, file)


@router.get("/attachments/{attachment_id}/download")
def api_download_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> FileResponse:
    path, filename, content_type = load_attachment_file(db, attachment_id)
    return FileResponse(path, filename=filename, media_type=content_type or "application/octet-stream")


@router.delete("/attachments/{attachment_id}")
def api_delete_attachment(
    attachment_id: int,
    db: Session = Depends(get_db),
    _: dict = Depends(_load_session_meta),
) -> dict[str, bool]:
    delete_attachment(db, attachment_id)
    return {"ok": True}
