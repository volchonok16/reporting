"""Durable upload receipt, immutable decisions, and automatic work scheduling."""
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import aliased

from app.admin.publish_rules import active_snapshot
from app.api.processing import job_view
from app.api.views import revision_view, source_view
from app.domain.operations import canonical_digest, complete_operation, fail_operation
from app.errors import ApiError
from app.models import (Artifact, ArtifactDatabaseStatus, ArtifactSet, AuditEvent, Case, Intake, IntakeAssessment, IntakeVersion, Operation, Outbox,
                        ProcessingRevision, ProcessingRun, SourceAsset)
from app.storage.local import StagedObject, StorageFailure


def row_view(row):
    return {column.name: (str(value) if isinstance(value := getattr(row, column.name), UUID)
                          else value.isoformat() if hasattr(value, 'isoformat') else value)
            for column in row.__table__.columns}


def work_dates(db, case_ids):
    """Use durable work events; reading Archive and reversible removal do not touch this date."""
    return dict(db.execute(select(AuditEvent.case_id, func.max(AuditEvent.created_at))
        .where(AuditEvent.case_id.in_(case_ids), AuditEvent.action.not_in(('intake.deleted', 'intake.restored', 'intake.database_status')))
        .group_by(AuditEvent.case_id)).all())


def output_files(db, revision_ids):
    """Read actual published output metadata for the bounded archive page in one query."""
    files = {}
    for revision_id, manifest, artifact, status in db.execute(select(ArtifactSet.revision_id, ArtifactSet.manifest, Artifact, ArtifactDatabaseStatus.database_status)
        .join(Artifact, Artifact.artifact_set_id == ArtifactSet.id)
        .outerjoin(ArtifactDatabaseStatus, ArtifactDatabaseStatus.artifact_id == Artifact.id)
        .join(ProcessingRun, ProcessingRun.id == ArtifactSet.run_id)
        .where(ArtifactSet.revision_id.in_(revision_ids), ProcessingRun.state.in_(['PREPARED', 'APPROVED']))
        .order_by(Artifact.role)):
        files.setdefault(revision_id, []).append({'id': str(artifact.id), 'role': artifact.role,
            'download_filename': artifact.download_filename, 'database_status': status or 'IN_PROGRESS', 'row_count': manifest['counts'].get(artifact.role)})
    return files


def detail(db, intake):
    case = db.get(Case, intake.case_id)
    version = db.get(IntakeVersion, intake.current_version_id)
    assessment = db.get(IntakeAssessment, intake.current_assessment_id) if intake.current_assessment_id else None
    source = db.get(SourceAsset, intake.source_asset_id)
    revision = db.get(ProcessingRevision, case.head_revision_id) if case.head_revision_id else None
    run = db.scalar(select(ProcessingRun).where(ProcessingRun.revision_id == revision.id)) if revision else db.scalar(
        select(ProcessingRun).where(ProcessingRun.intake_version_id == version.id))
    revision_source = db.get(SourceAsset, revision.source_asset_id) if revision else None
    return detail_view(intake, version, assessment, source, revision, revision_source, run,
                       work_dates(db, [intake.case_id]).get(intake.case_id),
                       output_files(db, [revision.id]).get(revision.id, []) if revision else [])


def details(db, intakes):
    """Read the bounded page's related rows together, including legacy replacement sources."""
    if not intakes:
        return []
    revision_source = aliased(SourceAsset)
    query = (select(Intake, IntakeVersion, IntakeAssessment, SourceAsset, ProcessingRevision,
                    revision_source, ProcessingRun)
        .join(Case, Case.id == Intake.case_id)
        .join(IntakeVersion, IntakeVersion.id == Intake.current_version_id)
        .outerjoin(IntakeAssessment, IntakeAssessment.id == Intake.current_assessment_id)
        .join(SourceAsset, SourceAsset.id == Intake.source_asset_id)
        .outerjoin(ProcessingRevision, ProcessingRevision.id == Case.head_revision_id)
        .outerjoin(revision_source, revision_source.id == ProcessingRevision.source_asset_id)
        .outerjoin(ProcessingRun, (ProcessingRun.revision_id == ProcessingRevision.id)
                   | (Case.head_revision_id.is_(None)
                      & (ProcessingRun.intake_version_id == IntakeVersion.id)))
        .where(Intake.id.in_([item.id for item in intakes])))
    dates = work_dates(db, [item.case_id for item in intakes])
    rows = list(db.execute(query))
    files = output_files(db, [row[4].id for row in rows if row[4]])
    by_id = {row[0].id: detail_view(*row, dates.get(row[0].case_id), files.get(row[4].id, []) if row[4] else []) for row in rows}
    return [by_id[item.id] for item in intakes]


def detail_view(intake, version, assessment, source, revision, revision_source, run, worked_at=None, files=None):
    job = job_view(run) if run else None
    if job:
        job.update(kind=run.kind, revision_id=str(run.revision_id) if run.revision_id else None,
                   intake_version_id=str(run.intake_version_id) if run.intake_version_id else None)
    timestamps = [intake.created_at, version.created_at, source.created_at]
    if revision:
        timestamps.append(revision.created_at)
    if worked_at:
        timestamps.append(worked_at)
    return {'intake': {**row_view(intake), 'worked_at': max(timestamps).isoformat()}, 'version': row_view(version),
            'assessment': row_view(assessment) if assessment else None, 'source': source_view(source),
            'revision': revision_view(revision, revision_source, run) if revision else None, 'job': job,
            'output_files': files or []}


def enqueue_discovery(db, version):
    run = ProcessingRun(case_id=version.case_id, kind='DISCOVER', intake_version_id=version.id,
                         work_identity=canonical_digest({'intake_version_id': str(version.id)}),
                         state='QUEUED', progress={'stage': 'queued', 'percent': 0})
    db.add(run)
    db.flush()
    db.add(Outbox(run_id=run.id))
    db.flush()
    return run


def pending_upload(staged, storage, filename, decisions, snapshot):
    if staged.failed or not staged.path:
        raise ApiError(503, 'storage_unavailable', 'Файл не сохранён. Повторите передачу.', retryable=True)
    # A committed receipt must survive process/host restart together with its staged bytes.
    try:
        storage._fsync_directory(staged.path.parent)
        storage._fsync_directory(staged.path.parent.parent)
        storage._fsync_directory(storage.root)
    except OSError:
        raise ApiError(503, 'storage_unavailable', 'Передача не сохранена надёжно. Повторите загрузку.', retryable=True) from None
    return {'stage': str(staged.path.relative_to(storage.root)), 'sha256': staged.sha256,
            'size_bytes': staged.size_bytes, 'filename': filename, 'decisions': decisions,
            'rules_snapshot': snapshot, 'case_id': str(uuid4()), 'source_id': str(uuid4()),
            'intake_id': str(uuid4()), 'version_id': str(uuid4())}


def resume_upload(sessions, operation_id, storage):
    """Publish outside DB locks; atomically link one receipt's planned objects and DISCOVER outbox."""
    with sessions() as db:
        operation = db.get(Operation, operation_id)
        if not operation or operation.status != 'RUNNING' or not operation.private_pending:
            return
        pending = dict(operation.private_pending)
    stage_path = storage.root / pending['stage']
    staged = StagedObject(stage_path, pending['sha256'], pending['size_bytes'])
    key = storage.key_for_hash(staged.sha256)
    try:
        try:
            storage.verify(key, staged.sha256, staged.size_bytes)
        except StorageFailure:
            # Verify durable staging before publication; hashing remains outside receipt lock.
            import hashlib
            digest, size = hashlib.sha256(), 0
            with stage_path.open('rb') as stream:
                while chunk := stream.read(65536):
                    digest.update(chunk)
                    size += len(chunk)
            if digest.hexdigest() != staged.sha256 or size != staged.size_bytes:
                raise StorageFailure()
            storage.publish(staged)
    except (StorageFailure, OSError):
        with sessions() as db, db.begin():
            operation = db.scalar(select(Operation).where(Operation.id == operation_id).with_for_update())
            if operation.status == 'RUNNING':
                fail_operation(operation, ApiError(503, 'upload_recovery_unavailable',
                    'Сохранённая передача недоступна. Загрузите исходный файл с новым ID операции.', retryable=True))
        return
    with sessions() as db, db.begin():
        operation = db.scalar(select(Operation).where(Operation.id == operation_id).with_for_update())
        if operation.status != 'RUNNING':
            return
        case = Case(id=UUID(pending['case_id']), owner_id=operation.owner_id, title=pending['filename'])
        db.add(case)
        db.flush()
        source = SourceAsset(id=UUID(pending['source_id']), case_id=case.id, created_by=operation.owner_id,
            filename=pending['filename'], metadata_version=2, encoding=None, sha256=staged.sha256,
            size_bytes=staged.size_bytes, storage_key=key, inspection={})
        db.add(source)
        db.flush()
        intake = Intake(id=UUID(pending['intake_id']), case_id=case.id, source_asset_id=source.id, state='DISCOVERING')
        db.add(intake)
        db.flush()
        version = IntakeVersion(id=UUID(pending['version_id']), case_id=case.id, intake_id=intake.id,
            source_asset_id=source.id, sequence=1, created_by=operation.owner_id,
            decisions={**pending['decisions'], 'rules_snapshot': pending['rules_snapshot']})
        db.add(version)
        db.flush()
        intake.current_version_id = version.id
        enqueue_discovery(db, version)
        db.flush()
        complete_operation(operation, detail(db, intake))
        operation.private_pending = None
        db.add(AuditEvent(case_id=case.id, actor_id=operation.owner_id, action='intake.upload',
                          operation_id=operation.id, details={'intake_id': str(intake.id)}))
    storage.discard(staged)


def recover_uploads(sessions, storage):
    with sessions() as db:
        ids = list(db.scalars(select(Operation.id).where(Operation.action == 'intake.upload',
            Operation.status == 'RUNNING', Operation.private_pending.is_not(None)).order_by(Operation.created_at).limit(100)))
    for operation_id in ids:
        resume_upload(sessions, operation_id, storage)
    return len(ids)


def next_decision_version(db, user, intake, choices):
    previous = db.get(IntakeVersion, intake.current_version_id)
    previous_partner = previous.decisions.get('partner')
    if not previous_partner and intake.current_assessment_id:
        assessment = db.get(IntakeAssessment, intake.current_assessment_id)
        previous_partner = assessment.result.get('partner', {}).get('partner')
    if (previous_partner and choices.get('partner') and choices['partner'] != previous_partner
            and not (choices.get('reason') or '').strip()):
        raise ApiError(422, 'partner_change_reason_required', 'Укажите основание смены партнёра.')
    effective = dict(previous.decisions)
    case = db.get(Case, intake.case_id)
    head = db.get(ProcessingRevision, case.head_revision_id) if case.head_revision_id else None
    if head and head.settings.get('operation') == 'CHANGE':
        effective.update(operation='CHANGE', delete_scope=head.settings['delete_scope'])
    decisions = {**effective, **choices}
    if decisions.get('operation') == 'WHITEMAV':
        from app.domain.whitemav_inns import DEFAULT_INNS, selected_inn
        chosen_inn = decisions.get('whitemav_inn') or DEFAULT_INNS[0]
        previous_inn = previous.decisions.get('whitemav_inn', DEFAULT_INNS[0]) if previous.decisions.get('operation') == 'WHITEMAV' else None
        decisions['whitemav_inn'] = chosen_inn if chosen_inn == previous_inn else selected_inn(db, user.id, chosen_inn)
    else:
        decisions.pop('whitemav_inn', None)
    # A file received before admin setup can explicitly retry after publication.
    if not decisions.get('rules_snapshot'):
        decisions['rules_snapshot'] = active_snapshot(db)
    elif choices.get('partner') and choices['partner'] not in decisions['rules_snapshot']['config']['profiles']:
        current = active_snapshot(db)
        if current is None or choices['partner'] not in current['config']['profiles']:
            raise ApiError(422, 'partner_rules_missing', 'Для выбранного партнёра ещё нет правил обработки.')
        decisions['rules_snapshot'] = current
    version = IntakeVersion(case_id=intake.case_id, intake_id=intake.id, source_asset_id=intake.source_asset_id,
        parent_version_id=previous.id, sequence=previous.sequence + 1, created_by=user.id, decisions=decisions)
    db.add(version)
    db.flush()
    intake.current_assessment_id = None
    intake.current_version_id = version.id
    intake.state = 'DISCOVERING'
    db.get(Case, intake.case_id).head_revision_id = None
    enqueue_discovery(db, version)
    db.flush()
    return version
