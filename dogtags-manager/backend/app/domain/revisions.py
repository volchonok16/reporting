"""Immutable Draft append. Caller owns commit, and can append U6 job/outbox atomically."""
from copy import deepcopy
from uuid import uuid4

from app.api.views import revision_view
from app.auth.policy import owned_case, require_permission, scoped_object
from app.domain.canonical import profile_values
from app.domain.rules import Normalizer, partner_filename_token, trim_inn, ordinary_spaces, label_linebreaks
from app.domain.corrections import effective_values, overlay_index, prefixed_msisdn, clean_msisdn
from app.domain.ingress import HUB_COLUMNS, parse_source, source_record_id
from app.domain.validation import label_script_valid
from app.domain.readers.dispatch import mapped_reader, reader_result
from app.domain.readers.base import mapping_digest
from app.domain.operations import canonical_digest, complete_operation, find_operation
from app.domain.manifest import capture_filename_components
from app.errors import ApiError
from app.models import AuditEvent, Operation, ProcessingRevision, SourceAsset, utcnow
from app.storage.local import StorageFailure


def source_records(storage, source, overlay, targets, *, allow_structure=False):
    """Resolve requested records before the short mutation lock; no global checks."""
    selection = source.get('reader_result')
    normalizer = Normalizer(source['rules_snapshot'], source.get('partner_flags')) if source.get('rules_snapshot') else None
    for target in targets:
        if selection is None and source_record_id(source["id"], target.ordinal) != target.record_id:
            raise ApiError(404, "not_found", "Запись не найдена в доступном источнике.")
    if not targets:
        return {}
    requested = {target.ordinal for target in targets}
    last_requested = max(requested)
    try:
        parsed = mapped_reader(storage, source['id'], selection)
        if parsed is not None:
            indexed = overlay_index(overlay, source['id'], mapping_digest=parsed.mapping_digest,
                                    allowed_fields=selection.get('record_fields', (*parsed.mapping, *parsed.defaults)))
            records, fragment_cache = {}, {}
            for target in targets:
                record = next(parsed.records(after=target.ordinal - 1, limit=1, fragment_cache=fragment_cache), None)
                if record is None or record.record_id != str(target.record_id):
                    raise ApiError(404, 'not_found', 'Запись не найдена в доступном источнике.')
                if not allow_structure and any(not issue.get('field') for issue in record.issues):
                    raise ApiError(422, 'source_structure_requires_review', 'Структура исходной строки требует разбора.')
                records[target.ordinal] = effective_values(record, indexed.get(target.ordinal, []), normalizer=normalizer, bulk_steps=indexed.bulk_steps)
            return records
        path = storage.verify(source["storage_key"], source["sha256"], source["size_bytes"])
        indexed = overlay_index(overlay, source["id"])
        records = {}
        for record in parse_source(path, source["encoding"], source["id"]).records():
            if record.ordinal in requested:
                if not allow_structure and any(not issue.get('field') for issue in record.issues):
                    raise ApiError(422, "source_structure_requires_review",
                                   "Исправление ячейки не исправляет схему или число ячеек источника.")
                records[record.ordinal] = effective_values(record, indexed.get(record.ordinal, []), normalizer=normalizer, bulk_steps=indexed.bulk_steps)
            if record.ordinal >= last_requested:
                break
    except StorageFailure:
        raise ApiError(503, "source_integrity_error", "Сохранённый источник недоступен или повреждён.",
                       retryable=True) from None
    except ValueError:
        raise ApiError(503, "revision_history_error", "Сохранённая история исправлений требует проверки.") from None
    if set(records) != requested:
        raise ApiError(404, "not_found", "Запись не найдена в доступном источнике.")
    return records


def append_revision(db, user, case, previous, source, body, records, *, settings_updates=None, sequence=None):
    """CAS and effective before-values are checked while the caller holds the Case lock."""
    if case.head_revision_id != body.expected_revision_id:
        raise ApiError(409, "revision_conflict", "Текущая ревизия изменилась. Черновик можно сверить с новой версией.")
    if source.id != previous.source_asset_id or body.source_asset_id != source.id:
        raise ApiError(404, "not_found", "Источник не принадлежит указанной ревизии.")
    overlay, settings = deepcopy(previous.correction_overlay), deepcopy(previous.settings)
    if settings_updates:
        settings.update(deepcopy(settings_updates))
    # A newly saved preparation adopts the current policy; historical revisions
    # and their already confirmed artifact bundles remain immutable.
    if not settings.get('retry'):
        settings['filename_policy'] = 'short-output-v1'
        if settings.get('operation') == 'REPAIR':
            from app.domain.output_spec import repair_spec
            settings['output_spec'] = repair_spec(settings['repair_role'])
        if settings.get('operation', 'ADD') in ('ADD', 'DELETE', 'WHITEMAV'):
            from app.domain.output_spec import source_spec
            settings['operation'] = settings.get('operation', 'ADD')
            settings['row_error_policy'] = 'separate-source-errors-v1'
            settings['output_spec'] = source_spec(settings['operation'])
    now = utcnow()
    if body.prefix_msisdn:
        if settings.get('operation') == 'REPAIR' and settings.get('repair_role') != 'NUMBERS':
            raise ApiError(422, 'invalid_correction_field', 'В этом файле нет MSISDN.')
        result = reader_result(db, previous) if previous.assessment_id else None
        overlay.append({'action': 'prefix_ten_digit_msisdn', 'field': 'MSISDN',
                        'source_asset_id': str(source.id), 'author_id': str(user.id),
                        'created_at': now.isoformat(), 'rule_version': 'operator-confirmed-prefix-v2',
                        'mapping_digest': mapping_digest(result['raw_index_key'], result['mapping']) if result else None})
        for values in records.values():
            if 'MSISDN' in values:
                values['MSISDN'] = prefixed_msisdn(values['MSISDN'])
    correction_mapping_digest = None
    for change in body.corrections:
        values = records[change.ordinal]
        if change.field not in values:
            raise ApiError(422, 'invalid_correction_field', 'Поле отсутствует в контракте операции.')
        format_only_before = (label_linebreaks(change.field, ordinary_spaces(change.before)) == values[change.field]
                              or change.field == 'INN' and trim_inn(ordinary_spaces(change.before)) == values[change.field]
                              or change.field == 'MSISDN' and clean_msisdn(change.before) == values[change.field])
        if values[change.field] != change.before and not format_only_before:
            raise ApiError(409, "before_value_conflict", "Значение поля изменилось. Исправление не принято.")
        accepted = change.model_dump(mode='json')
        normalized_after = label_linebreaks(change.field, ordinary_spaces(change.after))
        if normalized_after != change.after:
            accepted['submitted_after'] = change.after
            accepted['after'] = normalized_after
        if values[change.field] != change.before:
            # Old completed pages retain their original spaces. Pin the new
            # replay chain to today's normalized value and retain the request.
            accepted['submitted_before'] = change.before
            accepted['before'] = values[change.field]
        overlay.append({**accepted, "source_asset_id": str(source.id),
                        "author_id": str(user.id), "created_at": now.isoformat(), "rule_version": "manual-v1"})
        if previous.assessment_id:
            if correction_mapping_digest is None:
                result = reader_result(db, previous)
                correction_mapping_digest = mapping_digest(result['raw_index_key'], result['mapping'])
            overlay[-1]['mapping_digest'] = correction_mapping_digest
        values[change.field] = accepted['after']
    if body.bulk_labels:
        result = reader_result(db, previous)
        fields = result.get('record_fields', (*result['mapping'], *result.get('field_defaults', {}))) if result else HUB_COLUMNS
        if settings.get('operation') not in ('ADD', 'CHANGE', 'REPAIR') or not body.bulk_labels.keys() <= set(fields):
            raise ApiError(422, 'invalid_correction_field', 'Этикетка отсутствует в контракте операции.')
        labels = {field: ordinary_spaces(value).strip() for field, value in body.bulk_labels.items()}
        if any(not value or len(value) > 32 or not label_script_valid(field, value)
               for field, value in labels.items()):
            raise ApiError(422, 'invalid_bulk_label', 'Введите допустимую этикетку длиной от 1 до 32 символов.')
        overlay.append({'action': 'replace_labels', 'labels': labels, 'source_asset_id': str(source.id),
                        'author_id': str(user.id), 'created_at': now.isoformat(), 'rule_version': 'bulk-labels-v1',
                        'mapping_digest': mapping_digest(result['raw_index_key'], result['mapping']) if result else None})
    if body.row_selections:
        selections = settings.setdefault('row_selections', {})
        history = settings.setdefault('row_selection_history', [])
        digest = None
        if previous.assessment_id:
            result = reader_result(db, previous)
            digest = mapping_digest(result['raw_index_key'], result['mapping'])
        for change in body.row_selections:
            key = str(change.record_id)
            if selections.get(key, {}).get('excluded', False) != change.before:
                raise ApiError(409, 'row_selection_conflict', 'Отметка строки изменилась. Обновите данные.')
            accepted = {**change.model_dump(mode='json'), 'source_asset_id': str(source.id),
                        'author_id': str(user.id), 'created_at': now.isoformat(), 'mapping_digest': digest}
            selections[key] = accepted
            history.append(accepted)
    if body.overrides and settings.get('operation') == 'WHITEMAV':
        raise ApiError(422, 'fixed_whitemav_profile', 'Параметры WhiteMAV фиксированы.')
    if body.overrides:
        require_permission(user, "profile.override")
        overrides = settings.setdefault("profile_overrides", {})
        history = settings.setdefault("profile_override_history", [])
        for change in body.overrides:
            if change.field == "SPREADING" and change.after not in ("0", "1"):
                raise ApiError(422, "invalid_profile_override", "Override не соответствует обязательному полю профиля.")
            before = overrides.get(change.field, {}).get("after", previous.profile_snapshot.get(change.field, ""))
            if before != change.before:
                raise ApiError(409, "before_value_conflict", "Значение настройки изменилось. Override не принят.")
            accepted = {**change.model_dump(mode="json"), "scope": "revision", "author_id": str(user.id),
                        "created_at": now.isoformat(), "profile_value": previous.profile_snapshot.get(change.field, ""),
                        "profile_version_id": str(previous.profile_version_id)}
            overrides[change.field] = accepted
            history.append(accepted)
    profile_snapshot, profile_version_id = previous.profile_snapshot, previous.profile_version_id
    if settings.get('operation') == 'WHITEMAV':
        from app.domain.whitemav import fixed_profile
        profile = fixed_profile(db)
        profile_snapshot, profile_version_id = profile.snapshot, profile.id
    profile_values(profile_snapshot, settings)
    revision_id, sequence = uuid4(), sequence or previous.sequence + 1
    configuration = {"profile": profile_snapshot, "settings": settings, "correction_overlay": overlay}
    if previous.assessment_id:
        configuration['assessment_id'] = str(previous.assessment_id)
    revision = ProcessingRevision(
        id=revision_id, case_id=case.id, source_asset_id=source.id, parent_revision_id=previous.id,
        assessment_id=previous.assessment_id,
        sequence=sequence, created_by=user.id, profile_version_id=profile_version_id,
        profile_snapshot=deepcopy(profile_snapshot), settings=settings, correction_overlay=overlay,
        config_hash=canonical_digest(configuration),
        rules_version=previous.rules_version, serializer_version=previous.serializer_version,
        export_timestamp=now, export_timezone=previous.export_timezone,
        filename_components=capture_filename_components(case.id, revision_id, sequence, source.filename))
    if settings.get('rules_snapshot'):
        revision.filename_components['partner'] = ('WhiteMAV' if settings.get('operation') == 'WHITEMAV'
                else partner_filename_token(previous.profile_snapshot['partner']))
    if settings.get('output_spec'):
        revision.filename_components['operation'] = settings['operation']
    db.add(revision)
    db.flush()
    case.head_revision_id = revision.id
    from app.domain.change import link_scope
    link_scope(db, revision)
    return revision


def save_draft(db, user, case_id, body, storage, *, action="revision.save"):
    """Return an operation without committing. Receipts replay before stale-head checks."""
    case = owned_case(db, user, case_id, permission_name="case.edit")
    request_body = body.model_dump(mode='json', exclude={'operation_id'})
    if not request_body['row_selections']:
        request_body.pop('row_selections')  # Preserve receipts for commands issued before this field existed.
    if not request_body['prefix_msisdn']:
        request_body.pop('prefix_msisdn')
    if not request_body['bulk_labels']:
        request_body.pop('bulk_labels')
    digest = canonical_digest(request_body)
    existing = find_operation(db, user.id, case.id, action, body.operation_id, digest)
    if existing:
        return existing
    previous = scoped_object(db, user, ProcessingRevision, body.expected_revision_id, case_id=case_id,
                             permission_name="case.edit")
    if previous.settings.get("retry"):
        raise ApiError(409, "retry_recompute_required", "Исправьте и пересчитайте повтор через его сверку.")
    source = scoped_object(db, user, SourceAsset, body.source_asset_id, case_id=case_id,
                           permission_name="case.edit")
    if previous.source_asset_id != source.id:
        raise ApiError(404, "not_found", "Источник не принадлежит указанной ревизии.")
    if case.head_revision_id != previous.id:
        raise ApiError(409, "revision_conflict", "Текущая ревизия изменилась. Исправления не приняты.")
    if body.overrides:
        require_permission(user, "profile.override")
    source_info = {key: getattr(source, key) for key in ("id", "storage_key", "sha256", "size_bytes", "encoding")}
    source_info['reader_result'] = reader_result(db, previous)
    source_info['rules_snapshot'] = deepcopy(previous.settings.get('rules_snapshot'))
    source_info['partner_flags'] = previous.settings.get('partner_flags')
    overlay = deepcopy(previous.correction_overlay)
    db.rollback()  # Expensive source reads do not retain a DB transaction or Case lock.
    records = source_records(storage, source_info, overlay, body.corrections)
    source_records(storage, source_info, overlay, body.row_selections, allow_structure=True)
    case = owned_case(db, user, case_id, permission_name="case.edit", lock=True)
    existing = find_operation(db, user.id, case.id, action, body.operation_id, digest)
    if existing:
        return existing
    previous = scoped_object(db, user, ProcessingRevision, body.expected_revision_id, case_id=case_id,
                             permission_name="case.edit")
    source = scoped_object(db, user, SourceAsset, body.source_asset_id, case_id=case_id,
                           permission_name="case.edit")
    revision = append_revision(db, user, case, previous, source, body, records)
    operation = Operation(owner_id=user.id, case_id=case.id, action=action,
                          client_operation_id=body.operation_id, request_digest=digest)
    db.add(operation)
    db.flush()
    complete_operation(operation, {"revision": revision_view(revision, source)})
    db.add(AuditEvent(case_id=case.id, revision_id=revision.id, actor_id=user.id, action=action,
                      operation_id=operation.id, details={"parent_revision_id": str(previous.id),
                      "correction_count": len(body.corrections), "row_selection_count": len(body.row_selections),
                      "override_fields": [c.field for c in body.overrides]}))
    return operation
