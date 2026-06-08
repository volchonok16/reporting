import json
from dataclasses import dataclass

from app.config import settings


@dataclass(frozen=True)
class TfsAuth:
    base_url: str
    project: str
    project_id: str | None = None
    pat: str | None = None
    cookie: str | None = None
    extra_headers: dict[str, str] | None = None

    def has_credentials(self) -> bool:
        return bool(self.pat or self.cookie or self.extra_headers)


def parse_extra_headers(raw: str | dict[str, str] | None) -> dict[str, str] | None:
    if not raw:
        return None
    if isinstance(raw, dict):
        return {str(key): str(value) for key, value in raw.items()}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("extraHeaders must be a JSON object") from exc
    if not isinstance(parsed, dict):
        raise ValueError("extraHeaders must be a JSON object")
    return {str(key): str(value) for key, value in parsed.items()}


def build_tfs_auth(
    *,
    base_url: str | None = None,
    project: str | None = None,
    project_id: str | None = None,
    pat: str | None = None,
    cookie: str | None = None,
    extra_headers: str | dict[str, str] | None = None,
) -> TfsAuth:
    resolved_project = (project or "").strip()
    if not resolved_project:
        raise ValueError("project is required")

    return TfsAuth(
        base_url=(base_url or settings.tfs_base_url).rstrip("/"),
        project=resolved_project,
        project_id=(project_id or "").strip() or None,
        pat=(pat or "").strip() or None,
        cookie=(cookie or "").strip() or None,
        extra_headers=parse_extra_headers(extra_headers),
    )
