"""Проверка SSO-токена reporting (общий секрет VOICE_SSO_SECRET)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def verify_reporting_sso_token(token: str) -> dict:
    secret = (
        os.getenv("VOICE_SSO_SECRET")
        or os.getenv("CAROUSEL_REPORTING_SSO_SECRET")
        or "reporting-voice-sso-dev-secret"
    ).encode("utf-8")
    try:
        body, signature = token.strip().split(".", 1)
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
        "name": payload.get("name"),
    }
