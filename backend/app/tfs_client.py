import asyncio
import logging
import re
import time
from collections.abc import Callable, Iterable
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from dateutil.parser import parse as parse_datetime

from app.config import settings
from app.http_auth import build_http_auth
from app.json_utils import as_list, as_work_item_list
from app.tfs_auth import TfsAuth
from app.zni_title_filters import ZNI_TITLE_EXCLUDE_PATTERNS

logger = logging.getLogger(__name__)

# Лимит Azure DevOps / TFS на workItemsBatch
WIT_BATCH_MAX_IDS = 200

BUSINESS_VALUE_FIELD = "Microsoft.VSTS.Common.BusinessValue"


def build_business_value_patch(value: int | None) -> list[dict[str, Any]]:
    path = f"/fields/{BUSINESS_VALUE_FIELD}"
    if value is None:
        return [{"op": "remove", "path": path}]
    return [{"op": "add", "path": path, "value": value}]

MS_DATE_RE = re.compile(r"^/Date\((?P<milliseconds>-?\d+)(?:[+-]\d+)?\)/$")
TFS_CALENDAR_TZ = ZoneInfo("Europe/Moscow")


def parse_tfs_date(value: Any) -> date | None:
    if not value:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str):
        match = MS_DATE_RE.match(value)
        if match:
            return datetime.fromtimestamp(int(match.group("milliseconds")) / 1000, UTC).date()
        return parse_datetime(value, dayfirst=True).date()
    return None


def parse_tfs_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=UTC)
    if isinstance(value, str):
        text = value.strip()
        if "T" in text:
            try:
                return datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                pass
        match = MS_DATE_RE.match(text)
        if match:
            return datetime.fromtimestamp(int(match.group("milliseconds")) / 1000, UTC)
        parsed = parse_datetime(text, dayfirst=True)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None


def parse_tfs_calendar_date(value: Any) -> date | None:
    parsed = parse_tfs_datetime(value)
    if parsed:
        return parsed.astimezone(TFS_CALENDAR_TZ).date()
    return parse_tfs_date(value)


def date_from_field_list(fields: dict[str, Any], names: Iterable[str]) -> date | None:
    for name in names:
        value = fields.get(name)
        if value in (None, ""):
            continue
        if name.startswith("Microsoft.VSTS.Scheduling.") or (
            isinstance(value, str) and "T" in value and value.endswith("Z")
        ):
            parsed = parse_tfs_calendar_date(value)
        else:
            parsed = parse_tfs_date(value)
        if parsed:
            return parsed
    return None


def wiql_escape(value: str) -> str:
    return value.replace("'", "''")


def wiql_quote(value: str) -> str:
    return f"'{wiql_escape(value)}'"


def wiql_tags_clause(tags: Iterable[str] | None, *, field: str = "[System.Tags]") -> str:
    values = [tag.strip() for tag in (tags or []) if tag and tag.strip()]
    if not values:
        return ""
    parts = [f"{field} CONTAINS {wiql_quote(tag)}" for tag in values]
    if len(parts) == 1:
        return f" AND {parts[0]}"
    return " AND (" + " OR ".join(parts) + ")"


def wiql_exclude_tags_clause(
    tags: Iterable[str] | None,
    *,
    field: str = "[System.Tags]",
) -> str:
    values = [tag.strip() for tag in (tags or []) if tag and tag.strip()]
    if not values:
        return ""
    parts = [f"{field} NOT CONTAINS {wiql_quote(tag)}" for tag in values]
    if len(parts) == 1:
        return f" AND {parts[0]}"
    return " AND (" + " AND ".join(parts) + ")"


def wiql_exclude_states_clause(
    states: Iterable[str] | None,
    *,
    field: str = "[System.State]",
) -> str:
    values = [state.strip() for state in (states or []) if state and state.strip()]
    if not values:
        return ""
    parts = [f"{field} <> {wiql_quote(state)}" for state in values]
    if len(parts) == 1:
        return f" AND {parts[0]}"
    return " AND (" + " AND ".join(parts) + ")"


def wiql_exclude_title_patterns_clause(
    patterns: Iterable[str] | None,
    *,
    field: str = "[System.Title]",
) -> str:
    values = [pattern.strip() for pattern in (patterns or []) if pattern and pattern.strip()]
    if not values:
        return ""
    parts = [f"{field} NOT CONTAINS {wiql_quote(pattern)}" for pattern in values]
    if len(parts) == 1:
        return f" AND {parts[0]}"
    return " AND (" + " AND ".join(parts) + ")"


def wiql_date(value: date) -> str:
    return wiql_quote(value.isoformat())


def wit_api_field_names(names: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for name in names:
        candidate = name.strip()
        if not candidate or candidate in seen:
            continue
        if candidate.isdigit() or "." not in candidate:
            continue
        seen.add(candidate)
        result.append(candidate)
    return result


def _dedupe_api_versions(versions: Iterable[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    result: list[str] = []
    for version in versions:
        version = version.strip()
        if not version or version in seen:
            continue
        seen.add(version)
        result.append(version)
    return tuple(result)


def _api_version_candidates(preferred: str | None = None) -> tuple[str, ...]:
    ordered = (preferred or settings.tfs_api_version, "6.1", "6.0", "5.1")
    return _dedupe_api_versions(ordered)


def _wit_batch_api_version_candidates(preferred: str | None = None) -> tuple[str, ...]:
    base = (preferred or settings.tfs_api_version).strip()
    ordered: list[str] = []
    if base:
        ordered.append(base)
        if "preview" not in base.lower():
            root = base.split("-", 1)[0]
            if re.fullmatch(r"\d+\.\d+", root):
                ordered.append(f"{root}-preview")
                ordered.append(f"{root}-preview.1")
    ordered.extend(["6.1-preview", "6.1-preview.1", "6.0-preview", "6.0", "5.1"])
    return _dedupe_api_versions(ordered)


class TfsClient:
    def __init__(self, tfs_auth: TfsAuth) -> None:
        if not tfs_auth.has_credentials():
            raise ValueError("TFS credentials are not configured.")

        headers = {"Accept": "application/json"}
        http_auth = build_http_auth(tfs_auth)
        if tfs_auth.cookie:
            headers["Cookie"] = tfs_auth.cookie
        if tfs_auth.extra_headers:
            headers.update(tfs_auth.extra_headers)

        self.tfs_auth = tfs_auth
        self.project = tfs_auth.project
        self.project_id = tfs_auth.project_id
        self.base_url = tfs_auth.base_url

        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            auth=http_auth,
            headers=headers,
            timeout=settings.tfs_timeout_seconds,
            verify=settings.tfs_verify_tls,
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def run_wiql(self, query: str) -> dict[str, Any]:
        normalized = " ".join(line.strip() for line in query.strip().splitlines())
        last_response: httpx.Response | None = None
        for api_version in _api_version_candidates():
            response = await self.client.post(
                f"/{self.project}/_apis/wit/wiql",
                params={"api-version": api_version},
                json={"query": normalized},
            )
            last_response = response
            if response.status_code == 200:
                body = response.json()
                return body if isinstance(body, dict) else {}
            if response.status_code == 400 and "out of range" in response.text.lower():
                continue
        if last_response is not None:
            last_response.raise_for_status()
        raise httpx.HTTPError("WIQL request failed without response")

    async def get_change_request_ids(
        self,
        *,
        area_path: str | None = None,
        tags: Iterable[str] | None = None,
        exclude_tags: Iterable[str] | None = None,
        exclude_states: Iterable[str] | None = None,
        exclude_title_patterns: Iterable[str] | None = ZNI_TITLE_EXCLUDE_PATTERNS,
        limit_results: bool = True,
    ) -> list[int]:
        types = ", ".join(wiql_quote(item) for item in settings.change_type_list)
        project = wiql_quote(self.project)
        states = settings.change_request_state_list
        state_clause = ""
        if states:
            state_values = ", ".join(wiql_quote(state) for state in states)
            state_clause = f" AND [System.State] IN ({state_values})"
        area_clause = ""
        if area_path:
            area_clause = f" AND [System.AreaPath] UNDER {wiql_quote(area_path)}"
        tags_clause = wiql_tags_clause(tags)
        exclude_tags_clause = wiql_exclude_tags_clause(exclude_tags)
        exclude_states_clause = wiql_exclude_states_clause(exclude_states)
        exclude_title_clause = wiql_exclude_title_patterns_clause(exclude_title_patterns)

        closed_exclude_clause = ""
        if settings.closed_state_list and settings.tfs_exclude_closed_older_than_days > 0:
            closed_states = ", ".join(wiql_quote(state) for state in settings.closed_state_list)
            cutoff = date.today() - timedelta(days=settings.tfs_exclude_closed_older_than_days)
            closed_exclude_clause = (
                f" AND ([System.State] NOT IN ({closed_states})"
                f" OR [System.ChangedDate] >= {wiql_date(cutoff)})"
            )

        queries = [
            (
                f"SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = {project} "
                f"AND [System.WorkItemType] IN ({types}){state_clause}{area_clause}{tags_clause}"
                f"{exclude_tags_clause}{exclude_states_clause}{exclude_title_clause}{closed_exclude_clause} "
                f"ORDER BY [System.ChangedDate] DESC"
            ),
            (
                f"SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = {project} "
                f"AND [System.WorkItemType] IN ({types}){area_clause}{tags_clause}"
                f"{exclude_tags_clause}{exclude_states_clause}{exclude_title_clause}{closed_exclude_clause} "
                f"ORDER BY [System.ChangedDate] DESC"
            ),
        ]

        last_exc: Exception | None = None
        for query in queries:
            try:
                payload = await self.run_wiql(query)
                ids = [item["id"] for item in as_list(payload.get("workItems")) if isinstance(item, dict)]
                if limit_results and len(ids) > settings.tfs_wiql_max_results:
                    return ids[: settings.tfs_wiql_max_results]
                return ids
            except httpx.HTTPStatusError as exc:
                last_exc = exc
                if exc.response.status_code != 400:
                    raise

        if last_exc:
            raise last_exc
        return []

    def _batch_field_list(self) -> list[str]:
        return wit_api_field_names(
            [
                "System.Id",
                "System.Title",
                "System.WorkItemType",
                "System.State",
                "System.AreaPath",
                "System.CreatedDate",
                "System.ChangedDate",
                "System.AssignedTo",
                "System.TeamProject",
                "System.BoardColumn",
                "System.IterationPath",
                "System.Tags",
                "System.Description",
                "Logrocon.PO",
                "Logrocon.FoundinRelease",
                "Logrocon.Release",
                "Microsoft.VSTS.Scheduling.Plannedreleasedate",
                "Microsoft.VSTS.Common.ClosedDate",
                "Microsoft.VSTS.Common.Severity",
                "Microsoft.VSTS.Common.Triage",
                "Microsoft.VSTS.Common.BusinessValue",
                *settings.scheduling_batch_field_list,
            ]
        )

    async def get_error_ids_for_area(
        self,
        area_path: str,
        *,
        tags: Iterable[str] | None = None,
        exclude_tags: Iterable[str] | None = None,
        limit_results: bool = True,
    ) -> list[int]:
        error_types = ", ".join(wiql_quote(item) for item in settings.error_type_list)
        project = wiql_quote(self.project)
        area_clause = f" AND [System.AreaPath] UNDER {wiql_quote(area_path)}"
        tags_clause = wiql_tags_clause(tags)
        exclude_tags_clause = wiql_exclude_tags_clause(exclude_tags)
        query = (
            f"SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = {project} "
            f"AND [System.WorkItemType] IN ({error_types}){area_clause}{tags_clause}"
            f"{exclude_tags_clause} "
            f"ORDER BY [System.ChangedDate] DESC"
        )
        payload = await self.run_wiql(query)
        ids = [item["id"] for item in as_list(payload.get("workItems")) if isinstance(item, dict)]
        if limit_results and len(ids) > settings.tfs_wiql_max_results:
            return ids[: settings.tfs_wiql_max_results]
        return ids

    async def get_error_links_for_area(
        self,
        area_path: str,
        *,
        zni_tags: Iterable[str] | None = None,
        error_tags: Iterable[str] | None = None,
        exclude_zni_states: Iterable[str] | None = None,
        exclude_zni_tags: Iterable[str] | None = None,
        exclude_error_tags: Iterable[str] | None = None,
    ) -> dict[int, int]:
        """error_id -> zni_id через один WIQL вместо Relations на каждом ЗНИ."""
        types = ", ".join(wiql_quote(item) for item in settings.change_type_list)
        error_types = ", ".join(wiql_quote(item) for item in settings.error_type_list)
        project = wiql_quote(self.project)
        area = wiql_quote(area_path)
        zni_tags_clause = wiql_tags_clause(zni_tags, field="[Source].[System.Tags]")
        error_tags_clause = wiql_tags_clause(error_tags, field="[Target].[System.Tags]")
        exclude_zni_states_clause = wiql_exclude_states_clause(
            exclude_zni_states,
            field="[Source].[System.State]",
        )
        exclude_zni_tags_clause = wiql_exclude_tags_clause(
            exclude_zni_tags,
            field="[Source].[System.Tags]",
        )
        exclude_error_tags_clause = wiql_exclude_tags_clause(
            exclude_error_tags,
            field="[Target].[System.Tags]",
        )
        query = (
            f"SELECT [System.Id] FROM WorkItemLinks "
            f"WHERE [Source].[System.TeamProject] = {project} "
            f"AND [Source].[System.WorkItemType] IN ({types}) "
            f"AND [Source].[System.AreaPath] UNDER {area}{zni_tags_clause}"
            f"{exclude_zni_states_clause}{exclude_zni_tags_clause} "
            f"AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward' "
            f"AND [Target].[System.WorkItemType] IN ({error_types})"
            f"{error_tags_clause}{exclude_error_tags_clause} "
            f"MODE (MustContain)"
        )
        payload = await self.run_wiql(query)
        result: dict[int, int] = {}
        for rel in as_list(payload.get("workItemRelations")):
            if not isinstance(rel, dict):
                continue
            source = rel.get("source")
            target = rel.get("target")
            if not isinstance(source, dict) or not isinstance(target, dict):
                continue
            try:
                zni_id = int(source["id"])
                error_id = int(target["id"])
                result[error_id] = zni_id
            except (KeyError, TypeError, ValueError):
                continue
        return result

    @staticmethod
    def _work_item_link_pairs(payload: dict[str, Any]) -> list[tuple[int, int]]:
        result: list[tuple[int, int]] = []
        for rel in as_list(payload.get("workItemRelations")):
            if not isinstance(rel, dict):
                continue
            source = rel.get("source")
            target = rel.get("target")
            if not isinstance(source, dict) or not isinstance(target, dict):
                continue
            try:
                source_id = int(source["id"])
                target_id = int(target["id"])
            except (KeyError, TypeError, ValueError):
                continue
            result.append((source_id, target_id))
        return result

    def _zni_area_link_clauses(
        self,
        *,
        side: str,
        area_path: str,
        zni_tags: Iterable[str] | None,
        exclude_zni_states: Iterable[str] | None,
        exclude_zni_tags: Iterable[str] | None,
    ) -> str:
        types = ", ".join(wiql_quote(item) for item in settings.change_type_list)
        project = wiql_quote(self.project)
        area = wiql_quote(area_path)
        tags_clause = wiql_tags_clause(zni_tags, field=f"[{side}].[System.Tags]")
        exclude_states_clause = wiql_exclude_states_clause(
            exclude_zni_states,
            field=f"[{side}].[System.State]",
        )
        exclude_tags_clause = wiql_exclude_tags_clause(
            exclude_zni_tags,
            field=f"[{side}].[System.Tags]",
        )
        return (
            f"[{side}].[System.TeamProject] = {project} "
            f"AND [{side}].[System.WorkItemType] IN ({types}) "
            f"AND [{side}].[System.AreaPath] UNDER {area}{tags_clause}"
            f"{exclude_states_clause}{exclude_tags_clause}"
        )

    async def get_zni_resource_reservation_links(
        self,
        area_path: str,
        *,
        zni_tags: Iterable[str] | None = None,
        exclude_zni_states: Iterable[str] | None = None,
        exclude_zni_tags: Iterable[str] | None = None,
    ) -> set[int]:
        """ID ЗНИ с Related на тип «Бронь ресурсов» (прямая связь, оба направления WIQL)."""
        reservation_types = settings.resource_reservation_type_list
        if not reservation_types:
            return set()

        reservation = ", ".join(wiql_quote(item) for item in reservation_types)
        source_clause = self._zni_area_link_clauses(
            side="Source",
            area_path=area_path,
            zni_tags=zni_tags,
            exclude_zni_states=exclude_zni_states,
            exclude_zni_tags=exclude_zni_tags,
        )
        target_clause = self._zni_area_link_clauses(
            side="Target",
            area_path=area_path,
            zni_tags=zni_tags,
            exclude_zni_states=exclude_zni_states,
            exclude_zni_tags=exclude_zni_tags,
        )
        forward_query = (
            f"SELECT [System.Id] FROM WorkItemLinks "
            f"WHERE {source_clause} "
            f"AND [System.Links.LinkType] = 'System.LinkTypes.Related' "
            f"AND [Target].[System.WorkItemType] IN ({reservation}) "
            f"MODE (MustContain)"
        )
        reverse_query = (
            f"SELECT [System.Id] FROM WorkItemLinks "
            f"WHERE [Source].[System.WorkItemType] IN ({reservation}) "
            f"AND [System.Links.LinkType] = 'System.LinkTypes.Related' "
            f"AND {target_clause} "
            f"MODE (MustContain)"
        )

        result: set[int] = set()
        forward_payload = await self.run_wiql(forward_query)
        for source_id, _target_id in self._work_item_link_pairs(forward_payload):
            result.add(source_id)
        reverse_payload = await self.run_wiql(reverse_query)
        for _source_id, target_id in self._work_item_link_pairs(reverse_payload):
            result.add(target_id)
        return result

    async def _fetch_work_items_chunk(
        self,
        ids: list[int],
        *,
        fields: list[str] | None,
        with_relations: bool,
    ) -> list[dict[str, Any]]:
        if not ids:
            return []

        body: dict[str, Any] = {"ids": ids, "errorPolicy": "omit"}
        if with_relations:
            body["$expand"] = "Relations"
        if fields:
            body["fields"] = fields

        response = await self._post_with_api_versions(
            f"/{self.project}/_apis/wit/workItemsBatch",
            json=body,
        )

        if response.status_code in {500, 502, 503} and len(ids) > 1:
            mid = len(ids) // 2
            logger.warning(
                "tfs_batch_split status=%s size=%s -> %s + %s",
                response.status_code,
                len(ids),
                mid,
                len(ids) - mid,
            )
            left = await self._fetch_work_items_chunk(
                ids[:mid], fields=fields, with_relations=with_relations
            )
            await asyncio.sleep(settings.tfs_request_delay_seconds)
            right = await self._fetch_work_items_chunk(
                ids[mid:], fields=fields, with_relations=with_relations
            )
            return left + right

        if response.status_code >= 400:
            if len(ids) == 1:
                logger.warning(
                    "tfs_batch_skip id=%s status=%s body=%s",
                    ids[0],
                    response.status_code,
                    response.text[:200],
                )
                return []
            response.raise_for_status()

        batch = response.json()
        return as_work_item_list(batch.get("value") if isinstance(batch, dict) else None)

    async def get_work_items_batch(
        self,
        ids: list[int],
        *,
        on_progress: Callable[[int, int], None] | None = None,
        expand_relations: bool | None = None,
        batch_size: int | None = None,
    ) -> list[dict[str, Any]]:
        if not ids:
            return []

        result: list[dict[str, Any]] = []
        fields = None if settings.tfs_fetch_all_fields else self._batch_field_list()
        requested = batch_size or settings.tfs_batch_size
        chunk_size = max(1, min(requested, WIT_BATCH_MAX_IDS))
        with_relations = (
            settings.tfs_fetch_relations if expand_relations is None else expand_relations
        )

        for offset in range(0, len(ids), chunk_size):
            chunk = ids[offset : offset + chunk_size]
            result.extend(
                await self._fetch_work_items_chunk(
                    chunk,
                    fields=fields,
                    with_relations=with_relations,
                )
            )
            if on_progress is not None:
                on_progress(min(offset + len(chunk), len(ids)), len(ids))
            if offset + chunk_size < len(ids):
                await asyncio.sleep(settings.tfs_request_delay_seconds)

        return result

    async def get_work_item_updates(self, item_id: int) -> list[dict[str, Any]]:
        last_response: httpx.Response | None = None
        for api_version in _api_version_candidates():
            response = await self.client.get(
                f"/{self.project}/_apis/wit/workitems/{item_id}/updates",
                params={"api-version": api_version},
            )
            last_response = response
            if response.status_code == 200:
                body = response.json()
                return [item for item in as_list(body.get("value")) if isinstance(item, dict)]
            if response.status_code == 404:
                return []
            if response.status_code == 400 and "out of range" in response.text.lower():
                continue
        if last_response is not None:
            last_response.raise_for_status()
        return []

    async def extract_pilot_transitions(self, item_id: int) -> list[dict[str, str]]:
        """Переходы workflow в статус «пилот» по истории updates TFS."""
        if not settings.pilot_state_list:
            return []

        pilot_lower = {value.lower() for value in settings.pilot_state_list}
        transitions: list[dict[str, str]] = []
        updates = await self.get_work_item_updates(item_id)
        for update in updates:
            fields = update.get("fields")
            if not isinstance(fields, dict):
                continue
            state_change = fields.get("System.State")
            if not isinstance(state_change, dict):
                continue
            new_value = str(state_change.get("newValue") or "").strip()
            if not new_value or new_value.lower() not in pilot_lower:
                continue
            revised = parse_tfs_datetime(update.get("revisedDate"))
            if revised is None:
                continue
            transitions.append(
                {
                    "at": revised.isoformat(),
                    "status": new_value,
                }
            )
        return transitions

    async def extract_closed_transitions(self, item_id: int) -> list[dict[str, str]]:
        """Переходы workflow в статус Closed по истории updates TFS."""
        if not settings.closed_state_list:
            return []

        closed_lower = {value.lower() for value in settings.closed_state_list}
        transitions: list[dict[str, str]] = []
        updates = await self.get_work_item_updates(item_id)
        for update in updates:
            fields = update.get("fields")
            if not isinstance(fields, dict):
                continue
            state_change = fields.get("System.State")
            if not isinstance(state_change, dict):
                continue
            new_value = str(state_change.get("newValue") or "").strip()
            if not new_value or new_value.lower() not in closed_lower:
                continue
            revised = parse_tfs_datetime(update.get("revisedDate"))
            if revised is None:
                continue
            if not (2000 <= revised.year <= 2100):
                continue
            transitions.append(
                {
                    "at": revised.isoformat(),
                    "status": new_value,
                }
            )
        return transitions

    async def patch_work_item(self, item_id: int, patch: list[dict[str, Any]]) -> dict[str, Any]:
        last_response: httpx.Response | None = None
        for api_version in _api_version_candidates():
            response = await self.client.patch(
                f"/{self.project}/_apis/wit/workitems/{item_id}",
                params={"api-version": api_version},
                headers={"Content-Type": "application/json-patch+json"},
                json=patch,
            )
            last_response = response
            if response.status_code == 200:
                body = response.json()
                return body if isinstance(body, dict) else {}
            if response.status_code == 400 and "out of range" in response.text.lower():
                continue
            response.raise_for_status()
        if last_response is not None:
            last_response.raise_for_status()
        raise httpx.HTTPError(f"Patch failed without response for work item {item_id}")

    async def enrich_scheduling_fields(
        self,
        items: list[dict[str, Any]],
        *,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> None:
        if not items:
            return

        scheduling_fields = wit_api_field_names(settings.scheduling_batch_field_list)
        missing_ids = [
            item["id"]
            for item in items
            if isinstance(item, dict)
            and not (item.get("fields") or {}).get(settings.tfs_user_start_date_field)
        ]
        if not missing_ids:
            return

        by_id = {item["id"]: item for item in items if isinstance(item, dict)}
        for offset in range(0, len(missing_ids), settings.tfs_batch_size):
            chunk = missing_ids[offset : offset + settings.tfs_batch_size]
            body: dict[str, Any] = {"ids": chunk, "fields": scheduling_fields, "errorPolicy": "omit"}
            response = await self._post_with_api_versions(
                f"/{self.project}/_apis/wit/workItemsBatch",
                json=body,
            )
            response.raise_for_status()
            batch = response.json()
            for row in as_list(batch.get("value") if isinstance(batch, dict) else None):
                if not isinstance(row, dict):
                    continue
                item = by_id.get(row["id"])
                if not item:
                    continue
                fields = item.setdefault("fields", {})
                fields.update(row.get("fields") or {})
            if on_progress is not None:
                on_progress(min(offset + len(chunk), len(missing_ids)), len(missing_ids))
            if offset + settings.tfs_batch_size < len(missing_ids):
                await asyncio.sleep(settings.tfs_request_delay_seconds)

    async def _post_with_api_versions(self, path: str, *, json: dict[str, Any]) -> httpx.Response:
        versions = (
            _wit_batch_api_version_candidates()
            if "workitemsbatch" in path.lower()
            else _api_version_candidates()
        )
        last_response: httpx.Response | None = None
        for api_version in versions:
            for attempt in range(1, 4):
                try:
                    response = await self.client.post(path, params={"api-version": api_version}, json=json)
                except (httpx.TimeoutException, httpx.RequestError) as exc:
                    logger.warning("tfs_post_retry path=%s attempt=%s error=%s", path, attempt, exc)
                    if attempt >= 3:
                        raise
                    await asyncio.sleep(min(1.0 * attempt, 3.0))
                    continue
                last_response = response
                if response.status_code == 200:
                    return response
                if response.status_code == 400:
                    body_lower = response.text.lower()
                    if "out of range" in body_lower or "preview" in body_lower:
                        break
                return response
        if last_response is not None:
            return last_response
        raise httpx.HTTPError(f"Request failed without response for {path}")
