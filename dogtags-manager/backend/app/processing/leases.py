"""Case → run → outbox lock order, with PostgreSQL-wide admission."""
from dataclasses import dataclass
from datetime import timedelta
from uuid import UUID, uuid4

from sqlalchemy import func, select, text

from app.models import AuditEvent, Case, Intake, IntakeVersion, Outbox, ProcessingRevision, ProcessingRun
from app.processing.capacity import PROCESSING_SLOTS

ACTIVE = "PROCESSING"


def database_now(db):
    return db.scalar(select(func.clock_timestamp()))


def locked_run(db, run_id):
    case_id = db.scalar(select(ProcessingRun.case_id).where(ProcessingRun.id == run_id))
    if not case_id:
        return None, None
    # Case identity/owner keys never change; serialize mutable heads without blocking immutable FK readers.
    case = db.scalar(select(Case).where(Case.id == case_id).with_for_update(key_share=True))
    run = db.scalar(select(ProcessingRun).where(ProcessingRun.id == run_id).with_for_update())
    return case, run


def reset_outbox(db, run, when):
    outbox = db.scalar(select(Outbox).where(Outbox.run_id == run.id).with_for_update())
    outbox.published_at = None
    outbox.next_attempt_at = when
    # Invalidates any publisher reservation, including delayed confirms after recovery.
    outbox.attempts += 1


def audit(db, run, action, details):
    target = (db.get(ProcessingRevision, run.revision_id) if run.kind == "BUILD"
              else db.get(IntakeVersion, run.intake_version_id))
    db.add(AuditEvent(case_id=run.case_id, revision_id=run.revision_id, actor_id=target.created_by,
                      action=action, details={"job_id": str(run.id), "generation": run.generation,
                                             "attempt": run.attempt, **details}))


def clear_lease(run):
    run.lease_token = run.lease_expires_at = run.heartbeat_at = None


@dataclass(frozen=True)
class Lease:
    run_id: UUID
    generation: int
    token: UUID


def current_target(db, case, run):
    if run.kind == 'DISCOVER':
        version = db.get(IntakeVersion, run.intake_version_id)
        return (db.get(Intake, version.intake_id).current_version_id == version.id
                and case.head_revision_id is None)
    return case.head_revision_id == run.revision_id


def capacity_wait(sessions, run_id, settings, error):
    """Expose scratch admission failures without claiming or changing active work."""
    with sessions() as db, db.begin():
        case, run = locked_run(db, run_id)
        if not run or run.state != 'QUEUED' or not current_target(db, case, run):
            return
        run.error = error
        run.progress = {'stage': 'capacity_wait', 'percent': None}
        run.next_attempt_at = database_now(db) + timedelta(seconds=settings.retry_backoff_seconds)
        reset_outbox(db, run, run.next_attempt_at)


def claim(sessions, run_id, settings):
    with sessions() as db, db.begin():
        # Schema-scoped key isolates integration fixtures; all production workers share public.
        db.execute(text("SELECT pg_advisory_xact_lock(hashtext(current_schema()), 6)"))
        case, run = locked_run(db, run_id)
        now = database_now(db)
        if not run or run.state != "QUEUED" or (run.next_attempt_at and run.next_attempt_at > now):
            return None
        if not current_target(db, case, run):
            run.state = "SUPERSEDED"
            run.progress = {"stage": "superseded", "percent": 0}
            audit(db, run, "processing.superseded", {})
            return None
        occupied = db.scalar(select(func.count()).select_from(ProcessingRun).where(
            ProcessingRun.state == ACTIVE, ProcessingRun.lease_expires_at > now))
        if occupied >= PROCESSING_SLOTS:
            return None
        if run.attempt >= settings.max_job_attempts:
            run.state = "FAILED"
            run.error = failure("attempts_exhausted", "Достигнут предел попыток. Повторите обработку вручную.", True)
            return None
        run.state = ACTIVE
        run.attempt += 1
        run.generation += 1
        run.lease_token = uuid4()
        run.heartbeat_at = now
        run.lease_expires_at = now + timedelta(seconds=settings.lease_seconds)
        run.next_attempt_at = None
        run.error = None
        run.progress = {"stage": "claim", "percent": None}
        audit(db, run, "processing.claimed", {})
        return Lease(run.id, run.generation, run.lease_token)


def owns_lease(run, lease, now):
    return bool(run and run.state == ACTIVE and run.generation == lease.generation
                and run.lease_token == lease.token and run.lease_expires_at and run.lease_expires_at > now)


def heartbeat(sessions, lease, settings, *, stage=None, percent=None):
    with sessions() as db, db.begin():
        _, run = locked_run(db, lease.run_id)
        now = database_now(db)
        if not owns_lease(run, lease, now):
            return False
        run.heartbeat_at = now
        run.lease_expires_at = now + timedelta(seconds=settings.lease_seconds)
        if stage is not None:
            run.progress = {"stage": stage, "percent": percent}
        return True


def failure(code, message, retryable, *, diagnostics=None):
    result = {"code": code, "message": message, "retryable": retryable}
    if diagnostics is not None:
        result["diagnostics"] = diagnostics
    return result


def fail_attempt(sessions, lease, settings, error):
    with sessions() as db, db.begin():
        _, run = locked_run(db, lease.run_id)
        now = database_now(db)
        if not owns_lease(run, lease, now):
            return False
        clear_lease(run)
        run.error = error
        run.progress = {"stage": "failed", "percent": 0}
        if error["retryable"] and run.attempt < settings.max_job_attempts:
            run.state = "QUEUED"
            run.next_attempt_at = now + timedelta(seconds=settings.retry_backoff_seconds * 2 ** (run.attempt - 1))
            reset_outbox(db, run, run.next_attempt_at)
        else:
            run.state = "FAILED"
        audit(db, run, "processing.failed", {"error": error, "retry_scheduled": run.state == "QUEUED"})
        return True
