from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.tfs_auth import TfsAuth


def build_http_auth(auth: TfsAuth) -> Any | None:
    if auth.pat:
        return ("", auth.pat)
    return None


@dataclass(frozen=True)
class AuthAttempt:
    label: str
    auth: TfsAuth


def auth_attempts(auth: TfsAuth) -> list[AuthAttempt]:
    if auth.pat:
        return [AuthAttempt("PAT", auth)]
    if auth.cookie:
        return [AuthAttempt("Cookie", auth)]
    if auth.extra_headers:
        return [AuthAttempt("Headers", auth)]
    return []
