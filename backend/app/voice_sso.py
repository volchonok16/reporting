"""SSO-токен для вкладки Voice: один логин reporting → сессия карусели."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

from app.config import settings


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def issue_voice_sso_token(
    *,
    email: str,
    is_admin: bool,
    voice_admin: bool = False,
    display_name: str | None = None,
    ttl_seconds: int = 120,
) -> str:
    """Подписанный короткий токен для обмена на сессию Voice."""
    secret = settings.voice_sso_secret.encode("utf-8")
    now = int(time.time())
    payload = {
        "v": 1,
        "email": email.strip().lower(),
        "admin": bool(is_admin),
        "voiceAdmin": bool(voice_admin),
        "name": (display_name or "").strip() or None,
        "iat": now,
        "exp": now + max(30, ttl_seconds),
    }
    body = _b64url_encode(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )
    signature = _b64url_encode(hmac.new(secret, body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{signature}"


def verify_voice_sso_token(token: str) -> dict:
    """Проверка токена (используется Voice API с тем же секретом)."""
    secret = settings.voice_sso_secret.encode("utf-8")
    try:
        body, signature = token.split(".", 1)
    except ValueError as exc:
        raise ValueError("Некорректный SSO-токен") from exc
    expected = _b64url_encode(hmac.new(secret, body.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, signature):
        raise ValueError("Подпись SSO-токена недействительна")
    payload = json.loads(_b64url_decode(body).decode("utf-8"))
    if int(payload.get("exp") or 0) < int(time.time()):
        raise ValueError("SSO-токен истёк")
    email = str(payload.get("email") or "").strip().lower()
    if not email or "@" not in email:
        raise ValueError("В SSO-токене нет email")
    return {
        "email": email,
        "admin": bool(payload.get("admin")),
        "voiceAdmin": bool(payload.get("voiceAdmin")),
        "name": payload.get("name"),
    }
