import secrets

from sqlalchemy import delete

from app.db import SessionLocal
from app.models import AuthSession
from app.tfs_auth import TfsAuth


def _auth_to_payload(
    auth: TfsAuth,
    *,
    auth_mode: str = "pat",
    app_login: str | None = None,
    app_role: str = "full",
) -> dict:
    return {
        "base_url": auth.base_url,
        "project": auth.project,
        "project_id": auth.project_id,
        "pat": auth.pat,
        "cookie": auth.cookie,
        "extra_headers": auth.extra_headers,
        "auth_mode": auth_mode,
        "app_login": app_login,
        "app_role": app_role,
    }


def _auth_from_payload(payload: dict) -> TfsAuth | None:
    base_url = payload.get("base_url")
    project = payload.get("project")
    if not isinstance(base_url, str) or not isinstance(project, str):
        return None
    extra_headers = payload.get("extra_headers")
    if not isinstance(extra_headers, dict):
        extra_headers = None
    return TfsAuth(
        base_url=base_url,
        project=project,
        project_id=payload.get("project_id"),
        pat=payload.get("pat"),
        cookie=payload.get("cookie"),
        extra_headers=extra_headers,
    )


def _session_meta_from_payload(payload: dict) -> dict[str, str | None]:
    from app.app_access import normalize_app_role

    auth_mode = payload.get("auth_mode")
    app_login = payload.get("app_login")
    app_role = payload.get("app_role")
    return {
        "auth_mode": str(auth_mode) if auth_mode else None,
        "app_login": str(app_login) if app_login else None,
        "app_role": normalize_app_role(str(app_role) if app_role else None),
    }


def _load_session_payload(session_id: str | None) -> dict | None:
    if not session_id:
        return None
    db = SessionLocal()
    try:
        row = db.get(AuthSession, session_id)
        if row is None or not isinstance(row.payload, dict):
            return None
        return dict(row.payload)
    finally:
        db.close()


def create_session(
    auth: TfsAuth,
    *,
    auth_mode: str = "pat",
    app_login: str | None = None,
    app_role: str = "full",
) -> str:
    session_id = secrets.token_urlsafe(32)
    db = SessionLocal()
    try:
        db.add(
            AuthSession(
                id=session_id,
                payload=_auth_to_payload(
                    auth,
                    auth_mode=auth_mode,
                    app_login=app_login,
                    app_role=app_role,
                ),
            )
        )
        db.commit()
    finally:
        db.close()
    return session_id


def get_session_meta(session_id: str | None) -> dict[str, str | None]:
    payload = _load_session_payload(session_id)
    if payload is None:
        return {"auth_mode": None, "app_login": None, "app_role": "full"}
    return _session_meta_from_payload(payload)


def get_session(session_id: str | None) -> TfsAuth | None:
    payload = _load_session_payload(session_id)
    if payload is None:
        return None
    return _auth_from_payload(payload)


def get_session_with_meta(session_id: str | None) -> tuple[TfsAuth | None, dict[str, str | None]]:
    payload = _load_session_payload(session_id)
    if payload is None:
        return None, {"auth_mode": None, "app_login": None, "app_role": "full"}
    return _auth_from_payload(payload), _session_meta_from_payload(payload)


def delete_session(session_id: str | None) -> None:
    if not session_id:
        return
    db = SessionLocal()
    try:
        db.execute(delete(AuthSession).where(AuthSession.id == session_id))
        db.commit()
    finally:
        db.close()
