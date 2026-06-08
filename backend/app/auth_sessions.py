import secrets

from sqlalchemy import delete

from app.db import SessionLocal
from app.models import AuthSession
from app.tfs_auth import TfsAuth


def _auth_to_payload(auth: TfsAuth) -> dict:
    return {
        "base_url": auth.base_url,
        "project": auth.project,
        "project_id": auth.project_id,
        "pat": auth.pat,
        "cookie": auth.cookie,
        "extra_headers": auth.extra_headers,
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


def create_session(auth: TfsAuth) -> str:
    session_id = secrets.token_urlsafe(32)
    db = SessionLocal()
    try:
        db.add(AuthSession(id=session_id, payload=_auth_to_payload(auth)))
        db.commit()
    finally:
        db.close()
    return session_id


def get_session(session_id: str | None) -> TfsAuth | None:
    if not session_id:
        return None
    db = SessionLocal()
    try:
        row = db.get(AuthSession, session_id)
        if row is None or not isinstance(row.payload, dict):
            return None
        return _auth_from_payload(row.payload)
    finally:
        db.close()


def delete_session(session_id: str | None) -> None:
    if not session_id:
        return
    db = SessionLocal()
    try:
        db.execute(delete(AuthSession).where(AuthSession.id == session_id))
        db.commit()
    finally:
        db.close()
