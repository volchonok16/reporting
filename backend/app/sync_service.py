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
from app.iteration_plan import parse_planned_date_from_iteration, quarter_key_from_date
from app.linked_errors import is_error_work_item_type
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


def should_skip_closed_zni(fields: dict[str, Any]) -> bool:
    if settings.tfs_exclude_closed_older_than_days <= 0 or not settings.closed_state_list:
        return False
    state = str(fields.get("System.State") or "").strip().lower()
    if state not in {value.lower() for value in settings.closed_state_list}:
        return False
    cutoff = date.today() - timedelta(days=settings.tfs_exclude_closed_older_than_days)
    closed = parse_tfs_datetime(fields.get("Microsoft.VSTS.Common.ClosedDate"))
    changed = parse_tfs_datetime(fields.get("System.ChangedDate"))
    ref = closed or changed
    if ref is None:
        return False
    return ref.date() < cutoff


def tfs_item_url(item_id: int, board: BoardConfig) -> str:
    return f"{board.base_url.rstrip('/')}/{board.project}/_workitems/edit/{item_id}"


def prune_stale_board_tasks(
    db: Session,
    *,
    board: BoardConfig,
    source_system_id: int,
    synced_external_ids: set[str],
) -> int:
    """Удаляет из БД ЗНИ/ошибки доски, не попавшие в текущую выгрузку."""
    board_names = {board.name, board.display_name, "BE-T2 Team"}
    stale_rows = list(
        db.scalars(
            select(Task).where(
                Task.source_system_id == source_system_id,
                or_(
                    Task.source_team.in_(board_names),
                    Task.extra_json["board_code"].as_string() == board.code,
                ),
            )
        )
    )
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
                f"{board.display_name}: история пилот ({len(zni_payloads)} ЗНИ)…",
            )

        for item in zni_payloads:
            fields = item.get("fields") or {}
            created = parse_tfs_datetime(fields.get("System.CreatedDate"))
            updated = parse_tfs_datetime(fields.get("System.ChangedDate"))
            closed = parse_tfs_datetime(fields.get("Microsoft.VSTS.Common.ClosedDate"))

            iteration_path = fields.get("System.IterationPath")
            planned_date = parse_planned_date_from_iteration(
                str(iteration_path) if iteration_path not in (None, "") else None
            )
            extra_json: dict[str, Any] = {
                "area_path": fields.get("System.AreaPath"),
                "board_column": fields.get("System.BoardColumn"),
                "board_code": board.code,
                "tags": work_item_tags(fields),
                "iteration_path": iteration_path,
            }
            if planned_date:
                extra_json["planned_date"] = planned_date.isoformat()
                extra_json["plan_quarter"] = quarter_key_from_date(planned_date)

            if settings.tfs_fetch_pilot_history:
                existing = db.scalar(
                    select(Task).where(
                        Task.source_system_id == source_system_id,
                        Task.external_id == str(item["id"]),
                    )
                )
                cached = (
                    existing is not None
                    and existing.updated_at == updated
                    and isinstance(existing.extra_json, dict)
                    and isinstance(existing.extra_json.get("pilot_transitions"), list)
                )
                if cached and isinstance(existing.extra_json, dict):
                    extra_json["pilot_transitions"] = existing.extra_json["pilot_transitions"]
                else:
                    extra_json["pilot_transitions"] = await client.extract_pilot_transitions(item["id"])
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

        db.commit()

        if sync_run:
            touch_sync_progress(db, sync_run, f"{board.display_name}: поиск ошибок (WIQL)…")

        error_child_map = await client.get_error_links_for_area(
            board.area_path,
            tags=board.sync_tags or None,
        )
        zni_id_set = set(zni_db_ids.keys())
        error_child_map = {
            error_id: zni_id for error_id, zni_id in error_child_map.items() if zni_id in zni_id_set
        }

        if not error_child_map:
            return fetched, upserted

        error_ids = sorted(error_child_map.keys())
        if sync_run:
            touch_sync_progress(db, sync_run, f"{board.display_name}: загрузка {len(error_ids)} ошибок…")

        commit_chunk = min(settings.tfs_linked_batch_size, settings.tfs_batch_size)
        for offset in range(0, len(error_ids), commit_chunk):
            chunk_ids = error_ids[offset : offset + commit_chunk]
            error_payloads = await client.get_work_items_batch(
                chunk_ids,
                expand_relations=False,
            )
            fetched += len(error_payloads)

            for item in as_work_item_list(error_payloads):
                fields = item.get("fields") or {}
                if not is_error_work_item_type(str(fields.get("System.WorkItemType") or "")):
                    continue
                parent_zni_id = error_child_map.get(item["id"])
                parent_db_id = zni_db_ids.get(parent_zni_id) if parent_zni_id else None
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
                        "severity": fields.get("Microsoft.VSTS.Common.Severity"),
                    },
                )
                upserted += 1

            db.commit()

        synced_external_ids = {str(item["id"]) for item in zni_payloads}
        synced_external_ids.update(str(error_id) for error_id in error_child_map.keys())
        prune_stale_board_tasks(
            db,
            board=board,
            source_system_id=source_system_id,
            synced_external_ids=synced_external_ids,
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
        close_db_session(db)

        for board in boards:
            db = SessionLocal()
            try:
                sync_row = db.get(SyncRun, sync_run.id)
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
            finally:
                close_db_session(db)

        db = SessionLocal()
        try:
            sync_run = db.get(SyncRun, sync_run.id)
            if sync_run:
                sync_run.status = "success"
                sync_run.finished_at = datetime.now(UTC)
                sync_run.records_fetched = total_fetched
                sync_run.records_upserted = total_upserted
                params = dict(sync_run.parameters_json or {})
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
