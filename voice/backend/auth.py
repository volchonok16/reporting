from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any

from .config import Settings
from .errors import AppError
from .reporting_sso import (
    issue_voice_session_token,
    user_id_for_email,
    verify_voice_session_token,
)


EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@dataclass(frozen=True, slots=True)
class AuthUser:
    id: str
    email: str
    role: str
    can_access_master: bool
    is_active: bool
    is_voice_admin: bool = False

    @property
    def is_superuser(self) -> bool:
        return self.role == "superuser"

    def payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "email": self.email,
            "role": self.role,
            "canAccessMaster": self.is_superuser or self.can_access_master,
            "voiceAdmin": self.is_voice_admin,
            "isActive": self.is_active,
        }


def _normalize_email(value: str) -> str:
    email = value.strip().lower()
    if not EMAIL_PATTERN.fullmatch(email):
        raise AppError("INVALID_EMAIL", "Укажите корректную почту")
    return email


def _user_from_claims(
    *,
    email: str,
    is_admin: bool,
    voice_admin: bool = False,
) -> AuthUser:
    normalized = _normalize_email(email)
    return AuthUser(
        id=user_id_for_email(normalized),
        email=normalized,
        role="superuser" if is_admin else "standard",
        can_access_master=True,
        is_active=True,
        is_voice_admin=bool(voice_admin),
    )


class AuthService:
    """Auth только через reporting SSO; отдельных учёток Voice нет."""

    def __init__(self, config: Settings):
        self.config = config

    def login_with_reporting_sso(
        self,
        *,
        email: str,
        is_admin: bool,
        voice_admin: bool = False,
    ) -> dict[str, Any]:
        user = _user_from_claims(
            email=email,
            is_admin=is_admin,
            voice_admin=voice_admin,
        )
        token, expires_at = issue_voice_session_token(
            email=user.email,
            is_admin=is_admin,
            voice_admin=voice_admin,
            ttl_seconds=self.config.auth_session_seconds,
        )
        return {
            "token": token,
            "expiresAt": expires_at,
            "user": user.payload(),
        }

    def authenticate(self, token: str | None) -> AuthUser:
        if not token:
            raise AppError(
                "AUTH_REQUIRED",
                "Необходимо войти в приложение",
                status_code=401,
            )
        try:
            claims = verify_voice_session_token(token)
        except ValueError as exc:
            raise AppError(
                "AUTH_REQUIRED",
                "Сессия истекла. Войдите снова",
                status_code=401,
            ) from exc
        return _user_from_claims(
            email=str(claims["email"]),
            is_admin=bool(claims["admin"]),
            voice_admin=bool(claims.get("voiceAdmin")),
        )

    def session_expires_at(self, token: str) -> float | None:
        try:
            claims = verify_voice_session_token(token)
        except ValueError:
            return None
        return float(claims.get("exp") or 0) or None

    def logout(self, token: str) -> None:
        del token  # stateless — клиент удаляет bearer
