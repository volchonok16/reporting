"""SSO и сессии Voice: общий секрет VOICE_SSO_SECRET с reporting."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time


def _secret() -> bytes:
    raw = (
        os.getenv("VOICE_SSO_SECRET")
        or os.getenv("CAROUSEL_REPORTING_SSO_SECRET")
        or "reporting-voice-sso-dev-secret"
    )
    return raw.encode("utf-8")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _verify_signed_token(token: str) -> dict:
    try:
        body, signature = token.strip().split(".", 1)
    except ValueError as exc:
        raise ValueError("Некорректный токен") from exc
    expected = _b64url_encode(
        hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(expected, signature):
        raise ValueError("Подпись токена недействительна")
    payload = json.loads(_b64url_decode(body).decode("utf-8"))
    if int(payload.get("exp") or 0) < int(time.time()):
        raise ValueError("Токен истёк")
    email = str(payload.get("email") or "").strip().lower()
    if not email or "@" not in email:
        raise ValueError("В токене нет email")
    return payload


def verify_reporting_sso_token(token: str) -> dict:
    """Короткий SSO-токен от reporting (/api/voice/sso-token)."""
    payload = _verify_signed_token(token)
    if payload.get("kind") == "session":
        raise ValueError("Ожидался SSO-токен reporting, не сессия Voice")
    return {
        "email": str(payload["email"]),
        "admin": bool(payload.get("admin")),
        "voiceAdmin": bool(payload.get("voiceAdmin")),
        "name": payload.get("name"),
    }


def issue_voice_session_token(
    *,
    email: str,
    is_admin: bool,
    voice_admin: bool = False,
    ttl_seconds: int,
) -> tuple[str, float]:
    """Долгоживущая bearer-сессия Voice после обмена SSO."""
    now = int(time.time())
    expires_at = float(now + max(300, ttl_seconds))
    payload = {
        "v": 1,
        "kind": "session",
        "email": email.strip().lower(),
        "admin": bool(is_admin),
        "voiceAdmin": bool(voice_admin),
        "iat": now,
        "exp": int(expires_at),
    }
    body = _b64url_encode(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )
    signature = _b64url_encode(
        hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).digest()
    )
    return f"{body}.{signature}", expires_at


def verify_voice_session_token(token: str) -> dict:
    """Проверка bearer-сессии Voice API."""
    payload = _verify_signed_token(token)
    if payload.get("kind") != "session":
        raise ValueError("Ожидалась сессия Voice")
    return {
        "email": str(payload["email"]),
        "admin": bool(payload.get("admin")),
        "voiceAdmin": bool(payload.get("voiceAdmin")),
        "exp": float(payload.get("exp") or 0),
    }


def user_id_for_email(email: str) -> str:
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()[:32]
