"""Bounded STATUS history and raw-to-export lineage for reconciliation and retry selection."""
from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import String, cast, select, text
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.api.schemas import CorrectionInput, OperationState
from app.auth.policy import check_mutation
from app.domain.operations import replay_operation

from app.api.schemas import ReturnDetail, ReturnHistoryPage, ReturnRowPage, page_limit
from app.auth.policy import permission, scoped_object
from app.db import get_db
from app.domain.intakes import row_view
from app.domain.registry import read_snapshot
from app.errors import ApiError
from app.models import Intake, ReturnAssessment, ReturnResolution, ReturnRow

router = APIRouter(prefix='/api/returns', tags=['returns'])


def selected(db, user, intake_id, assessment_id):
    intake = scoped_object(db, user, Intake, intake_id)
    query = select(ReturnAssessment).where(ReturnAssessment.owner_id == user.id, ReturnAssessment.intake_id == intake.id)
    query = query.where(ReturnAssessment.id == assessment_id) if assessment_id else query.where(
        ReturnAssessment.assessment_id == intake.current_assessment_id)
    assessment = db.scalar(query)
    if assessment_id and not assessment:
        raise ApiError(404, 'not_found', 'Сверка не принадлежит этому возврату.')
    return assessment


class RetryTarget(BaseModel):
    case_id: UUID
    expected_revision_id: UUID | None
    source_revision_id: UUID
    source_asset_id: UUID
    role: Literal['CLIENTS', 'DOGTAGS', 'NUMBERS', 'DELETE']
    correction_scope: Literal['source_records', 'stage_export_rows']


class ReturnDetailWithRetryTarget(ReturnDetail):
    retry_target: RetryTarget | None


def retry_target(db, assessment):
    if assessment is None:
        return None
    from app.models import Artifact, ArtifactSet, Case, ProcessingRevision
    from app.domain.retries import uses_delete_stage
    artifact = db.get(Artifact, assessment.artifact_id)
    bundle = db.get(ArtifactSet, artifact.artifact_set_id)
    revision = db.get(ProcessingRevision, bundle.revision_id)
    case = db.get(Case, revision.case_id)
    return {'case_id': case.id, 'expected_revision_id': case.head_revision_id,
            'source_revision_id': revision.id, 'source_asset_id': revision.source_asset_id,
            'role': artifact.role, 'correction_scope': 'stage_export_rows'
            if uses_delete_stage(revision, artifact.role) else 'source_records'}


@router.get('/{intake_id}', response_model=ReturnDetailWithRetryTarget)
def read_return(intake_id: UUID, assessment_id: UUID | None = None,
                user=Depends(permission('case.read')), db=Depends(get_db)):
    snapshot = read_snapshot(db, user.id)
    obj = selected(db, user, intake_id, assessment_id)
    resolution = db.scalar(select(ReturnResolution).where(ReturnResolution.replacement_id == obj.id)) if obj else None
    superseded = db.scalar(select(ReturnResolution).where(ReturnResolution.previous_id == obj.id)) if obj else None
    return {'intake_id': intake_id, 'retry_target': retry_target(db, obj), 'assessment': row_view(obj) if obj else None,
            'resolution': row_view(resolution) if resolution else None,
            'superseded_by': row_view(superseded) if superseded else None, 'snapshot_version': snapshot}


@router.get('/{intake_id}/rows', response_model=ReturnRowPage)
def read_rows(intake_id: UUID, assessment_id: UUID | None = None, after: int = Query(0, ge=0),
              limit: int = Depends(page_limit), user=Depends(permission('case.read')), db=Depends(get_db)):
    snapshot = read_snapshot(db, user.id)
    obj = selected(db, user, intake_id, assessment_id)
    if obj is None:
        raise ApiError(409, 'return_assessment_unavailable', 'Связь и сверка ещё не завершены.')
    rows = list(db.scalars(select(ReturnRow).where(ReturnRow.return_assessment_id == obj.id,
        ReturnRow.ordinal > after).order_by(ReturnRow.ordinal).limit(limit + 1)))
    ids = [r.export_row_id for r in rows[:limit] if r.export_row_id]
    states = dict(db.execute(text("""SELECT c.export_row_id,
        CASE WHEN bool_or(e.outcome='APPLIED') AND bool_or(e.outcome='REJECTED') THEN 'CONFLICT'
        WHEN bool_or(e.outcome='APPLIED') THEN 'APPLIED' WHEN bool_or(e.outcome='REJECTED') THEN 'REJECTED'
        ELSE 'UNKNOWN' END FROM evidence_coverage c JOIN evidence_events e ON e.id=c.event_id
        JOIN export_rows r ON r.id=c.export_row_id
        WHERE e.owner_id=:owner AND e.attempt_id=:attempt AND c.export_row_id=ANY(:ids)
        AND NOT EXISTS (SELECT 1 FROM return_resolutions rr WHERE rr.previous_id=e.return_assessment_id)
        AND NOT EXISTS (SELECT 1 FROM evidence_resolutions s JOIN registry_entries re ON re.id=s.entry_id
          JOIN resolution_evidence se ON se.resolution_id=s.id
          WHERE re.owner_id=r.owner_id AND re.kind=r.kind AND re.business_key=r.business_key
          AND se.event_id=e.id AND s.chosen_event_id<>e.id)
        GROUP BY c.export_row_id"""), {'owner': user.id, 'attempt': obj.attempt_id, 'ids': ids}).all()) if ids else {}
    return {'assessment_id': obj.id, 'snapshot_version': snapshot,
        'items': [{**row_view(r), 'rule_version': obj.rule_version, 'rule_digest': obj.rule_digest,
                   'attempt_state': states.get(r.export_row_id, 'UNKNOWN')} for r in rows[:limit]],
        'next_cursor': rows[limit - 1].ordinal if len(rows) > limit else None}


@router.get('/{intake_id}/assessments', response_model=ReturnHistoryPage)
def return_history(intake_id: UUID, after: UUID | None = None, limit: int = Depends(page_limit),
                   user=Depends(permission('case.read')), db=Depends(get_db)):
    scoped_object(db, user, Intake, intake_id)
    query = select(ReturnAssessment).where(ReturnAssessment.owner_id == user.id, ReturnAssessment.intake_id == intake_id)
    if after:
        selected(db, user, intake_id, after)
        query = query.where(ReturnAssessment.id > after)
    rows = list(db.scalars(query.order_by(ReturnAssessment.id).limit(limit + 1)))
    return {'items': [row_view(r) for r in rows[:limit]],
            'next_cursor': rows[limit - 1].id if len(rows) > limit else None}


class RetryBody(BaseModel):
    model_config = ConfigDict(extra='forbid')
    operation_id: UUID
    assessment_id: UUID
    expected_revision_id: UUID
    expected_snapshot_version: int = Field(ge=0)
    retry_revision_id: UUID | None = None
    reason: str = Field(min_length=1, max_length=2000)
    corrections: list[CorrectionInput] = Field(default_factory=list, max_length=100)
    success_reasons: dict[UUID, str] = Field(default_factory=dict, max_length=100)

    @field_validator('reason', 'success_reasons')
    @classmethod
    def nonempty_reasons(cls, value):
        reasons = value.values() if isinstance(value, dict) else [value]
        if any(not reason.strip() or len(reason) > 2000 for reason in reasons):
            raise ValueError('Every repeated success requires a separate nonempty reason.')
        return value


@router.post('/{intake_id}/retries', response_model=OperationState, dependencies=[Depends(check_mutation)])
def corrected_retry(intake_id: UUID, body: RetryBody, request: Request,
                    user=Depends(permission('case.edit')), db=Depends(get_db)):
    from app.domain.retries import create_retry
    assessment = selected(db, user, intake_id, body.assessment_id)
    operation = create_retry(db, user, assessment, body, request.app.state.storage)
    db.commit()
    return replay_operation(operation)


class EvidenceWatermark(BaseModel):
    evidence_events: int
    evidence_resolutions: int
    return_resolutions: int


class RetrySnapshot(BaseModel):
    version: Literal['corrected-retry-v1']
    assessment_id: UUID
    attempt_id: UUID
    artifact_id: UUID
    source_revision_id: UUID
    snapshot_version: int
    evidence_watermark: EvidenceWatermark
    role: Literal['CLIENTS', 'DOGTAGS', 'NUMBERS', 'DELETE']
    reason: str
    success_reasons: dict[UUID, str]
    stage_source: bool = False
    stage_corrections: list[dict] = Field(default_factory=list)


class RetryDecision(BaseModel):
    export_row_id: UUID
    export_ordinal: int
    values: dict[str, str]
    state: Literal['APPLIED', 'REJECTED', 'UNKNOWN', 'CONFLICT']
    reason: str
    selected: bool
    page_index: int
    source_ordinal: int | None
    source_record_id: UUID | None


class RetryDetail(BaseModel):
    revision_id: UUID
    case_id: UUID
    retry: RetrySnapshot
    snapshot_version: int
    current_evidence_watermark: EvidenceWatermark
    source_asset_id: UUID
    correction_scope: Literal['source_records', 'stage_export_rows']
    stale: bool
    state: str
    diagnostics: list[dict]
    items: list[RetryDecision]
    next_cursor: int | None


class RetryHistoryItem(BaseModel):
    revision_id: UUID
    case_id: UUID
    assessment_id: UUID
    source_revision_id: UUID
    created_at: datetime
    state: str
    stale: bool


class RetryHistoryPage(BaseModel):
    items: list[RetryHistoryItem]
    next_cursor: UUID | None


@router.get('/{intake_id}/retries', response_model=RetryHistoryPage)
def retry_history(intake_id: UUID, after: UUID | None = None, limit: int = Depends(page_limit),
                  user=Depends(permission('case.read')), db=Depends(get_db)):
    from app.domain.retries import evidence_watermark
    from app.models import Case, ProcessingRevision, ProcessingRun
    scoped_object(db, user, Intake, intake_id)
    read_snapshot(db, user.id)
    watermark = evidence_watermark(db, user.id)
    query = (select(ProcessingRevision, ProcessingRun.state).join(Case, Case.id == ProcessingRevision.case_id)
        .outerjoin(ProcessingRun, ProcessingRun.revision_id == ProcessingRevision.id)
        .where(Case.owner_id == user.id, ProcessingRevision.settings['retry']['assessment_id'].astext.in_(
            select(cast(ReturnAssessment.id, String)).where(ReturnAssessment.intake_id == intake_id))))
    if after:
        cursor = db.execute(query.where(ProcessingRevision.id == after)).first()
        if not cursor:
            raise ApiError(404, 'not_found', 'Курсор не принадлежит повторам этого возврата.')
        query = query.where(ProcessingRevision.id > after)
    rows = list(db.execute(query.order_by(ProcessingRevision.id).limit(limit + 1)))
    return {'items': [{'revision_id': revision.id, 'case_id': revision.case_id,
        'assessment_id': revision.settings['retry']['assessment_id'],
        'source_revision_id': revision.settings['retry']['source_revision_id'], 'created_at': revision.created_at,
        'state': state or 'DRAFT', 'stale': revision.settings['retry']['evidence_watermark'] != watermark}
        for revision, state in rows[:limit]], 'next_cursor': rows[limit - 1][0].id if len(rows) > limit else None}


@router.get('/{intake_id}/retries/{revision_id}', response_model=RetryDetail)
def read_retry(intake_id: UUID, revision_id: UUID, request: Request, after: int = Query(0, ge=0),
               limit: int = Depends(page_limit), user=Depends(permission('case.read')), db=Depends(get_db)):
    from app.domain.canonical import read_dataset_index
    from app.domain.retries import evidence_watermark
    from app.models import ProcessingRevision, ProcessingRun
    from app.storage.pages import read_page
    snapshot = read_snapshot(db, user.id)
    revision = scoped_object(db, user, ProcessingRevision, revision_id)
    retry = revision.settings.get('retry')
    if not retry:
        raise ApiError(404, 'not_found', 'Ревизия не является повтором возврата.')
    selected(db, user, intake_id, UUID(retry['assessment_id']))
    run = db.scalar(select(ProcessingRun).where(ProcessingRun.revision_id == revision.id))
    page = {'items': [], 'next_cursor': None}
    if run and run.dataset_key:
        index = read_dataset_index(request.app.state.storage, run.dataset_key)
        page = read_page(request.app.state.storage, index['pages']['retry_decisions'], 'retry_decisions',
                         after=after, limit=limit)
    import json
    for item in page['items']:
        item['values'] = json.loads(item.pop('values_json'))
    watermark = evidence_watermark(db, user.id)
    return {'revision_id': revision.id, 'case_id': revision.case_id, 'retry': retry,
            'current_evidence_watermark': watermark,
            'source_asset_id': revision.source_asset_id,
            'correction_scope': 'stage_export_rows' if retry.get('stage_source') else 'source_records',
            'snapshot_version': snapshot, 'stale': watermark != retry['evidence_watermark'],
            'state': run.state if run else 'DRAFT', 'diagnostics': run.summary.get('retry_diagnostics', []) if run else [],
            **page}
