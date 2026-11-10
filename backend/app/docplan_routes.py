"""Совместимость с клиентом DocPlan: личная доска и общие доски на пользователях reporting."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import BigInteger, bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Session

from app.app_access import ensure_page_access, ensure_password_change_allowed, is_roadmap_role
from app.auth_sessions import get_session_with_meta
from app.config import settings
from app.db import SessionLocal
from app.org_models import ORG_USER_STATUS_ACTIVE
from app.org_photo_service import photo_public_url, photo_signed_url

router = APIRouter()


def _now_ts() -> int:
    return int(time.time())


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _empty_state(scope: str) -> dict[str, Any]:
    return {
        "version": 4,
        "areas": [],
        "projects": [],
        "tasks": [],
        "activity": [],
        "_boardScope": scope,
        "_boardScopeAt": int(time.time() * 1000),
    }


def _as_state(raw: Any, scope: str) -> dict[str, Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            raw = None
    if not isinstance(raw, dict):
        return _empty_state(scope)
    state = dict(raw)
    state.setdefault("version", 4)
    state.setdefault("areas", [])
    state.setdefault("projects", [])
    state.setdefault("tasks", [])
    state.setdefault("activity", [])
    state["_boardScope"] = scope
    return state


def _scope_ok(state: dict[str, Any], expected: str) -> bool:
    got = state.get("_boardScope")
    if got in (None, ""):
        return True
    return str(got) == expected


def _upsert(items: list[Any], item: dict[str, Any], key: str = "id") -> list[Any]:
    item_id = str(item.get(key) or "")
    if not item_id:
        return items
    out: list[Any] = []
    found = False
    for current in items:
        if isinstance(current, dict) and str(current.get(key) or "") == item_id:
            out.append(item)
            found = True
        else:
            out.append(current)
    if not found:
        out.append(item)
    return out


def _apply_ops(state: dict[str, Any], ops: list[Any]) -> dict[str, Any]:
    for op in ops:
        if not isinstance(op, dict) or not op.get("op"):
            continue
        kind = str(op["op"])
        if kind == "upsert_task" and isinstance(op.get("task"), dict):
            task = dict(op["task"])
            if "sort_order" in op:
                task["sort_order"] = op["sort_order"]
            state["tasks"] = _upsert(list(state.get("tasks") or []), task)
        elif kind == "delete_task" and op.get("task_id"):
            tid = str(op["task_id"])
            state["tasks"] = [
                task for task in (state.get("tasks") or [])
                if not (isinstance(task, dict) and str(task.get("id") or "") == tid)
            ]
        elif kind == "upsert_area" and isinstance(op.get("area"), dict):
            state["areas"] = _upsert(list(state.get("areas") or []), dict(op["area"]))
        elif kind == "delete_area" and op.get("area_id"):
            aid = str(op["area_id"])
            state["areas"] = [
                area for area in (state.get("areas") or [])
                if not (isinstance(area, dict) and str(area.get("id") or "") == aid)
            ]
        elif kind == "upsert_project" and isinstance(op.get("project"), dict):
            state["projects"] = _upsert(list(state.get("projects") or []), dict(op["project"]))
        elif kind == "delete_project" and op.get("project_id"):
            pid = str(op["project_id"])
            state["projects"] = [
                project for project in (state.get("projects") or [])
                if not (isinstance(project, dict) and str(project.get("id") or "") == pid)
            ]
        elif kind == "set_activity" and isinstance(op.get("activity"), list):
            state["activity"] = op["activity"][:120]
        elif kind == "replace_state" and op.get("state") is not None:
            scope = str(state.get("_boardScope") or "personal")
            state = _as_state(op["state"], scope)
    return state


def _fail(status: int, error: str, **extra: Any) -> JSONResponse:
    return JSONResponse({"ok": False, "error": error, **extra}, status_code=status)


def _ok(payload: dict[str, Any], status: int = 200) -> JSONResponse:
    return JSONResponse({"ok": True, **payload}, status_code=status)


def _session_id(request: Request) -> str:
    raw = request.headers.get("x-session-id") or ""
    return raw.strip()


def _avatar_url(photo_path: str | None, session_id: str) -> str | None:
    # A signed path on this same site: <img> cannot send X-Session-Id, and a baked
    # public host would miss when the board is opened on another address.
    signed = photo_signed_url(photo_path)
    if signed:
        mark = signed.find("/", signed.find("://") + 3)
        if mark >= 0:
            return signed[mark:]
    url = photo_public_url(photo_path)
    if not url or not session_id:
        return url
    return f"{url}?sid={quote(session_id, safe='')}"


def _user(db: Session, request: Request) -> dict[str, Any] | JSONResponse:
    _, meta = get_session_with_meta(request.headers.get("x-session-id"))
    if is_roadmap_role(meta.get("app_role")):
        return _fail(403, "Недостаточно прав")
    try:
        ensure_password_change_allowed(meta, request)
        ensure_page_access(db, meta, "docplan")
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, str) else "Нет доступа"
        return _fail(exc.status_code, detail)
    raw_id = meta.get("org_user_id")
    if not raw_id:
        return _fail(401, "Нужна авторизация")
    row = db.execute(
        text(
            """
            SELECT u.id, u.email, u.status, u.created_at,
                   COALESCE(e.full_name, '') AS full_name,
                   e.id AS employee_id,
                   e.photo_path
            FROM org_user u
            LEFT JOIN employee e ON e.user_id = u.id
            WHERE u.id = :id
            LIMIT 1
            """
        ),
        {"id": int(raw_id)},
    ).mappings().first()
    if row is None or int(row["status"]) != ORG_USER_STATUS_ACTIVE:
        return _fail(401, "Нужна авторизация")
    user = dict(row)
    user["_session_id"] = _session_id(request)
    return user


def _public_user(row: dict[str, Any]) -> dict[str, Any]:
    created = row.get("created_at")
    employee_id = row.get("employee_id")
    return {
        "id": int(row["id"]),
        "employee_id": int(employee_id) if employee_id is not None else None,
        "email": row["email"],
        "full_name": row.get("full_name") or "",
        "phone": "",
        "telegram": "",
        "avatar_url": _avatar_url(row.get("photo_path"), str(row.get("_session_id") or "")),
        "email_verified": True,
        "created_at": created.isoformat() if hasattr(created, "isoformat") else created,
        "telegram_linked": False,
        "telegram_bot_enabled": False,
        "two_factor_email": False,
        "email_notifications": False,
    }


def _read_body(request: Request) -> dict[str, Any]:
    raw = request.scope.get("docplan_body")
    if isinstance(raw, dict):
        return raw
    return {}


async def _load_body(request: Request) -> dict[str, Any]:
    if request.method in ("GET", "HEAD"):
        return {}
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    request.scope["docplan_body"] = payload
    return payload


def _member_role(db: Session, board_id: int, user_id: int) -> str | None:
    row = db.execute(
        text(
            """
            SELECT role FROM docplan_board_member
            WHERE board_id = :board_id AND user_id = :user_id
            LIMIT 1
            """
        ),
        {"board_id": board_id, "user_id": user_id},
    ).first()
    return str(row[0]) if row else None


def _board_payload(
    db: Session,
    board_id: int,
    user_id: int,
    session_id: str = "",
) -> dict[str, Any] | None:
    board = db.execute(
        text(
            """
            SELECT id, title, owner_id, created_at
            FROM docplan_board WHERE id = :id LIMIT 1
            """
        ),
        {"id": board_id},
    ).mappings().first()
    if board is None:
        return None
    members = db.execute(
        text(
            """
            SELECT u.id, u.email, COALESCE(e.full_name, '') AS full_name, m.role,
                   e.id AS employee_id, e.photo_path
            FROM docplan_board_member m
            JOIN org_user u ON u.id = m.user_id
            LEFT JOIN employee e ON e.user_id = u.id
            WHERE m.board_id = :id
            ORDER BY m.role, e.full_name, u.email
            """
        ),
        {"id": board_id},
    ).mappings().all()
    my_role = None
    public_members = []
    for member in members:
        if int(member["id"]) == user_id:
            my_role = member["role"]
        employee_id = member.get("employee_id")
        public_members.append(
            {
                "id": int(member["id"]),
                "employee_id": int(employee_id) if employee_id is not None else None,
                "email": member["email"],
                "full_name": member["full_name"] or "",
                "phone": "",
                "telegram": "",
                "avatar_url": _avatar_url(member.get("photo_path"), session_id),
                "role": member["role"],
            }
        )
    created = board["created_at"]
    return {
        "id": int(board["id"]),
        "title": board["title"],
        "owner_id": int(board["owner_id"]),
        "created_at": created.isoformat() if hasattr(created, "isoformat") else created,
        "members": public_members,
        "my_role": my_role,
    }


def _ensure_personal(db: Session, user_id: int) -> None:
    db.execute(
        text(
            """
            INSERT INTO docplan_user_state (user_id, state)
            VALUES (:user_id, CAST(:state AS jsonb))
            ON CONFLICT (user_id) DO NOTHING
            """
        ),
        {"user_id": user_id, "state": _json_dumps(_empty_state("personal"))},
    )


def _lock_personal(db: Session, user_id: int) -> dict[str, Any]:
    _ensure_personal(db, user_id)
    row = db.execute(
        text(
            """
            SELECT state, revision, EXTRACT(EPOCH FROM updated_at)::bigint AS updated_ts
            FROM docplan_user_state
            WHERE user_id = :user_id
            FOR UPDATE
            """
        ),
        {"user_id": user_id},
    ).mappings().first()
    assert row is not None
    return dict(row)


def _save_personal(db: Session, user_id: int, state: dict[str, Any]) -> dict[str, Any]:
    row = db.execute(
        text(
            """
            UPDATE docplan_user_state
            SET state = CAST(:state AS jsonb),
                revision = revision + 1,
                updated_at = NOW()
            WHERE user_id = :user_id
            RETURNING revision, EXTRACT(EPOCH FROM updated_at)::bigint AS updated_ts
            """
        ),
        {"user_id": user_id, "state": _json_dumps(state)},
    ).mappings().first()
    assert row is not None
    return {"revision": int(row["revision"]), "updated_ts": int(row["updated_ts"]), "updated_by": user_id}


def _lock_board(db: Session, board_id: int) -> dict[str, Any] | None:
    row = db.execute(
        text(
            """
            SELECT state, revision, EXTRACT(EPOCH FROM updated_at)::bigint AS updated_ts, updated_by
            FROM docplan_board
            WHERE id = :id
            FOR UPDATE
            """
        ),
        {"id": board_id},
    ).mappings().first()
    return dict(row) if row else None


def _save_board(db: Session, board_id: int, user_id: int, state: dict[str, Any]) -> dict[str, Any]:
    row = db.execute(
        text(
            """
            UPDATE docplan_board
            SET state = CAST(:state AS jsonb),
                revision = revision + 1,
                updated_by = :user_id,
                updated_at = NOW()
            WHERE id = :id
            RETURNING revision, EXTRACT(EPOCH FROM updated_at)::bigint AS updated_ts
            """
        ),
        {"id": board_id, "user_id": user_id, "state": _json_dumps(state)},
    ).mappings().first()
    assert row is not None
    return {"revision": int(row["revision"]), "updated_ts": int(row["updated_ts"]), "updated_by": user_id}


def _conflict(state: dict[str, Any], meta: dict[str, Any]) -> JSONResponse:
    return JSONResponse(
        {
            "ok": False,
            "error": "conflict",
            "message": "На сервере есть более новая версия доски",
            "data": _json_dumps(state),
            "updated_ts": int(meta["updated_ts"]),
            "updated_by": meta.get("updated_by"),
            "revision": int(meta["revision"]),
        },
        status_code=409,
    )


def _normalize_role(role: Any) -> str:
    return "viewer" if str(role or "").lower() == "viewer" else "editor"


def _dict_items(state: dict[str, Any], key: str) -> list[dict[str, Any]]:
    return [item for item in (state.get(key) or []) if isinstance(item, dict)]


def _reporting_people(db: Session, session_id: str) -> list[dict[str, Any]]:
    rows = db.execute(
        text(
            """
            SELECT u.id, u.email,
                   e.id AS employee_id,
                   COALESCE(e.full_name, '') AS full_name,
                   e.photo_path
            FROM org_user u
            LEFT JOIN employee e ON e.user_id = u.id
            WHERE u.status = :status
            ORDER BY e.full_name NULLS LAST, u.email
            """
        ),
        {"status": ORG_USER_STATUS_ACTIVE},
    ).mappings().all()
    people: list[dict[str, Any]] = []
    for row in rows:
        employee_id = row["employee_id"]
        people.append(
            {
                "id": int(row["id"]),
                "employee_id": int(employee_id) if employee_id is not None else None,
                "email": row["email"],
                "full_name": row["full_name"] or "",
                "avatar_url": _avatar_url(row["photo_path"], session_id),
            }
        )
    return people


def _load_scope_state(db: Session, user_id: int, board_id: int) -> dict[str, Any] | None:
    if board_id == 0:
        locked = _lock_personal(db, user_id)
        return _as_state(locked["state"], "personal")
    locked = _lock_board(db, board_id)
    if locked is None:
        return None
    return _as_state(locked["state"], f"board:{board_id}")


def _save_scope_state(db: Session, user_id: int, board_id: int, state: dict[str, Any]) -> dict[str, Any]:
    if board_id == 0:
        return _save_personal(db, user_id, state)
    return _save_board(db, board_id, user_id, state)


def _lock_move_scopes(db: Session, user_id: int, from_board: int, to_board: int) -> bool:
    if from_board > 0 and to_board > 0:
        for board_id in sorted({from_board, to_board}):
            if _lock_board(db, board_id) is None:
                return False
        return True
    _lock_personal(db, user_id)
    for board_id in (from_board, to_board):
        if board_id > 0 and _lock_board(db, board_id) is None:
            return False
    return True


def _move_project(db: Session, user: dict[str, Any], body: dict[str, Any]) -> JSONResponse:
    uid = int(user["id"])
    project_id = str(body.get("project_id") or "").strip()
    try:
        from_board = int(body.get("from_board_id") or 0)
        to_board = int(body.get("to_board_id") or 0)
    except (TypeError, ValueError):
        return _fail(400, "Нужен project_id")
    if not project_id or len(project_id) > 64 or from_board < 0 or to_board < 0:
        return _fail(400, "Нужен project_id")
    if from_board == to_board:
        return _fail(400, "Проект уже на этой доске")
    for board_id in (from_board, to_board):
        if board_id == 0:
            continue
        role = _member_role(db, board_id, uid)
        if role is None:
            return _fail(403, "Нет доступа к доске")
        if role == "viewer":
            return _fail(403, "У наблюдателя нет права на изменение")
    if not _lock_move_scopes(db, uid, from_board, to_board):
        return _fail(404, "Доска не найдена")
    source = _load_scope_state(db, uid, from_board)
    target = _load_scope_state(db, uid, to_board)
    if source is None or target is None:
        return _fail(404, "Доска не найдена")

    source_projects = _dict_items(source, "projects")
    project = next((item for item in source_projects if str(item.get("id") or "") == project_id), None)
    if project is None:
        return _fail(404, "Проект не найден на исходной доске — обновите страницу")
    if any(str(item.get("id") or "") == project_id for item in _dict_items(target, "projects")):
        return _fail(409, "На выбранной доске уже есть этот проект")

    moving_tasks = [
        dict(task)
        for task in _dict_items(source, "tasks")
        if str(task.get("projectId") or "") == project_id
    ]
    moving_ids = {str(task.get("id") or "") for task in moving_tasks if task.get("id")}
    if any(str(task.get("id") or "") in moving_ids for task in _dict_items(target, "tasks")):
        return _fail(409, "На выбранной доске уже есть задачи с теми же id")

    areas = _dict_items(target, "areas")
    if areas:
        area_id = areas[0].get("id") or "area_projects"
    else:
        area_id = "area_projects"
        target["areas"] = [{"id": area_id, "title": "Проекты"}]

    members: set[str] = set()
    if to_board > 0:
        members = {
            str(int(row[0]))
            for row in db.execute(
                text("SELECT user_id FROM docplan_board_member WHERE board_id = :id"),
                {"id": to_board},
            ).all()
        }

    moved = dict(project)
    moved["id"] = project_id
    moved["areaId"] = area_id
    linked = body.get("linked_diagram_ids")
    if isinstance(linked, list):
        moved["linkedDiagramIds"] = [str(item)[:64] for item in linked if isinstance(item, str) and item][:24]
    team_ids = moved.get("teamIds")
    if to_board > 0 and isinstance(team_ids, list):
        moved["teamIds"] = [item for item in team_ids if str(item) in members]
    else:
        moved.pop("teamIds", None)

    max_num = 0
    for task in _dict_items(target, "tasks"):
        try:
            max_num = max(max_num, int(task.get("numId") or 0))
        except (TypeError, ValueError):
            continue

    stats = {"tasks": 0, "unassigned": 0, "relations_dropped": 0, "docs_moved": 0, "docs_deleted": 0}
    kept_tasks: list[dict[str, Any]] = []
    for task in moving_tasks:
        task["projectId"] = project_id
        task["areaId"] = area_id
        max_num += 1
        task["numId"] = max_num
        assignee = task.get("assignee")
        if isinstance(assignee, dict) and assignee.get("id") is not None:
            if not (to_board > 0 and str(assignee.get("id")) in members):
                task["assignee"] = None
                stats["unassigned"] += 1
        relations = task.get("relations")
        if isinstance(relations, list):
            kept_relations = []
            for relation in relations:
                if not isinstance(relation, dict):
                    continue
                other = str(relation.get("otherTaskId") or "")
                if other and other not in moving_ids:
                    stats["relations_dropped"] += 1
                    continue
                kept_relations.append(relation)
            task["relations"] = kept_relations
        kept_tasks.append(task)
    stats["tasks"] = len(kept_tasks)

    remaining: list[dict[str, Any]] = []
    for task in _dict_items(source, "tasks"):
        if str(task.get("id") or "") in moving_ids:
            continue
        relations = task.get("relations")
        if isinstance(relations, list):
            task = dict(task)
            kept_relations = []
            for relation in relations:
                if isinstance(relation, dict) and str(relation.get("otherTaskId") or "") in moving_ids:
                    stats["relations_dropped"] += 1
                    continue
                kept_relations.append(relation)
            task["relations"] = kept_relations
        remaining.append(task)

    source["projects"] = [item for item in source_projects if str(item.get("id") or "") != project_id]
    source["tasks"] = remaining
    target["projects"] = _dict_items(target, "projects") + [moved]
    target["tasks"] = _dict_items(target, "tasks") + kept_tasks

    saved_from = _save_scope_state(db, uid, from_board, source)
    saved_to = _save_scope_state(db, uid, to_board, target)

    move_docs = bool(body.get("move_board_docs")) and from_board > 0 and to_board > 0
    drop_docs = bool(body.get("delete_board_docs")) and from_board > 0 and to_board == 0
    if move_docs or drop_docs:
        doc_rows = db.execute(
            text("SELECT doc_id, payload FROM docplan_document WHERE board_id = :board_id"),
            {"board_id": from_board},
        ).mappings().all()
        doc_ids = []
        for row in doc_rows:
            payload = row["payload"]
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except json.JSONDecodeError:
                    payload = None
            if isinstance(payload, dict) and str(payload.get("projectId") or "") == project_id:
                doc_ids.append(str(row["doc_id"]))
        for doc_id in doc_ids:
            if move_docs:
                db.execute(
                    text(
                        """
                        UPDATE docplan_document
                        SET board_id = :to_board, updated_by = :user_id, updated_at = NOW()
                        WHERE board_id = :from_board AND doc_id = :doc_id
                        """
                    ),
                    {
                        "to_board": to_board,
                        "from_board": from_board,
                        "user_id": uid,
                        "doc_id": doc_id,
                    },
                )
            else:
                db.execute(
                    text(
                        """
                        DELETE FROM docplan_document
                        WHERE board_id = :from_board AND doc_id = :doc_id
                        """
                    ),
                    {"from_board": from_board, "doc_id": doc_id},
                )
        if doc_ids:
            stats["docs_moved" if move_docs else "docs_deleted"] = len(doc_ids)

    db.commit()
    return _ok({"stats": stats, "from": saved_from, "to": saved_to})


@router.api_route("/docplan/api/auth.php", methods=["GET", "POST"])
async def docplan_auth(request: Request) -> JSONResponse:
    action = request.query_params.get("action") or ""
    db = SessionLocal()
    try:
        if action == "me":
            user = _user(db, request)
            if isinstance(user, JSONResponse):
                return _ok({"user": None, "csrf_token": "reporting"})
            return _ok(
                {
                    "user": _public_user(user),
                    "csrf_token": "reporting",
                    "session": {
                        "remember": 1,
                        "expires_at": None,
                        "lifetime_days": 30,
                        "sliding": True,
                    },
                }
            )
        if action == "logout":
            return _ok({})
        return _fail(400, "Вход выполняется через reporting")
    finally:
        db.close()


@router.api_route("/docplan/api/profile.php", methods=["GET", "POST"])
async def docplan_profile(request: Request) -> JSONResponse:
    db = SessionLocal()
    try:
        user = _user(db, request)
        if isinstance(user, JSONResponse):
            return user
        return _ok({"user": _public_user(user)})
    finally:
        db.close()


@router.api_route("/docplan/api/ping.php", methods=["GET"])
async def docplan_ping() -> JSONResponse:
    return _ok({"t": _now_ts()})


@router.api_route("/docplan/api/notif.php", methods=["GET", "POST"])
async def docplan_notif(request: Request) -> JSONResponse:
    db = SessionLocal()
    try:
        user = _user(db, request)
        if isinstance(user, JSONResponse):
            return user
        return _ok({"items": [], "seen_at_ms": 0, "cleared_at_ms": 0, "dismissed": []})
    finally:
        db.close()


@router.api_route("/docplan/api/data.php", methods=["GET", "POST"])
async def docplan_data(request: Request) -> JSONResponse:
    body = await _load_body(request)
    db = SessionLocal()
    try:
        user = _user(db, request)
        if isinstance(user, JSONResponse):
            return user
        uid = int(user["id"])
        if request.method == "GET":
            locked = _lock_personal(db, uid)
            state = _as_state(locked["state"], "personal")
            data: dict[str, Any] = {"tasktrekerData": _json_dumps(state)}
            meta = {"tasktrekerData": int(locked["updated_ts"])}
            keys = db.execute(
                text(
                    """
                    SELECT data_key, data_value, EXTRACT(EPOCH FROM updated_at)::bigint AS updated_ts
                    FROM docplan_user_kv WHERE user_id = :user_id
                    """
                ),
                {"user_id": uid},
            ).mappings().all()
            wanted = None
            raw_keys = (request.query_params.get("keys") or "").strip()
            if raw_keys:
                wanted = {part.strip() for part in raw_keys.split(",") if part.strip()}
            for item in keys:
                if wanted is not None and item["data_key"] not in wanted:
                    continue
                data[item["data_key"]] = item["data_value"]
                meta[item["data_key"]] = int(item["updated_ts"])
            if wanted is not None:
                data = {key: value for key, value in data.items() if key in wanted}
                meta = {key: value for key, value in meta.items() if key in wanted}
            db.commit()
            return _ok({"data": data, "meta": meta})

        if isinstance(body.get("ops"), list):
            locked = _lock_personal(db, uid)
            state = _apply_ops(_as_state(locked["state"], "personal"), body["ops"])
            if not _scope_ok(state, "personal"):
                return _fail(400, "board_scope_mismatch", message="Данные командной доски нельзя сохранить в личные")
            saved = _save_personal(db, uid, state)
            db.commit()
            return _ok(
                {
                    "updated_ts": saved["updated_ts"],
                    "revision": saved["revision"],
                    "meta": {"tasktrekerData": saved["updated_ts"]},
                }
            )

        incoming = body.get("data")
        if not isinstance(incoming, dict):
            return _fail(400, 'Ожидается { "data": { "key": "value", ... } }')
        saved_keys: list[str] = []
        meta_out: dict[str, int] = {}
        for key, value in incoming.items():
            key = str(key)[:64]
            if value is None or not key:
                continue
            raw = value if isinstance(value, str) else _json_dumps(value)
            if len(raw) > 8 * 1024 * 1024:
                return _fail(413, f"Слишком большие данные: {key}")
            if key == "tasktrekerData":
                parsed = json.loads(raw) if raw[:1] in "{[" else {}
                state = _as_state(parsed, "personal")
                if not _scope_ok(state, "personal"):
                    return _fail(
                        400,
                        "board_scope_mismatch",
                        message="Данные командной доски нельзя сохранить в личные",
                    )
                _lock_personal(db, uid)
                saved = _save_personal(db, uid, state)
                meta_out["tasktrekerData"] = saved["updated_ts"]
            else:
                db.execute(
                    text(
                        """
                        INSERT INTO docplan_user_kv (user_id, data_key, data_value)
                        VALUES (:user_id, :data_key, :data_value)
                        ON CONFLICT (user_id, data_key)
                        DO UPDATE SET data_value = EXCLUDED.data_value, updated_at = NOW()
                        """
                    ),
                    {"user_id": uid, "data_key": key, "data_value": raw},
                )
                meta_out[key] = _now_ts()
            saved_keys.append(key)
        db.commit()
        return _ok({"saved": saved_keys, "skipped": [], "meta": meta_out})
    finally:
        db.close()


@router.api_route("/docplan/api/boards.php", methods=["GET", "POST"])
async def docplan_boards(request: Request) -> JSONResponse:
    body = await _load_body(request)
    action = request.query_params.get("action") or "list"
    db = SessionLocal()
    try:
        user = _user(db, request)
        if isinstance(user, JSONResponse):
            return user
        uid = int(user["id"])

        if action == "people" and request.method == "GET":
            return _ok({"people": _reporting_people(db, _session_id(request))})

        if action == "list" and request.method == "GET":
            rows = db.execute(
                text(
                    """
                    SELECT b.id, b.title, b.owner_id, b.created_at, m.role AS my_role
                    FROM docplan_board b
                    JOIN docplan_board_member m ON m.board_id = b.id
                    WHERE m.user_id = :user_id
                    ORDER BY b.title
                    """
                ),
                {"user_id": uid},
            ).mappings().all()
            boards = []
            for row in rows:
                created = row["created_at"]
                boards.append(
                    {
                        "id": int(row["id"]),
                        "title": row["title"],
                        "owner_id": int(row["owner_id"]),
                        "my_role": row["my_role"],
                        "created_at": created.isoformat() if hasattr(created, "isoformat") else created,
                    }
                )
            return _ok({"boards": boards})

        if action == "get" and request.method == "GET":
            board_id = int(request.query_params.get("id") or 0)
            if _member_role(db, board_id, uid) is None:
                return _fail(403, "Нет доступа к доске")
            board = _board_payload(db, board_id, uid, str(user.get("_session_id") or ""))
            if board is None:
                return _fail(404, "Доска не найдена")
            return _ok({"board": board})

        if action == "create" and request.method == "POST":
            title = str(body.get("title") or "").strip()
            if not title:
                return _fail(400, "Укажите название доски")
            if len(title) > 190:
                return _fail(400, "Слишком длинное название")
            row = db.execute(
                text(
                    """
                    INSERT INTO docplan_board (title, owner_id, state, updated_by)
                    VALUES (:title, :owner_id, CAST(:state AS jsonb), :owner_id)
                    RETURNING id
                    """
                ),
                {
                    "title": title,
                    "owner_id": uid,
                    "state": _json_dumps(_empty_state("board:0")),
                },
            ).first()
            board_id = int(row[0])
            state = _empty_state(f"board:{board_id}")
            db.execute(
                text("UPDATE docplan_board SET state = CAST(:state AS jsonb) WHERE id = :id"),
                {"state": _json_dumps(state), "id": board_id},
            )
            db.execute(
                text(
                    """
                    INSERT INTO docplan_board_member (board_id, user_id, role)
                    VALUES (:board_id, :user_id, 'owner')
                    """
                ),
                {"board_id": board_id, "user_id": uid},
            )
            db.commit()
            return _ok({"board": _board_payload(db, board_id, uid, str(user.get("_session_id") or ""))})

        if action == "rename" and request.method == "POST":
            board_id = int(body.get("board_id") or 0)
            title = str(body.get("title") or "").strip()
            if _member_role(db, board_id, uid) != "owner":
                return _fail(403, "Переименовать может только владелец")
            if not title or len(title) > 190:
                return _fail(400, "Укажите название доски")
            db.execute(
                text("UPDATE docplan_board SET title = :title WHERE id = :id"),
                {"title": title, "id": board_id},
            )
            db.commit()
            return _ok({"board": _board_payload(db, board_id, uid, str(user.get("_session_id") or ""))})

        if action == "invite" and request.method == "POST":
            board_id = int(body.get("board_id") or 0)
            email = str(body.get("email") or "").strip().lower()
            if _member_role(db, board_id, uid) != "owner":
                return _fail(403, "Приглашать может только владелец")
            if "@" not in email:
                return _fail(400, "Нужны board_id и email")
            found = db.execute(
                text(
                    """
                    SELECT u.id
                    FROM org_user u
                    LEFT JOIN employee e ON e.user_id = u.id
                    WHERE u.status = :status
                      AND (lower(u.email) = :email OR lower(COALESCE(e.email, '')) = :email)
                    LIMIT 1
                    """
                ),
                {"email": email, "status": ORG_USER_STATUS_ACTIVE},
            ).first()
            if found is None:
                return _fail(404, "Такого сотрудника нет в reporting. Пригласить можно только коллегу с учёткой.")
            member_id = int(found[0])
            if member_id == uid:
                return _fail(400, "Вы уже на доске")
            role = _normalize_role(body.get("role"))
            inserted = db.execute(
                text(
                    """
                    INSERT INTO docplan_board_member (board_id, user_id, role)
                    VALUES (:board_id, :user_id, :role)
                    ON CONFLICT DO NOTHING
                    RETURNING user_id
                    """
                ),
                {"board_id": board_id, "user_id": member_id, "role": role},
            ).first()
            if inserted is None:
                return _fail(409, "Пользователь уже на доске")
            board = _board_payload(db, board_id, uid, str(user.get("_session_id") or ""))
            db.commit()
            _mail_board_access(email, (board or {}).get("title") or "Доска", user)
            return _ok(
                {
                    "pending": False,
                    "board": board,
                    "message": "Участник добавлен на доску",
                }
            )

        if action == "remove_member" and request.method == "POST":
            board_id = int(body.get("board_id") or 0)
            member_id = int(body.get("user_id") or 0)
            if _member_role(db, board_id, uid) != "owner":
                return _fail(403, "Удалять участников может только владелец")
            if member_id == uid:
                return _fail(400, "Владелец не может удалить себя")
            db.execute(
                text(
                    """
                    DELETE FROM docplan_board_member
                    WHERE board_id = :board_id AND user_id = :user_id AND role <> 'owner'
                    """
                ),
                {"board_id": board_id, "user_id": member_id},
            )
            db.commit()
            return _ok({"board": _board_payload(db, board_id, uid, str(user.get("_session_id") or ""))})

        if action == "set_role" and request.method == "POST":
            board_id = int(body.get("board_id") or 0)
            member_id = int(body.get("user_id") or 0)
            if _member_role(db, board_id, uid) != "owner":
                return _fail(403, "Менять роль может только владелец")
            role = _normalize_role(body.get("role"))
            db.execute(
                text(
                    """
                    UPDATE docplan_board_member
                    SET role = :role
                    WHERE board_id = :board_id AND user_id = :user_id AND role <> 'owner'
                    """
                ),
                {"board_id": board_id, "user_id": member_id, "role": role},
            )
            db.commit()
            return _ok({"board": _board_payload(db, board_id, uid, str(user.get("_session_id") or ""))})

        if action == "leave" and request.method == "POST":
            board_id = int(body.get("board_id") or 0)
            role = _member_role(db, board_id, uid)
            if role is None:
                return _fail(403, "Нет доступа к доске")
            if role == "owner":
                return _fail(400, "Владелец не может выйти. Удалите доску или передайте её.")
            db.execute(
                text("DELETE FROM docplan_board_member WHERE board_id = :board_id AND user_id = :user_id"),
                {"board_id": board_id, "user_id": uid},
            )
            db.commit()
            return _ok({})

        if action == "delete" and request.method == "POST":
            board_id = int(body.get("board_id") or 0)
            if _member_role(db, board_id, uid) != "owner":
                return _fail(403, "Удалить может только владелец")
            db.execute(text("DELETE FROM docplan_board WHERE id = :id"), {"id": board_id})
            db.commit()
            return _ok({})

        if action == "data_meta" and request.method == "GET":
            ids = _board_ids(request)
            if not ids:
                return _ok({"updated_ts": 0, "revision": 0, "boards": {}})
            rows = db.execute(
                text(
                    """
                    SELECT b.id, b.revision, EXTRACT(EPOCH FROM b.updated_at)::bigint AS updated_ts
                    FROM docplan_board b
                    JOIN docplan_board_member m ON m.board_id = b.id
                    WHERE m.user_id = :user_id AND b.id = ANY(:ids)
                    """
                ).bindparams(bindparam("ids", type_=ARRAY(BigInteger))),
                {"user_id": uid, "ids": ids},
            ).mappings().all()
            boards_meta = {
                str(int(row["id"])): {"updated_ts": int(row["updated_ts"]), "revision": int(row["revision"])}
                for row in rows
            }
            single_ts = 0
            single_rev = 0
            if len(ids) == 1 and str(ids[0]) in boards_meta:
                single_ts = boards_meta[str(ids[0])]["updated_ts"]
                single_rev = boards_meta[str(ids[0])]["revision"]
            return _ok({"updated_ts": single_ts, "revision": single_rev, "boards": boards_meta})

        if action == "data" and request.method == "GET":
            board_id = int(request.query_params.get("id") or 0)
            if _member_role(db, board_id, uid) is None:
                return _fail(403, "Нет доступа к доске")
            locked = _lock_board(db, board_id)
            if locked is None:
                return _fail(404, "Доска не найдена")
            state = _as_state(locked["state"], f"board:{board_id}")
            db.commit()
            return _ok(
                {
                    "data": _json_dumps(state),
                    "updated_ts": int(locked["updated_ts"]),
                    "updated_by": locked["updated_by"],
                    "revision": int(locked["revision"]),
                }
            )

        if action == "patch" and request.method == "POST":
            board_id = int(body.get("board_id") or 0)
            ops = body.get("ops")
            role = _member_role(db, board_id, uid)
            if role is None:
                return _fail(403, "Нет доступа к доске")
            if role == "viewer":
                return _fail(403, "У наблюдателя нет права на изменение")
            if not isinstance(ops, list):
                return _fail(400, "Нужны board_id и ops")
            locked = _lock_board(db, board_id)
            if locked is None:
                return _fail(404, "Доска не найдена")
            expected = body.get("expected_updated_ts")
            if expected is not None and int(locked["updated_ts"]) > int(expected):
                state = _as_state(locked["state"], f"board:{board_id}")
                return _conflict(state, locked)
            state = _apply_ops(_as_state(locked["state"], f"board:{board_id}"), ops)
            if not _scope_ok(state, f"board:{board_id}"):
                return _fail(400, "board_scope_mismatch", message="Данные другой доски нельзя сохранить сюда")
            saved = _save_board(db, board_id, uid, state)
            db.commit()
            return _ok(saved)

        if action == "data" and request.method == "POST":
            board_id = int(body.get("board_id") or 0)
            raw = body.get("tasktrekerData")
            role = _member_role(db, board_id, uid)
            if role is None:
                return _fail(403, "Нет доступа к доске")
            if role == "viewer":
                return _fail(403, "У наблюдателя нет права на изменение")
            if raw is None:
                return _fail(400, "Нужны board_id и tasktrekerData")
            state = _as_state(raw, f"board:{board_id}")
            if not _scope_ok(state, f"board:{board_id}"):
                return _fail(400, "board_scope_mismatch", message="Данные другой доски нельзя сохранить сюда")
            locked = _lock_board(db, board_id)
            if locked is None:
                return _fail(404, "Доска не найдена")
            expected = body.get("expected_updated_ts")
            if expected is not None and int(locked["updated_ts"]) > int(expected):
                return _conflict(_as_state(locked["state"], f"board:{board_id}"), locked)
            saved = _save_board(db, board_id, uid, state)
            db.commit()
            return _ok(saved)

        if action == "move_project" and request.method == "POST":
            return _move_project(db, user, body)

        if action == "notif_slice" and request.method == "GET":
            ids = _board_ids(request)[:40]
            out: dict[str, Any] = {}
            for board_id in ids:
                if _member_role(db, board_id, uid) is None:
                    continue
                locked = _lock_board(db, board_id)
                if locked is None:
                    continue
                state = _as_state(locked["state"], f"board:{board_id}")
                out[str(board_id)] = {
                    "activity": (state.get("activity") or [])[:80],
                    "tasks": [
                        {
                            "id": task.get("id"),
                            "title": task.get("title") or "",
                            "status": task.get("status"),
                            "completed": task.get("completed"),
                        }
                        for task in (state.get("tasks") or [])
                        if isinstance(task, dict)
                    ],
                    "updated_ts": int(locked["updated_ts"]),
                    "revision": int(locked["revision"]),
                }
            db.commit()
            return _ok({"boards": out})

        return _fail(400, "Unknown action")
    finally:
        db.close()


def _board_ids(request: Request) -> list[int]:
    raw = (request.query_params.get("ids") or "").strip()
    if raw:
        ids = []
        for part in raw.split(","):
            try:
                value = int(part.strip())
            except ValueError:
                continue
            if value > 0:
                ids.append(value)
        return ids[:80]
    try:
        value = int(request.query_params.get("id") or 0)
    except ValueError:
        return []
    return [value] if value > 0 else []


def _mail_board_access(email: str, title: str, inviter: dict[str, Any]) -> None:
    try:
        from app.password_reset_mail import MailNotConfigured, MailSendError, send_html_mail
    except Exception:
        return
    who = inviter.get("full_name") or inviter.get("email") or "Коллега"
    link = settings.app_public_url.rstrip("/") + "/?sheet=docplan"
    subject = f"Вам предоставлен доступ к доске «{title}»"
    text_body = f"{who} открыл вам доску «{title}».\n\nОткрыть: {link}\n"
    html = (
        f"<p>{who} открыл вам доску «{title}».</p>"
        f'<p><a href="{link}">Открыть доску</a></p>'
    )
    try:
        send_html_mail(to_email=email, subject=subject, html=html, text=text_body)
    except (MailNotConfigured, MailSendError):
        return


@router.api_route("/docplan/api/documents.php", methods=["GET", "POST"])
async def docplan_documents(request: Request) -> JSONResponse:
    body = await _load_body(request)
    action = request.query_params.get("action") or "list"
    db = SessionLocal()
    try:
        user = _user(db, request)
        if isinstance(user, JSONResponse):
            return user
        uid = int(user["id"])
        board_id = int(request.query_params.get("board_id") or body.get("boardId") or body.get("board_id") or 0)
        if action == "shared":
            return _fail(404, "Ссылка недействительна или отозвана")
        if action == "publish_personal":
            return _ok({"document": body})
        if board_id < 1:
            return _fail(400, "Нужен board_id")
        role = _member_role(db, board_id, uid)
        if role is None:
            return _fail(403, "Нет доступа к доске")
        if request.method == "POST" and role == "viewer" and action not in ("comments",):
            return _fail(403, "У наблюдателя нет права на изменение")

        if action == "list":
            rows = db.execute(
                text("SELECT payload FROM docplan_document WHERE board_id = :board_id ORDER BY updated_at"),
                {"board_id": board_id},
            ).all()
            kind = request.query_params.get("kind")
            documents = []
            for row in rows:
                payload = row[0]
                if isinstance(payload, str):
                    payload = json.loads(payload)
                if kind and isinstance(payload, dict) and payload.get("kind") not in (None, kind):
                    continue
                documents.append(payload)
            return _ok({"documents": documents})

        if action == "get":
            doc_id = (request.query_params.get("id") or "").strip()
            row = db.execute(
                text(
                    """
                    SELECT payload FROM docplan_document
                    WHERE board_id = :board_id AND doc_id = :doc_id
                    """
                ),
                {"board_id": board_id, "doc_id": doc_id},
            ).first()
            if row is None:
                return _fail(404, "Документ не найден")
            return _ok({"document": row[0]})

        if action == "save":
            doc_id = str(body.get("id") or body.get("docId") or uuid.uuid4().hex)
            payload = dict(body)
            payload["id"] = doc_id
            db.execute(
                text(
                    """
                    INSERT INTO docplan_document (board_id, doc_id, payload, updated_by)
                    VALUES (:board_id, :doc_id, CAST(:payload AS jsonb), :user_id)
                    ON CONFLICT (board_id, doc_id)
                    DO UPDATE SET payload = EXCLUDED.payload, updated_by = EXCLUDED.updated_by, updated_at = NOW()
                    """
                ),
                {"board_id": board_id, "doc_id": doc_id, "payload": _json_dumps(payload), "user_id": uid},
            )
            db.commit()
            return _ok({"document": payload})

        if action == "delete":
            doc_id = str(body.get("id") or "")
            db.execute(
                text("DELETE FROM docplan_document WHERE board_id = :board_id AND doc_id = :doc_id"),
                {"board_id": board_id, "doc_id": doc_id},
            )
            db.commit()
            return _ok({})

        if action in ("comments", "versions", "version_diff"):
            return _ok({"comments": [], "versions": [], "diff": ""})
        if action == "board_members":
            board = _board_payload(db, board_id, uid, str(user.get("_session_id") or ""))
            return _ok({"members": (board or {}).get("members") or []})
        return _ok({})
    finally:
        db.close()


@router.api_route("/docplan/api/{script}", methods=["GET", "POST"])
async def docplan_stub(script: str, request: Request) -> JSONResponse:
    if not script.endswith(".php"):
        return _fail(404, "Не найдено")
    db = SessionLocal()
    try:
        user = _user(db, request)
        if isinstance(user, JSONResponse):
            return user
        return _ok({})
    finally:
        db.close()
