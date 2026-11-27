"""Scoped manifest and bounded CSV preview. Approval/download belong to U7."""
import csv
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select

from app.api.schemas import ArtifactPreview, ArtifactSetState, page_limit
from app.auth.policy import owned_case, permission, scoped_object
from app.db import get_db
from app.domain.csv_limits import ensure_csv_field_capacity
from app.domain.projections import OUTPUT_CONTRACT
from app.domain.output_spec import MANIFEST_VERSION, manifest_spec, file_definition
from app.storage.output_pages import preview_page
from app.errors import ApiError
from app.models import Artifact, ArtifactDatabaseStatus, ArtifactSet, ProcessingRevision, ProcessingRun
from app.storage.artifact_sets import verify_artifact_set
from app.storage.local import StorageFailure

router = APIRouter(prefix="/api/cases/{case_id}/revisions/{revision_id}", tags=["artifacts"])


def artifact_scope(db, user, case_id, revision_id):
    owned_case(db, user, case_id)
    revision = scoped_object(db, user, ProcessingRevision, revision_id, case_id=case_id)
    run = db.scalar(select(ProcessingRun).where(ProcessingRun.revision_id == revision.id))
    artifact_set = db.scalar(select(ArtifactSet).where(ArtifactSet.revision_id == revision.id))
    return revision, run, artifact_set


def available_set(run, artifact_set):
    return bool(run and artifact_set and run.state in {"PREPARED", "APPROVED"} and artifact_set.run_id == run.id)


def integrity_error():
    return ApiError(503, "artifact_integrity_error", "Сохранённый комплект недоступен или повреждён.", retryable=True)


@router.get("/artifacts", response_model=ArtifactSetState)
def read_artifacts(case_id: UUID, revision_id: UUID, request: Request,
                   user=Depends(permission("case.read")), db=Depends(get_db)):
    revision, run, artifact_set = artifact_scope(db, user, case_id, revision_id)
    if not available_set(run, artifact_set):
        return {"revision_id": revision.id, "state": run.state if run else "DRAFT", "available": False,
                "artifact_set_id": None, "manifest_hash": None, "manifest": None, "artifacts": []}
    try:
        bundle = verify_artifact_set(db, artifact_set, request.app.state.storage)
    except StorageFailure:
        raise integrity_error() from None
    by_role = {obj.role: obj for obj in db.scalars(select(Artifact).where(
        Artifact.artifact_set_id == artifact_set.id)).all()}
    statuses = dict(db.execute(select(ArtifactDatabaseStatus.artifact_id, ArtifactDatabaseStatus.database_status)
        .where(ArtifactDatabaseStatus.artifact_id.in_([obj.id for obj in by_role.values()]))).all())
    spec = manifest_spec(bundle.manifest)
    return {"output_spec": bundle.manifest.get("output_spec"), "revision_id": revision.id, "state": run.state, "available": True, "artifact_set_id": artifact_set.id,
            "manifest_hash": bundle.manifest_hash, "manifest": bundle.manifest,
            "artifacts": [{"id": by_role[obj.role].id, "role": obj.role,
                           "database_status": statuses.get(by_role[obj.role].id, "IN_PROGRESS"),
                           "stage": next((stage["id"] for stage in spec["stages"] if obj.role in stage["roles"]), None),
                           "download_filename": obj.download_filename, "sha256": obj.sha256,
                           "size_bytes": obj.size_bytes, "row_count": obj.row_count} for obj in bundle.artifacts]}


@router.get("/artifacts/{artifact_id}/preview", response_model=ArtifactPreview)
def read_artifact_preview(case_id: UUID, revision_id: UUID, artifact_id: UUID, request: Request,
                          after: int = Query(0, ge=0), limit: int = Depends(page_limit),
                          user=Depends(permission("case.read")), db=Depends(get_db)):
    revision, run, artifact_set = artifact_scope(db, user, case_id, revision_id)
    artifact = scoped_object(db, user, Artifact, artifact_id, case_id=case_id)
    if not available_set(run, artifact_set) or artifact.artifact_set_id != artifact_set.id:
        raise ApiError(404, "not_found", "Артефакт не найден в доступном комплекте.")
    if artifact.role == "ZIP":
        raise ApiError(422, "artifact_preview_unavailable", "Предпросмотр доступен для CSV.")
    try:
        indexed = artifact_set.manifest.get('version') == MANIFEST_VERSION
        bundle = verify_artifact_set(db, artifact_set, request.app.state.storage, full=not indexed)
        obj = next(item for item in bundle.artifacts if item.role == artifact.role)
        if indexed:
            spec = manifest_spec(bundle.manifest)
            layout = bundle.manifest.get('error_source')
            columns = file_definition(obj.role, spec['operation'], error_source=layout)['columns']
            page = preview_page(request.app.state.storage, bundle.manifest['previews'][obj.role], obj.role,
                                after=after, limit=limit)
            items = [row['values'] for row in page['items']]
            if obj.role in ('ERRORS', 'ERROR_OTHER_OPERATOR') and layout:
                columns = [*columns, 'SOURCE_ROW', 'ERROR_FIELDS', 'ERROR_MESSAGES']
                items = [[*row['values'], row['diagnostics']['source_row'], row['diagnostics']['error_fields'],
                          row['diagnostics']['error_messages']] for row in page['items']]
            elif obj.role == 'ERRORS':
                # Historical bundles keep their verified bytes; present only the
                # fields of their source rather than the former union of templates.
                fields = list(run.summary.get('record_fields') or [])
                if spec['operation'] == 'REPAIR' and 'STATUS' not in fields:
                    fields.append('STATUS')
                if fields:
                    indexes = [columns.index(field) for field in [*fields, 'SOURCE_ROW', 'ERROR_FIELDS', 'ERROR_MESSAGES']
                               if field in columns]
                    columns = [columns[i] for i in indexes]
                    items = [[row[i] for i in indexes] for row in items]
            return {'revision_id': revision.id, 'artifact_id': artifact.id, 'role': obj.role,
                'columns': columns, 'row_count': obj.row_count,
                'items': items, 'next_cursor': page['next_cursor']}
        ensure_csv_field_capacity(obj.size_bytes)
        path = request.app.state.storage.path_for_key(obj.storage_key)
        columns = OUTPUT_CONTRACT["files"][obj.role]["columns"]
        items = []
        with path.open("r", encoding="cp1251", errors="strict", newline="") as stream:
            reader = csv.reader(stream, delimiter=";", strict=True)
            if next(reader, None) != columns:
                raise StorageFailure()
            for ordinal, row in enumerate(reader, start=1):
                if ordinal <= after:
                    continue
                if len(row) != len(columns):
                    raise StorageFailure()
                items.append(row)
                if len(items) > limit:
                    break
    except (StorageFailure, OSError, UnicodeError, csv.Error):
        raise integrity_error() from None
    return {"revision_id": revision.id, "artifact_id": artifact.id, "role": obj.role,
            "columns": columns, "row_count": obj.row_count, "items": items[:limit],
            "next_cursor": after + limit if len(items) > limit else None}
