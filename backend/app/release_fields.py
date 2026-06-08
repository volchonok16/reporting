"""Плановый релиз из полей TFS (Плановый релиз / Logrocon.Release)."""
from __future__ import annotations

import re
from typing import Any

RELEASE_LABEL_RE = re.compile(r"\b(20\d{2}\.\d{2}\.\d{2}\.\d+-R)\b")

PLANNED_RELEASE_FIELD_KEYS = (
    "Logrocon.FoundinRelease",
    "Custom.FieldInRelease",
    "FieldInRelease",
    "Logrocon.Release",
    "Microsoft.VSTS.Scheduling.Plannedreleasedate",
)


def release_label_from_text(text: str | None) -> str | None:
    if not text:
        return None
    match = RELEASE_LABEL_RE.search(str(text).strip())
    return match.group(1) if match else None


def _field_text(fields: dict[str, Any], key: str) -> str | None:
    value = fields.get(key)
    if value in (None, ""):
        return None
    text = str(value).strip()
    return text or None


def work_item_planned_release(fields: dict[str, Any] | None) -> str | None:
    """Плановый релиз, если проставлен в форме ЗНИ или привязан через Logrocon.Release."""
    if not fields:
        return None

    for key in PLANNED_RELEASE_FIELD_KEYS:
        text = _field_text(fields, key)
        if not text:
            continue
        dated = release_label_from_text(text)
        if dated:
            return dated
        if key in {"Logrocon.FoundinRelease", "Logrocon.Release", "FieldInRelease", "Custom.FieldInRelease"}:
            return text

    for key, value in fields.items():
        key_lower = str(key).lower()
        if "inrelease" not in key_lower and not key_lower.endswith("release"):
            continue
        text = str(value).strip() if value not in (None, "") else ""
        if not text:
            continue
        dated = release_label_from_text(text)
        return dated or text

    return None
