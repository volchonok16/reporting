"""SSO-токен для вкладки Симметрика: один логин reporting → сессия canvas-studio."""

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


def issue_canvas_studio_sso_token(
    *,
    email: str,
    display_name: str | None = None,
    is_admin: bool = False,
    ttl_seconds: int = 120,
) -> str:
    secret = settings.canvas_studio_sso_secret.encode("utf-8")
    now = int(time.time())
    payload = {
        "v": 1,
        "email": email.strip().lower(),
        "name": (display_name or "").strip() or None,
        "admin": bool(is_admin),
        "iat": now,
        "exp": now + max(30, ttl_seconds),
    }
    body = _b64url_encode(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )
    signature = _b64url_encode(hmac.new(secret, body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{signature}"


def verify_canvas_studio_sso_token(token: str) -> dict:
    secret = settings.canvas_studio_sso_secret.encode("utf-8")
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
        "name": payload.get("name"),
        "admin": bool(payload.get("admin")),
    }
