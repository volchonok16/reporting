import asyncio
import logging
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import delete, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.boards import BOARDS, BoardConfig, boards_for_sync
from app.config import settings
from app.db import SessionLocal, close_db_session
from app.json_utils import as_work_item_list
from app.iteration_plan import parse_iteration_plan, quarter_key_from_date
from app.release_fields import work_item_planned_release
from app.linked_errors import is_error_work_item_type, parent_zni_id_from_error_payload
from app.resource_reservation import compute_ect_resource_reservation
from app.ect_acceptance import compute_ect_acceptance
from app.completed_metrics import effective_closed_date, effective_closed_date_from_fields
from app.zni_description import extract_business_goal_from_description, tfs_identity_display_name
from app.zni_title_filters import is_excluded_zni_title
from app.roadmap_priority_service import preserve_roadmap_priority_in_extra
from app.digital_plan_service import preserve_digital_plan_fields_in_extra
from app.models import Project, SourceSystem, SyncRun, Task, Team
from app.tfs_client import TfsClient, date_from_field_list, parse_tfs_datetime

logger = logging.getLogger(__name__)

TASK_TYPE_CHANGE = "change_request"
TASK_TYPE_ERROR = "error"


def effective_start_date(fields: dict[str, Any]) -> date | None:
    start = date_from_field_list(fields, [settings.tfs_user_start_date_field])
    if start:
        return start
    created = fields.get("System.CreatedDate")
    parsed = parse_tfs_datetime(created)
    return parsed.date() if parsed else None


def effective_release_date(fields: dict[str, Any]) -> date | None:
    return date_from_field_list(fields, settings.target_date_field_list)


def work_item_tags(fields: dict[str, Any] | None) -> list[str]:
    if not fields:
        return []
    raw = fields.get("System.Tags")
    if raw in (None, ""):
        return []
    return [part.strip() for part in str(raw).split(";") if part.strip()]


def has_required_tags(fields: dict[str, Any], required_tags: tuple[str, ...]) -> bool:
    if not required_tags:
        return True
    tags = {tag.casefold() for tag in work_item_tags(fields)}
    return any(required.casefold() in tags for required in required_tags)


def has_excluded_tags(fields: dict[str, Any], excluded_tags: tuple[str, ...]) -> bool:
    if not excluded_tags:
        return False
    tags = {tag.casefold() for tag in work_item_tags(fields)}
    excluded = {tag.casefold() for tag in excluded_tags}
    return bool(tags & excluded)


def is_excluded_sync_state(fields: dict[str, Any], excluded_states: tuple[str, ...]) -> bool:
    if not excluded_states:
        return False
    state = str(fields.get("System.State") or "").strip().casefold()
    return state in {value.casefold() for value in excluded_states}


def is_excluded_sync_title(fields: dict[str, Any]) -> bool:
    return is_excluded_zni_title(str(fields.get("System.Title") or ""))


def should_skip_closed_zni(fields: dict[str, Any]) -> bool:
    if not settings.closed_state_list:
        return False
    state = str(fields.get("System.State") or "").strip().lower()
    if state not in {value.lower() for value in settings.closed_state_list}:
        return False

    closed_date = effective_closed_date_from_fields(fields)
    retain_since_year = settings.sync_closed_retain_since_year()
    if closed_date is not None and closed_date.year < retain_since_year:
        return True

    if settings.tfs_sync_closed_retain_years > 1:
        return False

    if settings.tfs_exclude_closed_older_than_days <= 0:
        return False
    cutoff = date.today() - timedelta(days=settings.tfs_exclude_closed_older_than_days)
    if closed_date is not None:
        return closed_date < cutoff
    changed = parse_tfs_datetime(fields.get("System.ChangedDate"))
    return changed is not None and changed.date() < cutoff


def tfs_item_url(item_id: int, board: BoardConfig) -> str:
    return f"{board.base_url.rstrip('/')}/{board.project}/_workitems/edit/{item_id}"


def _board_scope_source_teams(board: BoardConfig) -> set[str]:
    names = {board.name, board.display_name}
    if board.code == "be_t2_team":
        names.add("BE-T2 Team")
    return names


def _board_task_scope_filter(source_system_id: int, board: BoardConfig):
    scope_teams = _board_scope_source_teams(board)
    return select(Task).where(
        Task.source_system_id == source_system_id,
        or_(
            Task.extra_json["board_code"].as_string() == board.code,
            Task.source_team.in_(scope_teams),
        ),
    )


def prune_stale_board_tasks(
    db: Session,
    *,
    board: BoardConfig,
    source_system_id: int,
    synced_external_ids: set[str],
) -> int:
    """Удаляет из БД ЗНИ/ошибки доски, не попавшие в текущую выгрузку."""
    stale_rows = list(db.scalars(_board_task_scope_filter(source_system_id, board)))
    stale_ids = [row.id for row in stale_rows if row.external_id not in synced_external_ids]
    if not stale_ids:
        return 0

    db.execute(delete(Task).where(Task.parent_task_id.in_(stale_ids)))
    result = db.execute(delete(Task).where(Task.id.in_(stale_ids)))
    db.commit()
    removed = result.rowcount or 0
    if removed:
        logger.info("sync_prune_stale board=%s removed=%s", board.code, removed)
    return removed


def is_closed_before_current_year(task: Task, *, retain_since_year: int | None = None) -> bool:
    if not settings.closed_state_list:
        return False
    closed_lower = {value.lower() for value in settings.closed_state_list}
    if (task.source_status or "").strip().lower() not in closed_lower:
        return False
    closed_date = effective_closed_date(task)
    if closed_date is None:
        return False
    threshold = (
        retain_since_year
        if retain_since_year is not None
        else settings.sync_closed_retain_since_year()
    )
    return closed_date.year < threshold


def prune_closed_before_current_year(
    db: Session,
    *,
    board: BoardConfig,
    source_system_id: int,
) -> int:
    """Удаляет Closed ЗНИ доски, закрытые раньше окна `TFS_SYNC_CLOSED_RETAIN_YEARS`."""
    if not settings.closed_state_list:
        return 0

    rows = list(
        db.scalars(
            _board_task_scope_filter(source_system_id, board).where(
                Task.task_type == TASK_TYPE_CHANGE,
            )
        )
    )

    stale_ids = [row.id for row in rows if is_closed_before_current_year(row)]

    if not stale_ids:
        return 0

    db.execute(delete(Task).where(Task.parent_task_id.in_(stale_ids)))
    result = db.execute(delete(Task).where(Task.id.in_(stale_ids)))
    db.commit()
    removed = result.rowcount or 0
    if removed:
        logger.info("sync_prune_closed_old_year board=%s removed=%s", board.code, removed)
    return removed


def touch_sync_progress(db: Session, sync_run: SyncRun, message: str) -> None:
    params = dict(sync_run.parameters_json or {})
    params["progress"] = message
    sync_run.parameters_json = params
    db.add(sync_run)
    db.commit()


def ensure_reference_data(db: Session) -> tuple[int, dict[str, int], dict[str, int]]:
    tfs = db.scalar(select(SourceSystem).where(SourceSystem.code == "tfs"))
    if tfs is None:
        raise RuntimeError("source_system 'tfs' not found")
    source_system_id = tfs.id

    team_ids: dict[str, int] = {}
    for board in BOARDS:
        row = db.scalar(select(Team).where(Team.code == board.code))
        if row is None:
            row = Team(code=board.code, name=board.display_name, is_active=True)
            db.add(row)
            db.flush()
        team_ids[board.code] = row.id

    project_ids: dict[str, int] = {}
    for board in BOARDS:
        row = db.scalar(
            select(Project).where(
                Project.source_system_id == source_system_id,
                Project.external_key == board.project,
            )
        )
        if row is None:
            row = Project(
                source_system_id=source_system_id,
                external_key=board.project,
                name=board.project,
                team_id=team_ids.get(board.code),
                is_active=True,
            )
            db.add(row)
            db.flush()
        project_ids[board.project] = row.id

    db.commit()
    return source_system_id, project_ids, team_ids


def upsert_task(
    db: Session,
    *,
    source_system_id: int,
    project_id: int,
    team_id: int,
    external_id: str,
    title: str,
    task_type: str,
    source_status: str | None,
    source_team: str | None,
    created_at: datetime | None,
    updated_at: datetime | None,
    start_date: date | None,
    release_date: date | None,
    closed_at: datetime | None,
    parent_task_id: int | None,
    external_url: str | None,
    extra_json: dict[str, Any] | None,
) -> int:
    now = datetime.now(UTC)
    stmt = (
        insert(Task)
        .values(
            source_system_id=source_system_id,
            external_id=external_id,
            project_id=project_id,
            team_id=team_id,
            parent_task_id=parent_task_id,
            title=title,
            task_type=task_type,
            source_status=source_status,
            source_team=source_team,
            created_at=created_at,
            updated_at=updated_at,
            start_date=start_date,
            release_date=release_date,
            closed_at=closed_at,
            external_url=external_url,
            extra_json=extra_json,
            last_synced_at=now,
        )
        .on_conflict_do_update(
            index_elements=["source_system_id", "external_id"],
            set_={
                "project_id": project_id,
                "team_id": team_id,
                "parent_task_id": parent_task_id,
                "title": title,
                "task_type": task_type,
                "source_status": source_status,
                "source_team": source_team,
                "created_at": created_at,
                "updated_at": updated_at,
                "start_date": start_date,
                "release_date": release_date,
                "closed_at": closed_at,
                "external_url": external_url,
                "extra_json": extra_json,
                "last_synced_at": now,
            },
        )
        .returning(Task.id)
    )
    return db.execute(stmt).scalar_one()


async def sync_board(
    db: Session,
    *,
    board: BoardConfig,
    pat: str,
    source_system_id: int,
    project_ids: dict[str, int],
    team_ids: dict[str, int],
    sync_run: SyncRun | None = None,
) -> tuple[int, int]:
    client = TfsClient(board.to_tfs_auth(pat))
    fetched = 0
    upserted = 0
    try:
        if sync_run:
            touch_sync_progress(db, sync_run, f"{board.display_name}: поиск ЗНИ (WIQL)…")

        zni_ids = await client.get_change_request_ids(
            area_path=board.area_path,
            tags=board.sync_tags or None,
            exclude_tags=board.exclude_sync_tags or None,
            exclude_states=board.exclude_sync_states or None,
        )
        if not zni_ids:
            prune_stale_board_tasks(
                db,
                board=board,
                source_system_id=source_system_id,
                synced_external_ids=set(),
            )
            return 0, 0

        if sync_run:
            touch_sync_progress(db, sync_run, f"{board.display_name}: загрузка {len(zni_ids)} ЗНИ…")

        zni_payloads_raw = await client.get_work_items_batch(zni_ids, expand_relations=False)
        await client.enrich_scheduling_fields(zni_payloads_raw)
        zni_payloads = [
            item
            for item in as_work_item_list(zni_payloads_raw)
            if has_required_tags(item.get("fields") or {}, board.sync_tags)
            and not has_excluded_tags(item.get("fields") or {}, board.exclude_sync_tags)
            and not is_excluded_sync_state(item.get("fields") or {}, board.exclude_sync_states)
            and not is_excluded_sync_title(item.get("fields") or {})
            and not should_skip_closed_zni(item.get("fields") or {})
        ]
        skipped = len(zni_payloads_raw) - len(zni_payloads)
        if skipped:
            logger.info("sync_skip_closed_old board=%s skipped=%s", board.code, skipped)
        fetched += len(zni_payloads)

        project_id = project_ids[board.project]
        team_id = team_ids[board.code]
        zni_db_ids: dict[int, int] = {}

        if settings.tfs_fetch_pilot_history and zni_payloads and sync_run:
            touch_sync_progress(
                db,
                sync_run,
                f"{board.display_name}: история пилот/closed ({len(zni_payloads)} ЗНИ)…",
            )

        for item in zni_payloads:
            fields = item.get("fields") or {}
            created = parse_tfs_datetime(fields.get("System.CreatedDate"))
            updated = parse_tfs_datetime(fields.get("System.ChangedDate"))
            closed = parse_tfs_datetime(fields.get("Microsoft.VSTS.Common.ClosedDate"))

            iteration_path = fields.get("System.IterationPath")
            iteration_plan = parse_iteration_plan(
                str(iteration_path) if iteration_path not in (None, "") else None
            )
            triage = fields.get("Microsoft.VSTS.Common.Triage")
            existing = db.scalar(
                select(Task).where(
                    Task.source_system_id == source_system_id,
                    Task.external_id == str(item["id"]),
                )
            )
            existing_extra = existing.extra_json if existing and isinstance(existing.extra_json, dict) else None
            extra_json: dict[str, Any] = {
                "area_path": fields.get("System.AreaPath"),
                "board_column": fields.get("System.BoardColumn"),
                "board_code": board.code,
                "tags": work_item_tags(fields),
                "iteration_path": iteration_path,
            }
            if triage not in (None, ""):
                extra_json["triage"] = str(triage).strip()
            if iteration_plan.is_tbd:
                extra_json["planned_status"] = "tbd"
                extra_json["plan_quarter"] = iteration_plan.quarter_key
            elif iteration_plan.planned_date:
                extra_json["planned_status"] = "date"
                extra_json["planned_date"] = iteration_plan.planned_date.isoformat()
                extra_json["plan_quarter"] = iteration_plan.quarter_key
            else:
                target_date = effective_release_date(fields)
                if target_date:
                    extra_json["planned_status"] = "date"
                    extra_json["planned_date"] = target_date.isoformat()
                    extra_json["plan_quarter"] = quarter_key_from_date(target_date)

            planned_release = work_item_planned_release(fields)
            if planned_release:
                extra_json["planned_release"] = planned_release

            customer_name = tfs_identity_display_name(fields.get("Logrocon.PO"))
            if customer_name:
                extra_json["customer_name"] = customer_name

            business_goal = extract_business_goal_from_description(fields.get("System.Description"))
            if business_goal:
                extra_json["business_goal"] = business_goal

            business_value = fields.get("Microsoft.VSTS.Common.BusinessValue")
            if business_value not in (None, ""):
                try:
                    extra_json["business_value"] = int(business_value)
                except (TypeError, ValueError):
                    pass

            preserve_roadmap_priority_in_extra(extra_json, existing_extra)
            preserve_digital_plan_fields_in_extra(extra_json, existing_extra)

            if settings.tfs_fetch_pilot_history:
                cached = (
                    existing is not None
                    and existing.updated_at == updated
                    and isinstance(existing_extra, dict)
                    and isinstance(existing_extra.get("pilot_transitions"), list)
                    and isinstance(existing_extra.get("closed_transitions"), list)
                )
                if cached:
                    extra_json["pilot_transitions"] = existing_extra["pilot_transitions"]
                    extra_json["closed_transitions"] = existing_extra["closed_transitions"]
                else:
                    extra_json["pilot_transitions"] = await client.extract_pilot_transitions(item["id"])
                    await asyncio.sleep(settings.tfs_request_delay_seconds)
                    extra_json["closed_transitions"] = await client.extract_closed_transitions(item["id"])
                    await asyncio.sleep(settings.tfs_request_delay_seconds)

            task_id = upsert_task(
                db,
                source_system_id=source_system_id,
                project_id=project_id,
                team_id=team_id,
                external_id=str(item["id"]),
                title=str(fields.get("System.Title") or f"ЗНИ {item['id']}"),
                task_type=TASK_TYPE_CHANGE,
                source_status=fields.get("System.State"),
                source_team=board.name,
                created_at=created,
                updated_at=updated,
                start_date=effective_start_date(fields),
                release_date=effective_release_date(fields),
                closed_at=closed,
                parent_task_id=None,
                external_url=tfs_item_url(item["id"], board),
                extra_json=extra_json,
            )
            zni_db_ids[item["id"]] = task_id
            upserted += 1

        if zni_db_ids:
            if sync_run:
                touch_sync_progress(
                    db,
                    sync_run,
                    f"{board.display_name}: связи «Бронь ресурсов»…",
                )
            reservation_zni_ids = await client.get_zni_resource_reservation_links(
                board.area_path,
                zni_tags=board.sync_tags or None,
                exclude_zni_states=board.exclude_sync_states or None,
                exclude_zni_tags=board.exclude_sync_tags or None,
            )
            reservation_flags = compute_ect_resource_reservation(
                zni_db_ids.keys(),
                reservation_zni_ids=reservation_zni_ids,
            )
            for external_id, task_id in zni_db_ids.items():
                row = db.get(Task, task_id)
                if row is None:
                    continue
                extra = dict(row.extra_json) if isinstance(row.extra_json, dict) else {}
                extra["ect_resource_reservation"] = reservation_flags.get(external_id, False)
                row.extra_json = extra
                db.add(row)

            if sync_run:
                touch_sync_progress(
                    db,
                    sync_run,
                    f"{board.display_name}: связи «Приемка ЕЦТ»…",
                )
            acceptance_zni_ids = await client.get_zni_ect_acceptance_links(
                board.area_path,
                zni_tags=board.sync_tags or None,
                exclude_zni_states=board.exclude_sync_states or None,
                exclude_zni_tags=board.exclude_sync_tags or None,
            )
            acceptance_flags = compute_ect_acceptance(
                zni_db_ids.keys(),
                acceptance_zni_ids=acceptance_zni_ids,
            )
            for external_id, task_id in zni_db_ids.items():
                row = db.get(Task, task_id)
                if row is None:
                    continue
                extra = dict(row.extra_json) if isinstance(row.extra_json, dict) else {}
                extra["ect_acceptance"] = acceptance_flags.get(external_id, False)
                row.extra_json = extra
                db.add(row)

            if board.code == "digital_streams_b2b":
                from app.linked_environments import sync_digital_linked_environments

                if sync_run:
                    touch_sync_progress(
                        db,
                        sync_run,
                        f"{board.display_name}: связи CRM / Bercut…",
                    )
                await sync_digital_linked_environments(
                    db,
                    client,
                    digital_board=board,
                    zni_db_ids=zni_db_ids,
                    pat=pat,
                )

        db.commit()

        if sync_run:
            touch_sync_progress(db, sync_run, f"{board.display_name}: поиск ошибок (WIQL)…")

        error_child_map = await client.get_error_links_for_area(
            board.area_path,
            zni_tags=board.sync_tags or None,
            exclude_zni_states=board.exclude_sync_states or None,
            exclude_zni_tags=board.exclude_sync_tags or None,
            exclude_error_tags=board.exclude_sync_tags or None,
        )
        zni_id_set = set(zni_db_ids.keys())
        error_child_map = {
            error_id: zni_id for error_id, zni_id in error_child_map.items() if zni_id in zni_id_set
        }
        if zni_id_set:
            linked_by_zni = await client.get_error_links_for_zni_ids(
                zni_id_set,
                exclude_error_tags=board.exclude_sync_tags or None,
            )
            error_child_map.update(linked_by_zni)

        board_error_ids = await client.get_error_ids_for_area(
            board.area_path,
            tags=board.error_sync_tags or None,
            exclude_tags=board.exclude_sync_tags or None,
        )

        incident_error_ids: set[int] = set()
        if board.incident_error_area_path:
            incident_error_ids = set(
                await client.get_error_ids_for_area(
                    board.incident_error_area_path,
                    tags=board.incident_error_sync_tags or None,
                    exclude_tags=board.exclude_sync_tags or None,
                )
            )

        synced_error_ids: set[str] = set()
        error_ids = sorted(
            set(error_child_map.keys()) | set(board_error_ids) | incident_error_ids
        )

        if error_ids and sync_run:
            touch_sync_progress(db, sync_run, f"{board.display_name}: загрузка {len(error_ids)} ошибок…")

        commit_chunk = min(settings.tfs_linked_batch_size, settings.tfs_batch_size)
        for offset in range(0, len(error_ids), commit_chunk):
            chunk_ids = error_ids[offset : offset + commit_chunk]
            error_payloads = await client.get_work_items_batch(
                chunk_ids,
                expand_relations=False,
                fields=client._error_batch_field_list(),
            )
            fetched += len(error_payloads)

            for item in as_work_item_list(error_payloads):
                fields = item.get("fields") or {}
                if not is_error_work_item_type(str(fields.get("System.WorkItemType") or "")):
                    continue
                is_incident_error = item["id"] in incident_error_ids
                parent_zni_id = error_child_map.get(item["id"]) or parent_zni_id_from_error_payload(item)
                if parent_zni_id is None and is_incident_error:
                    if not has_required_tags(fields, board.incident_error_sync_tags):
                        continue
                elif parent_zni_id is None and not has_required_tags(fields, board.error_sync_tags):
                    continue
                if has_excluded_tags(fields, board.exclude_sync_tags):
                    continue
                parent_db_id = zni_db_ids.get(parent_zni_id) if parent_zni_id else None
                if parent_db_id is None and parent_zni_id is not None:
                    parent_db_id = db.scalar(
                        select(Task.id).where(
                            Task.source_system_id == source_system_id,
                            Task.task_type == TASK_TYPE_CHANGE,
                            Task.external_id == str(parent_zni_id),
                        )
                    )
                created = parse_tfs_datetime(fields.get("System.CreatedDate"))
                updated = parse_tfs_datetime(fields.get("System.ChangedDate"))
                closed = parse_tfs_datetime(fields.get("Microsoft.VSTS.Common.ClosedDate"))
                upsert_task(
                    db,
                    source_system_id=source_system_id,
                    project_id=project_id,
                    team_id=team_id,
                    external_id=str(item["id"]),
                    title=str(fields.get("System.Title") or f"Ошибка {item['id']}"),
                    task_type=TASK_TYPE_ERROR,
                    source_status=fields.get("System.State"),
                    source_team=board.name,
                    created_at=created,
                    updated_at=updated,
                    start_date=effective_start_date(fields),
                    release_date=effective_release_date(fields),
                    closed_at=closed,
                    parent_task_id=parent_db_id,
                    external_url=tfs_item_url(item["id"], board),
                    extra_json={
                        "parent_zni_id": parent_zni_id,
                        "board_code": board.code,
                        "tags": work_item_tags(fields),
                        "severity": fields.get("Microsoft.VSTS.Common.Severity"),
                        **(
                            {
                                "incident_error": True,
                                "area_path": fields.get("System.AreaPath"),
                            }
                            if is_incident_error
                            else {}
                        ),
                    },
                )
                synced_error_ids.add(str(item["id"]))
                upserted += 1

            db.commit()

        synced_external_ids = {str(item["id"]) for item in zni_payloads}
        synced_external_ids.update(synced_error_ids)
        prune_stale_board_tasks(
            db,
            board=board,
            source_system_id=source_system_id,
            synced_external_ids=synced_external_ids,
        )
        prune_closed_before_current_year(
            db,
            board=board,
            source_system_id=source_system_id,
        )

        return fetched, upserted
    finally:
        await client.close()


async def run_sync(
    pat: str,
    *,
    sync_run_id: int | None = None,
    board_code: str | None = None,
) -> SyncRun:
    boards = boards_for_sync(board_code)
    db = SessionLocal()
    try:
        source_system_id, project_ids, team_ids = ensure_reference_data(db)

        sync_run: SyncRun
        if sync_run_id:
            sync_run = db.get(SyncRun, sync_run_id)
            if sync_run is None:
                raise RuntimeError(f"sync_run {sync_run_id} not found")
        else:
            sync_run = SyncRun(
                source_system_id=source_system_id,
                status="running",
                parameters_json={"boards": [b.code for b in boards], "progress": "Старт…"},
            )
            db.add(sync_run)
            db.commit()
            db.refresh(sync_run)

        total_fetched = 0
        total_upserted = 0
        board_errors: list[str] = []
        close_db_session(db)

        for index, board in enumerate(boards, start=1):
            db = SessionLocal()
            try:
                sync_row = db.get(SyncRun, sync_run.id)
                if sync_row and len(boards) > 1:
                    touch_sync_progress(
                        db,
                        sync_row,
                        f"{index}/{len(boards)}: {board.display_name}…",
                    )
                fetched, upserted = await sync_board(
                    db,
                    board=board,
                    pat=pat,
                    source_system_id=source_system_id,
                    project_ids=project_ids,
                    team_ids=team_ids,
                    sync_run=sync_row,
                )
                total_fetched += fetched
                total_upserted += upserted
            except Exception as exc:
                logger.exception("sync_board_failed board=%s", board.code)
                board_errors.append(f"{board.display_name}: {exc}")
            finally:
                close_db_session(db)

        db = SessionLocal()
        try:
            sync_run = db.get(SyncRun, sync_run.id)
            if sync_run:
                sync_run.finished_at = datetime.now(UTC)
                sync_run.records_fetched = total_fetched
                sync_run.records_upserted = total_upserted
                params = dict(sync_run.parameters_json or {})
                if board_errors and total_upserted == 0:
                    sync_run.status = "failed"
                    sync_run.error_message = "; ".join(board_errors)
                    params["progress"] = sync_run.error_message
                else:
                    sync_run.status = "success"
                    if board_errors:
                        params["progress"] = (
                            f"Готово: {total_upserted} записей; ошибки: {'; '.join(board_errors)}"
                        )
                    else:
                        params["progress"] = f"Готово: {total_upserted} записей"
                sync_run.parameters_json = params
                db.add(sync_run)
                db.commit()
                db.refresh(sync_run)
            return sync_run
        finally:
            close_db_session(db)
    except Exception as exc:
        logger.exception("sync_failed")
        db = SessionLocal()
        try:
            if sync_run_id:
                sync_run = db.get(SyncRun, sync_run_id)
                if sync_run:
                    sync_run.status = "failed"
                    sync_run.error_message = str(exc)
                    sync_run.finished_at = datetime.now(UTC)
                    db.add(sync_run)
                    db.commit()
                    db.refresh(sync_run)
                    return sync_run
        finally:
            close_db_session(db)
        raise
    finally:
        close_db_session(db)
