"""Late-ack Celery consumer; only the fenced PostgreSQL commit publishes a result."""
import errno
import logging
import os
import shutil
import signal
import threading
import time
from uuid import UUID

import duckdb
from celery import Celery
from kombu import Queue
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from app.db import make_engine, make_session_factory
from app.errors import ApiError
from app.domain.canonical import build_dataset, publish_dataset, read_dataset_index
from app.domain.delete import build_delete_dataset
from app.domain.output_spec import revision_spec
from app.domain.manifest import export_filename
from app.domain.projections import OUTPUT_CONTRACT, ProjectionFailure
from app.domain.serialization import SerializationFailure
from app.domain.readers.dispatch import mapped_reader, reader_result
from app.models import ArtifactSet, Intake, ProcessingRevision, SourceAsset
from app.processing.capacity import PROCESSING_SLOTS, execution_slot
from app.processing.leases import (audit, capacity_wait, claim, clear_lease, database_now, fail_attempt, failure,
                                   heartbeat, locked_run, owns_lease)
from app.settings import Settings
from app.storage.artifact_sets import link_artifact_bundle, publish_artifact_bundle, verify_artifact_set, verify_bundle
from app.storage.local import LocalStorage, StorageFailure

TASK_NAME = "dogtags.process_revision"


def make_celery(settings):
    if not settings.broker_url:
        raise ValueError("Processing requires explicit BROKER_URL or RABBITMQ_PASSWORD.")
    app = Celery("dogtags", broker=settings.broker_url, backend=None)
    app.conf.update(task_queues=(Queue(settings.processing_queue, durable=True),),
                    task_default_queue=settings.processing_queue, task_default_delivery_mode="persistent",
                    task_serializer="json", accept_content=["json"], task_ignore_result=True,
                    task_acks_late=True, task_reject_on_worker_lost=True, worker_prefetch_multiplier=1,
                    worker_concurrency=PROCESSING_SLOTS, broker_transport_options={"confirm_publish": True,
                        "read_timeout": settings.broker_timeout_seconds,
                        "write_timeout": settings.broker_timeout_seconds},
                    broker_connection_timeout=settings.broker_timeout_seconds,
                    broker_connection_retry_on_startup=True, task_publish_retry=False,
                    worker_hijack_root_logger=False)
    return app


class LeaseHeartbeat:
    def __init__(self, sessions, lease, settings, on_loss=None):
        self.sessions, self.lease, self.settings = sessions, lease, settings
        self.stop = threading.Event()
        self.lost = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.on_loss = on_loss
        self.renewed_at = time.monotonic()
        self.watchdog = threading.Thread(target=self._watch, daemon=True)

    def _watch(self):
        # Separate from DB renewal: a blocked query cannot extend local authority.
        while not self.stop.wait(min(self.settings.heartbeat_seconds, 0.2)):
            if self.lost.is_set() or time.monotonic() - self.renewed_at >= self.settings.lease_seconds:
                self.lost.set()
                if self.on_loss is not None:
                    self.on_loss()
                return

    def _loop(self):
        while not self.stop.wait(self.settings.heartbeat_seconds):
            try:
                started = time.monotonic()
                if not heartbeat(self.sessions, self.lease, self.settings):
                    self.lost.set()
                    return
                self.renewed_at = max(self.renewed_at, started)
            except SQLAlchemyError:
                # Losing DB connectivity cannot renew authority. Finalization checks DB time again.
                self.lost.set()
                return

    def __enter__(self):
        self.thread.start()
        self.watchdog.start()
        return self

    def __exit__(self, *args):
        self.stop.set()
        self.thread.join(timeout=self.settings.heartbeat_seconds + 1)
        self.watchdog.join(timeout=1)

    def stage(self, name, percent):
        started = time.monotonic()
        if self.lost.is_set() or not heartbeat(self.sessions, self.lease, self.settings,
                                              stage=name, percent=percent):
            raise LeaseLost()
        self.renewed_at = max(self.renewed_at, started)


class LeaseLost(Exception):
    pass


def finalize(sessions, lease, storage, *, dataset_key, summary, bundle=None, blocked_error=None):
    """No stale attempt or superseded head can link an ArtifactSet or completed dataset."""
    if bundle is not None:
        verify_bundle(bundle, storage)  # Immutable bytes: expensive checks precede owner/Case/Run locks.
    with sessions() as db, db.begin():
        from app.domain.registry import read_snapshot
        from app.domain.retries import snapshot_current
        from app.models import Case, ProcessingRun
        target = db.get(ProcessingRun, lease.run_id)
        owner_id = db.get(Case, target.case_id).owner_id
        pending_revision = db.get(ProcessingRevision, target.revision_id)
        if pending_revision.settings.get('retry'):
            read_snapshot(db, owner_id)
        case, run = locked_run(db, lease.run_id)
        if not owns_lease(run, lease, database_now(db)):
            return False
        if case.head_revision_id != run.revision_id:
            clear_lease(run)
            run.state = "SUPERSEDED"
            run.progress = {"stage": "superseded", "percent": 100}
            audit(db, run, "processing.superseded", {})
            return False
        revision = db.get(ProcessingRevision, run.revision_id)
        if not snapshot_current(db, owner_id, revision):
            clear_lease(run)
            run.state = 'BLOCKED'
            run.error = failure('evidence_snapshot_changed', 'Пересчитайте повтор по новым свидетельствам.', False)
            run.summary = {**summary, 'blocking': True}
            run.progress = {'stage': 'reconciliation', 'percent': 100}
            audit(db, run, 'retry.snapshot_stale', {})
            return False
        if bundle is not None:
            link_artifact_bundle(db, revision, run, bundle, storage, verified=True)
        # File integrity checks may span lease expiry. Roll back their flushed rows as well.
        if not owns_lease(run, lease, database_now(db)):
            db.rollback()
            return False
        run.dataset_key, run.summary = dataset_key, summary
        run.state = "PREPARED" if bundle is not None else "BLOCKED"
        run.error = blocked_error
        if revision.assessment_id:
            intake = db.scalar(select(Intake).where(Intake.case_id == case.id))
            if intake and intake.current_assessment_id == revision.assessment_id:
                intake.state = run.state
        run.progress = {"stage": "complete", "percent": 100}
        clear_lease(run)
        audit(db, run, "processing.completed", {"state": run.state,
              "manifest_hash": bundle.manifest_hash if bundle is not None else None})
        return True


def existing_result(sessions, run_id, storage):
    """Integrity-first reuse: never regenerate bytes behind any existing ArtifactSet."""
    with sessions() as db:
        _, run = locked_run(db, run_id)
        if not run:
            return None
        artifact_set = db.scalar(select(ArtifactSet).where(ArtifactSet.revision_id == run.revision_id))
        if not artifact_set:
            return None
        # Verification can be expensive, so release the Case lock before reading immutable bytes.
        db.commit()
        bundle = verify_artifact_set(db, artifact_set, storage)
        if not run.dataset_key:
            raise StorageFailure()
        index = read_dataset_index(storage, run.dataset_key)
        for obj in index["objects"].values():
            storage.verify(obj["key"], obj["sha256"], obj["size_bytes"])
        return bundle, run.dataset_key, index["summary"]


def process_run(sessions, run_id, settings, storage=None, *, on_lease_loss=None):
    try:
        with execution_slot(settings) as directory:
            if directory is not None:
                _process_admitted(sessions, run_id, settings, storage, directory, on_lease_loss)
    except OSError as error:
        capacity_wait(sessions, run_id, settings, scratch_failure(error))


def scratch_failure(error):
    code = "disk_exhausted" if error.errno in {errno.ENOSPC, errno.EDQUOT} else "scratch_unavailable"
    return failure(code, "Запись scratch не выполнена. Проверьте свободное место и доступность volume.", True)


def _process_admitted(sessions, run_id, settings, storage, directory, on_lease_loss):
    storage = storage or LocalStorage(settings.storage_root)
    lease = claim(sessions, run_id, settings)
    if lease is None:
        return
    try:
        with LeaseHeartbeat(sessions, lease, settings, on_lease_loss) as beating:
            beating.stage("verify", 5)
            with sessions() as db:
                _, target = locked_run(db, run_id)
                kind = target.kind
                db.commit()
            if kind == 'DISCOVER':
                from app.processing.discovery import assess, finish_discovery
                settings.scratch_root.mkdir(parents=True, exist_ok=True)
                if shutil.disk_usage(settings.scratch_root).free < settings.scratch_min_free_bytes:
                    raise OSError(errno.ENOSPC, 'Discovery scratch space exhausted')
                directory.mkdir(exist_ok=False)
                beating.stage('discovery', 20)
                assessment = assess(sessions, lease, settings, storage, directory,
                                    checkpoint=lambda: beating.stage('reconciliation', 80))
                beating.stage('finalization', 95)
                finish_discovery(sessions, lease, assessment, settings)
                return
            reused = existing_result(sessions, run_id, storage)
            if reused is not None:
                bundle, dataset_key, summary = reused
                finalize(sessions, lease, storage, dataset_key=dataset_key, summary=summary, bundle=bundle)
                return
            with sessions() as db:
                _, run = locked_run(db, run_id)
                revision = db.get(ProcessingRevision, run.revision_id)
                source = db.get(SourceAsset, revision.source_asset_id)
                selection = reader_result(db, revision)
                if revision.settings.get('operation') == 'CHANGE':
                    from app.domain.change import verify_scope_link
                    verify_scope_link(db, revision)
                db.commit()
            if (revision.rules_version not in {"hub-rules-v1", "published-rules-v1"}
                    or revision.serializer_version != OUTPUT_CONTRACT["serialization"]["version"]):
                fail_attempt(sessions, lease, settings, failure(
                    "unsupported_snapshot_version", "Версия правил сохранённой ревизии не поддерживается.", False))
                return
            # Old snapshots need a new revision, never an in-place filename mutation.
            try:
                # Validate the pinned naming configuration here; the actual
                # formation timestamp is captured once during publication.
                export_filename(revision, "ZIP", formed_at=revision.export_timestamp)
            except ValueError:
                fail_attempt(sessions, lease, settings, failure(
                    "revision_snapshot_error", "Сохраните новую ревизию с полными параметрами имени файла.", False))
                return
            path = storage.verify(source.storage_key, source.sha256, source.size_bytes)
            settings.scratch_root.mkdir(parents=True, exist_ok=True)
            if shutil.disk_usage(settings.scratch_root).free < settings.scratch_min_free_bytes:
                fail_attempt(sessions, lease, settings, failure(
                    "scratch_space_exhausted", "В scratch недостаточно места. Освободите место и повторите обработку.",
                    True))
                return
            directory.mkdir(exist_ok=False)
            beating.stage("validation", 10)
            operation = revision_spec(revision)['operation']
            builder = build_delete_dataset if operation == 'DELETE' else build_dataset
            if operation == 'WHITEMAV':
                from app.domain.whitemav import build_whitemav_dataset
                builder = build_whitemav_dataset
            if operation == 'REPAIR':
                from app.domain.repair import build_repair_dataset
                builder = build_repair_dataset
            parsed = mapped_reader(storage, source.id, selection)
            overlay = revision.correction_overlay
            if revision.settings.get('retry', {}).get('stage_source'):
                from app.domain.retries import StageDeleteSource
                parsed = StageDeleteSource(sessions, revision.settings['retry'])
                overlay = revision.settings['retry']['stage_corrections']
            build_options = {}
            if revision.settings.get('retry'):
                from app.domain.retries import prepare_retry
                eligible = prepare_retry(sessions, revision, storage, directory, settings.dataset_memory_limit,
                                         settings.dataset_threads, lambda: beating.stage('retry_selection', 15))
                if builder is build_dataset:
                    build_options['active_ordinals'] = eligible
            dataset = builder(path, source.encoding, source.id, directory / "dataset",
                                    revision.profile_snapshot, settings=revision.settings,
                                    correction_overlay=overlay,
                                    memory_limit=settings.dataset_memory_limit, threads=settings.dataset_threads,
                                    parsed_source=parsed, **build_options)
            if revision_spec(revision)['operation'] == 'CHANGE':
                from app.domain.change import add_delete_projection
                add_delete_projection(dataset, revision.settings['delete_scope'], storage)
            if revision.settings.get('retry'):
                from app.domain.retries import select_retry
                dataset = select_retry(sessions, revision, dataset,
                                       lambda: beating.stage('retry_dependencies', 60))
            beating.stage("serialization", 70)
            bundle, blocked_error = None, None
            if not dataset.summary["blocking"]:
                try:
                    bundle = publish_artifact_bundle(dataset, revision, source, storage, directory / "exports")
                except (SerializationFailure, ProjectionFailure) as error:
                    dataset.summary = {**dataset.summary, "blocking": True,
                                       "output_diagnostics": error.diagnostics}
                    blocked_error = failure("output_requires_review",
                                            "Комплект заблокирован. Проверьте указанное поле или настройку.", False,
                                            diagnostics=error.diagnostics)
            beating.stage("publication", 90)
            dataset_key = publish_dataset(dataset, storage)
            beating.stage("finalization", 98)
            finalize(sessions, lease, storage, dataset_key=dataset_key, summary=dataset.summary,
                     bundle=bundle, blocked_error=blocked_error)
    except LeaseLost:
        pass
    except ApiError as error:
        fail_attempt(sessions, lease, settings, failure(error.code, error.message, False))
    except (MemoryError, duckdb.OutOfMemoryException):
        fail_attempt(sessions, lease, settings, failure(
            "memory_exhausted", "Недостаточно памяти для обработки. Проверьте лимит памяти и повторите.", True))
    except OSError as error:
        fail_attempt(sessions, lease, settings, scratch_failure(error))
    except StorageFailure:
        fail_attempt(sessions, lease, settings, failure(
            "storage_integrity_error", "Сохранённые файлы недоступны или повреждены. Проверьте artifact volume.", True))
    except SQLAlchemyError:
        # The lease expires/recovery retries if even the durable error transaction cannot connect.
        raise
    except Exception:
        fail_attempt(sessions, lease, settings, failure(
            "processing_error", "Обработка не выполнена. Проверьте настройки и повторите техническую попытку.", True))


celery_app = make_celery(Settings.from_environment())


@celery_app.task(name=TASK_NAME, acks_late=True, reject_on_worker_lost=True, ignore_result=True)
def process_revision(run_id):
    settings = Settings.from_environment()
    engine = make_engine(settings.database_url)
    try:
        # The prefork child owns one task. SIGKILL also interrupts native parsers
        # and DuckDB; the OS releases its slot only after the process is dead.
        process_run(make_session_factory(engine), UUID(run_id), settings,
                    on_lease_loss=lambda: os.kill(os.getpid(), signal.SIGKILL))
    except SQLAlchemyError:
        logging.error("Processing could not persist state; recovery will retry the expired lease.")
    finally:
        engine.dispose()
