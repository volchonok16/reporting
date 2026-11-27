from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.api.schemas import LogoutState, SessionState
from app.auth.accounts import PASSWORD_MAX_LENGTH, new_session, set_session_cookie, token_digest, verify_password, local_operator
from app.auth.policy import check_mutation
from app.db import get_db
from app.errors import ApiError
from app.models import Session, User, utcnow

router = APIRouter(prefix="/api/session", tags=["session"])
authenticated_router = APIRouter(prefix='/api/session', tags=['session'])


class LoginBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=PASSWORD_MAX_LENGTH, repr=False)


def session_view(session, user=None):
    return {"authenticated": bool(user), "csrf_token": session.csrf_token,
            "expires_at": session.expires_at.isoformat(),
            "user": {"id": str(user.id), "username": user.username, "permissions": user.permissions} if user else None}


@router.get("", response_model=SessionState)
def get_session(request: Request, response: Response, db=Depends(get_db)):
    settings = request.app.state.settings
    token = request.cookies.get(settings.cookie_name)
    session = db.scalar(select(Session).where(Session.token_digest == token_digest(token))) if token else None
    if settings.local_access:
        user = local_operator(db)
        if not session or session.revoked_at or session.expires_at <= utcnow() or session.user_id != user.id:
            session, token = new_session(db, settings, user.id)
            db.commit()
            set_session_cookie(response, token, settings, request.url.scheme == 'https', True)
        response.headers['Cache-Control'] = 'no-store'
        return session_view(session, user)
    if session and (session.revoked_at or session.expires_at <= utcnow()):
        raise ApiError(401, "session_expired", "Сессия завершена. Войдите снова.")
    if not session:
        session, token = new_session(db, settings)
        db.commit()
        set_session_cookie(response, token, settings, request.url.scheme == "https", False)
    user = db.get(User, session.user_id) if session.user_id else None
    if user and not user.active:
        raise ApiError(401, "authentication_required", "Учётная запись недоступна.")
    response.headers["Cache-Control"] = "no-store"
    return session_view(session, user)


@authenticated_router.post("/login", response_model=SessionState)
def login(body: LoginBody, request: Request, response: Response, challenge=Depends(check_mutation),
          db=Depends(get_db)):
    user = db.scalar(select(User).where(User.username == body.username))
    if not verify_password(user, body.password):
        raise ApiError(401, "invalid_credentials", "Имя или пароль неверны.")
    challenge.revoked_at = utcnow()
    session, token = new_session(db, request.app.state.settings, user.id)
    db.commit()
    set_session_cookie(response, token, request.app.state.settings, request.url.scheme == "https", True)
    response.headers["Cache-Control"] = "no-store"
    return session_view(session, user)


@authenticated_router.post("/logout", response_model=LogoutState)
def logout(request: Request, response: Response, session=Depends(check_mutation), db=Depends(get_db)):
    session.revoked_at = utcnow()
    db.commit()
    response.delete_cookie(request.app.state.settings.cookie_name, httponly=True, samesite="strict",
                           secure=request.url.scheme == "https", path="/")
    return {"authenticated": False}
