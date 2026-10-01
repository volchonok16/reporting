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
    org_user_id: int | None = None,
    org_user_role: str | None = None,
    voice_only: bool = False,
    voice_admin: bool = False,
) -> dict:
    payload = {
        "base_url": auth.base_url,
        "project": auth.project,
        "project_id": auth.project_id,
        "pat": auth.pat,
        "cookie": auth.cookie,
        "extra_headers": auth.extra_headers,
        "auth_mode": auth_mode,
        "app_login": app_login,
        "app_role": app_role,
        "voice_only": bool(voice_only),
        "voice_admin": bool(voice_admin),
    }
    if org_user_id is not None:
        payload["org_user_id"] = org_user_id
    if org_user_role is not None:
        payload["org_user_role"] = org_user_role
    return payload


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


def _session_meta_from_payload(payload: dict) -> dict:
    from app.app_access import normalize_app_role

    auth_mode = payload.get("auth_mode")
    app_login = payload.get("app_login")
    app_role = payload.get("app_role")
    org_user_id = payload.get("org_user_id")
    org_user_role = payload.get("org_user_role")
    return {
        "auth_mode": str(auth_mode) if auth_mode else None,
        "app_login": str(app_login) if app_login else None,
        "app_role": normalize_app_role(str(app_role) if app_role else None),
        "org_user_id": str(org_user_id) if org_user_id is not None else None,
        "org_user_role": str(org_user_role) if org_user_role else None,
        "voice_only": bool(payload.get("voice_only")),
        "voice_admin": bool(payload.get("voice_admin")),
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
    org_user_id: int | None = None,
    org_user_role: str | None = None,
    voice_only: bool = False,
    voice_admin: bool = False,
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
                    org_user_id=org_user_id,
                    org_user_role=org_user_role,
                    voice_only=voice_only,
                    voice_admin=voice_admin,
                ),
            )
        )
        db.commit()
    finally:
        db.close()
    return session_id


def _empty_session_meta() -> dict:
    return {
        "auth_mode": None,
        "app_login": None,
        "app_role": "full",
        "org_user_id": None,
        "org_user_role": None,
        "voice_only": False,
        "voice_admin": False,
    }


def _resolve_org_user_role_label(role: int | None) -> str | None:
    from app.org_models import ORG_USER_ROLE_ADMIN, ORG_USER_ROLE_SUPERADMIN

    if role == ORG_USER_ROLE_SUPERADMIN:
        return "superadmin"
    if role == ORG_USER_ROLE_ADMIN:
        return "admin"
    if role is None:
        return None
    return "user"


def _refresh_org_user_flags(payload: dict) -> dict:
    """Подтягивает role / voice_* из БД, чтобы смена роли без повторного логина работала."""
    org_user_id = payload.get("org_user_id")
    if org_user_id is None:
        return payload
    try:
        user_id = int(org_user_id)
    except (TypeError, ValueError):
        return payload

    db = SessionLocal()
    try:
        from app.org_models import OrgUser

        org_user = db.get(OrgUser, user_id)
        if org_user is None:
            return payload
        role_label = _resolve_org_user_role_label(int(org_user.role))
        voice_only = bool(getattr(org_user, "voice_only", False))
        voice_admin = bool(getattr(org_user, "voice_admin", False))
        if (
            payload.get("org_user_role") == role_label
            and bool(payload.get("voice_only")) == voice_only
            and bool(payload.get("voice_admin")) == voice_admin
        ):
            return payload
        next_payload = dict(payload)
        next_payload["org_user_role"] = role_label
        next_payload["voice_only"] = voice_only
        next_payload["voice_admin"] = voice_admin
        return next_payload
    finally:
        db.close()


def _persist_session_payload(session_id: str, payload: dict) -> None:
    db = SessionLocal()
    try:
        row = db.get(AuthSession, session_id)
        if row is None:
            return
        row.payload = payload
        db.commit()
    finally:
        db.close()


def get_session_with_meta(session_id: str | None) -> tuple[TfsAuth | None, dict]:
    payload = _load_session_payload(session_id)
    if payload is None:
        return None, _empty_session_meta()
    refreshed = _refresh_org_user_flags(payload)
    if refreshed is not payload and session_id:
        try:
            _persist_session_payload(session_id, refreshed)
        except Exception:
            # Не блокируем запрос, если не удалось записать обновлённую сессию.
            pass
    return _auth_from_payload(refreshed), _session_meta_from_payload(refreshed)


def get_session_meta(session_id: str | None) -> dict:
    _, meta = get_session_with_meta(session_id)
    return meta


def get_session(session_id: str | None) -> TfsAuth | None:
    auth, _ = get_session_with_meta(session_id)
    return auth


def delete_session(session_id: str | None) -> None:
    if not session_id:
        return
    db = SessionLocal()
    try:
        db.execute(delete(AuthSession).where(AuthSession.id == session_id))
        db.commit()
    finally:
        db.close()
