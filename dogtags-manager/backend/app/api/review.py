from uuid import UUID
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import select

from app.api.schemas import IssuePage, RecordDetail, RecordPage, ReviewState, page_limit
from app.auth.policy import owned_case, permission, scoped_object
from app.db import get_db
from app.domain.canonical import connection, parquet_page, read_dataset_index
from app.domain.rules import Normalizer
from app.domain.corrections import effective_values, overlay_index
from app.domain.ingress import HUB_COLUMNS, parse_source, source_record_id
from app.domain.readers.dispatch import inspection_for, mapped_reader, reader_result
from app.errors import ApiError
from app.models import ProcessingRevision, ProcessingRun, SourceAsset
from app.storage.local import StorageFailure
from app.storage.pages import group_record_issues, read_record_issues, read_page

router = APIRouter(prefix="/api/cases/{case_id}/revisions/{revision_id}", tags=["review"])
COMPLETED_DATA_STATES = {"NEEDS_REVIEW", "BLOCKED", "PREPARED", "APPROVED"}


def review_scope(db, user, case_id, revision_id):
    owned_case(db, user, case_id)
    revision = scoped_object(db, user, ProcessingRevision, revision_id, case_id=case_id)
    source = scoped_object(db, user, SourceAsset, revision.source_asset_id, case_id=case_id)
    run = db.scalar(select(ProcessingRun).where(ProcessingRun.revision_id == revision.id))
    return revision, source, run


def dataset_index(storage, source, run):
    if not run or not run.dataset_key or run.state not in COMPLETED_DATA_STATES:
        return None
    index = read_dataset_index(storage, run.dataset_key)
    if index["summary"].get("source_asset_id") != str(source.id):
        raise StorageFailure()
    return index


def completed_page(request, index, role, **page_options):
    storage, settings = request.app.state.storage, request.app.state.settings
    if 'pages' in index:
        page_options['record_fields'] = record_fields(index)
        return read_page(storage, index['pages'][role], role, **page_options)
    page_options.pop('ordinal', None)
    obj = index["objects"][role]
    path = storage.verify(obj["key"], obj["sha256"], obj["size_bytes"])
    return parquet_page(path, role, memory_limit=settings.dataset_memory_limit,
                        threads=settings.dataset_threads, **page_options)


def record_fields(index):
    return ('MSISDN',) if index['summary'].get('operation') == 'DELETE' else tuple(
        index['summary'].get('record_fields', HUB_COLUMNS))


def owned_record_issues(request, index, records):
    if not records:
        return {}
    storage = request.app.state.storage
    if 'pages' in index:
        return read_record_issues(storage, index['pages']['issues'], records)
    descriptor = index['objects']['issues']
    path = storage.verify(descriptor['key'], descriptor['sha256'], descriptor['size_bytes'])
    settings = request.app.state.settings
    with connection(memory_limit=settings.dataset_memory_limit, threads=settings.dataset_threads) as db:
        db.read_parquet(str(path)).create_view('owned_issues')
        rows = db.execute('SELECT * FROM owned_issues WHERE ordinal>=? AND ordinal<=? ORDER BY ordinal,field,scope,code,message',
            [min(row['ordinal'] for row in records), max(row['ordinal'] for row in records)]).to_arrow_table().to_pylist()
    try:
        return group_record_issues(records, rows)
    except (KeyError, TypeError, ValueError):
        raise StorageFailure() from None


def unavailable_dataset():
    return ApiError(503, "dataset_integrity_error", "Сохранённые данные проверки недоступны или повреждены.",
                    retryable=True)


def draft_page(storage, source, revision, *, after, limit, parsed=None):
    if parsed is None:
        path = storage.verify(source.storage_key, source.sha256, source.size_bytes)
        parsed = parse_source(path, source.encoding, source.id)
    indexed = overlay_index(revision.correction_overlay, source.id,
                            mapping_digest=getattr(parsed, 'mapping_digest', None),
                            allowed_fields=(*parsed.mapping, *parsed.defaults) if getattr(parsed, 'mapping', None) else HUB_COLUMNS)
    normalizer = Normalizer(revision.settings['rules_snapshot'], revision.settings.get('partner_flags')) if revision.settings.get('rules_snapshot') else None
    items = []
    records = (parsed.records(after=after, limit=limit + 1) if hasattr(parsed, 'mapping_digest') else
               parsed.records())
    for record in records:
        if record.ordinal <= after:
            continue
        automatic_changes = []
        effective = effective_values(record, indexed.get(record.ordinal, []), normalizer=normalizer,
                                     bulk_steps=indexed.bulk_steps, normalization_log=automatic_changes)
        items.append({"record_id": record.record_id, "ordinal": record.ordinal, "page_index": record.ordinal,
                      "line_start": record.line_start, "line_end": record.line_end, "raw_cells": record.raw_cells,
                      "effective": effective,
                      "normalizations": [*(normalizer.apply(record.values)[1] if normalizer else []), *automatic_changes],
                      "disposition": 'excluded_manual' if revision.settings.get('row_selections', {}).get(
                          record.record_id, {}).get('excluded') else None, "representative_id": None})
        if len(items) > limit:
            break
    return {"items": items[:limit], "next_cursor": items[limit - 1]["ordinal"] if len(items) > limit else None}


@router.get("/review", response_model=ReviewState)
def read_review(case_id: UUID, revision_id: UUID, request: Request,
                user=Depends(permission("case.read")), db=Depends(get_db)):
    revision, source, run = review_scope(db, user, case_id, revision_id)
    try:
        parsed = mapped_reader(request.app.state.storage, source.id, reader_result(db, revision))
        index = dataset_index(request.app.state.storage, source, run)
    except StorageFailure:
        raise unavailable_dataset() from None
    summary = dict(index["summary"]) if index else None
    if summary and "issue_counts" in summary:
        summary["issue_counts"] = {code: count for code, count in summary["issue_counts"].items()
                                   if code != "label_contains_latin"}
    return {"revision_id": revision.id, "source_asset_id": source.id, "state": run.state if run else "DRAFT",
            "dataset_available": index is not None, "inspection": inspection_for(source, parsed),
            "summary": summary}


@router.get("/records", response_model=RecordPage)
def read_records(case_id: UUID, revision_id: UUID, request: Request,
                 after: int = Query(0, ge=0), limit: int = Depends(page_limit),
                 sort: Literal['source', 'errors_first'] = Query('source'),
                 user=Depends(permission("case.read")), db=Depends(get_db)):
    revision, source, run = review_scope(db, user, case_id, revision_id)
    try:
        parsed = mapped_reader(request.app.state.storage, source.id, reader_result(db, revision))
        index = dataset_index(request.app.state.storage, source, run)
        if index and sort == 'errors_first':
            fields = record_fields(index)
            storage, settings = request.app.state.storage, request.app.state.settings
            if 'review_errors_first' in index:
                page = read_page(storage, index['review_errors_first'], 'records-errors-first',
                                 after=after, limit=limit, record_fields=fields)
            else:
                from app.domain.review_sort import sorted_page
                paths = [storage.verify(obj['key'], obj['sha256'], obj['size_bytes'])
                         for obj in (index['objects']['records'], index['objects']['issues'])]
                page = sorted_page(*paths, after=after, limit=limit, record_fields=fields,
                                   memory_limit=settings.dataset_memory_limit, threads=settings.dataset_threads)
        else:
            page = (completed_page(request, index, "records", after=after, limit=limit) if index else
                    draft_page(request.app.state.storage, source, revision, after=after, limit=limit, parsed=parsed))
        if index:
            issues = ({row['record_id']: row['issues'] for row in page['items']}
                      if sort == 'errors_first' else owned_record_issues(request, index, page['items']))
            for row in page['items']:
                row['issues'] = issues[row['record_id']]
                row['issue_fields'] = sorted({issue['field'] for issue in row['issues'] if issue['scope'] != 'warning'})
    except (StorageFailure, ValueError):
        raise unavailable_dataset() from None
    return {"revision_id": revision.id, "source_asset_id": source.id, "state": run.state if run else "DRAFT",
            "columns": inspection_for(source, parsed)['columns'], "dataset_available": index is not None, **page}


@router.get("/issues", response_model=IssuePage)
def read_issues(case_id: UUID, revision_id: UUID, request: Request,
                after: int = Query(0, ge=0), limit: int = Depends(page_limit),
                user=Depends(permission("case.read")), db=Depends(get_db)):
    revision, source, run = review_scope(db, user, case_id, revision_id)
    try:
        index = dataset_index(request.app.state.storage, source, run)
        page = completed_page(request, index, "issues", after=after, limit=limit) if index else {
            "items": [], "next_cursor": None}
    except StorageFailure:
        raise unavailable_dataset() from None
    return {"revision_id": revision.id, "source_asset_id": source.id, "state": run.state if run else "DRAFT",
            "available": index is not None, **page}


@router.get("/records/{record_id}", response_model=RecordDetail)
def read_record(case_id: UUID, revision_id: UUID, record_id: UUID, request: Request,
                ordinal: int = Query(..., ge=1), user=Depends(permission("case.read")), db=Depends(get_db)):
    revision, source, run = review_scope(db, user, case_id, revision_id)
    if revision.assessment_id is None and source_record_id(source.id, ordinal) != record_id:
        raise ApiError(404, "not_found", "Запись не найдена в доступном источнике.")
    try:
        parsed = mapped_reader(request.app.state.storage, source.id, reader_result(db, revision))
        index = dataset_index(request.app.state.storage, source, run)
        page = (completed_page(request, index, "records", record_id=str(record_id), ordinal=ordinal, limit=1) if index else
                draft_page(request.app.state.storage, source, revision, after=ordinal - 1, limit=1, parsed=parsed))
        issues = completed_page(request, index, "issues", record_id=str(record_id),
                                ordinal=ordinal, limit=request.app.state.settings.max_page_size)["items"] if index else []
    except (StorageFailure, ValueError):
        raise unavailable_dataset() from None
    if not page["items"] or page["items"][0]["record_id"] != str(record_id):
        raise ApiError(404, "not_found", "Запись не найдена в доступном источнике.")
    try:
        normalizations = (read_page(request.app.state.storage, index['normalization_pages'], 'normalizations',
                                   record_id=str(record_id), ordinal=ordinal, limit=200)['items']
                          if index and 'normalization_pages' in index else
                          page['items'][0].get('normalizations', []))
    except (StorageFailure, ValueError):
        raise unavailable_dataset() from None
    record = page['items'][0]
    try:
        record['issues'] = group_record_issues([record], issues)[record['record_id']]
    except (KeyError, TypeError, ValueError):
        raise unavailable_dataset() from None
    record['issue_fields'] = sorted({issue['field'] for issue in record['issues'] if issue['scope'] != 'warning'})
    return {"revision_id": revision.id, "source_asset_id": source.id, "record": record,
            "normalizations": normalizations,
            "corrections": [change for change in revision.correction_overlay if change.get("record_id") == str(record_id)],
            "issues_available": index is not None, "issues": issues}
