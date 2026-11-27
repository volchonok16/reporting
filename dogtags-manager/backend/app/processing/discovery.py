"""DISCOVER publishes an immutable assessment; completion enqueues BUILD in the same transaction."""
from copy import deepcopy
from uuid import uuid4

from sqlalchemy import select

from app.admin.publish_rules import published_profile
from app.api.processing import enqueue
from app.domain.ingress import HUB_COLUMNS
from app.domain.manifest import capture_filename_components
from app.domain.operations import canonical_digest
from app.domain.output_spec import output_spec
from app.domain.readers.base import mapping_digest, publish_raw_index, read_raw_index
from app.domain.readers.dispatch import ADD_FIELD_DEFAULTS
from app.domain.readers.containers import ExcelLimits, WorkbookError, detect_format
from app.domain.readers.csv_reader import CSVTable, discover_csv
from app.domain.readers.mapping import map_columns
from app.domain.readers.xlsx_reader import XLSXTable, discover_xlsx
from app.domain.readers.xls_reader import XLSTable, discover_xls
from app.domain.readers.xlsb_reader import XLSBTable, discover_xlsb
from app.domain.readers.numbers_reader import NumbersTable, discover_numbers
from app.domain.rules import PARTNER_FLAG_FIELDS, PARTNER_NAMES, checked_config, partner_filename_token, resolve_partner
from app.models import Intake, IntakeAssessment, IntakeVersion, ProcessingRevision, SourceAsset, utcnow
from app.processing.leases import audit, clear_lease, database_now, locked_run, owns_lease


def question(field, code, message, **details):
    return {'field': field, 'code': code, 'message': message, **details}


def assess(sessions, lease, settings, storage, directory, checkpoint=lambda: None):
    with sessions() as db:
        _, run = locked_run(db, lease.run_id)
        version = db.get(IntakeVersion, run.intake_version_id)
        source = db.get(SourceAsset, version.source_asset_id)
        decisions = version.decisions
        from app.domain.returns import return_context
        context = return_context(db, version)
        db.commit()
    path = storage.verify(source.storage_key, source.sha256, source.size_bytes)
    snapshot = decisions.get('rules_snapshot')
    questions, result = [], {}
    aliases = checked_config(snapshot)['aliases'] if snapshot else None
    if not snapshot:
        questions.append(question('rules', 'rules_setup_required', 'Администратору нужно опубликовать правила обработки.'))
    profiles = checked_config(snapshot)['profiles'] if snapshot else {}
    chosen = decisions.get('partner')
    partner = (resolve_partner(snapshot, manual=chosen) if snapshot and (chosen is None or chosen in profiles)
               else {'partner': None})
    if context:
        partner = {'partner': context['profile_snapshot'].get('partner'), 'reason': 'return_artifact', 'rules': []}
        result['return_context'] = context
    if decisions.get('operation') == 'WHITEMAV':
        partner = {'partner': 'WhiteMAV', 'reason': 'fixed_whitemav_contract', 'rules': []}
    result['partner'] = partner
    if not partner['partner'] and not context:
        questions.append(question('partner', 'partner_required', 'Выберите отправителя файла.',
                                  options=list(profiles or PARTNER_NAMES)))
    format_name = detect_format(path)
    selected = decisions.get('reader')
    table = None
    try:
        limits = ExcelLimits.from_settings(settings)
        result['format'] = format_name if format_name != 'unknown' else 'csv'
        if format_name in ('xlsx', 'xls', 'xlsb', 'numbers'):
            discover, table_class = {'xlsx': (discover_xlsx, XLSXTable), 'xls': (discover_xls, XLSTable),
                                     'xlsb': (discover_xlsb, XLSBTable), 'numbers': (discover_numbers, NumbersTable)}[format_name]
            found = discover(path, aliases=aliases, limits=limits, number_only=decisions.get('operation') == 'WHITEMAV')
            result.update(format=format_name, inventory=found['inventory'], candidates=found['candidates'],
                          limitations=found.get('limitations', []))
            choices = found['candidates']
            # An unrecognized nonempty sheet is still plausible and cannot disappear silently.
            unknown = [item for item in found['inventory'] if item['first_row'] and not item['candidate_count']]
            reader = (choices[0]['reader'] if len(choices) == 1 and not unknown else None)
            if selected:
                if selected['format'] != format_name:
                    raise ValueError('reader_format_mismatch')
                reader = {k: v for k, v in selected.items() if k != 'format'}
            if reader:
                table = table_class(path, source.id, **reader, limits=limits)
                result['reader'] = {'format': format_name, **reader}
        else:
            choices = discover_csv(path, aliases=aliases, returned=decisions.get('operation') == 'REPAIR',
                                   number_only=decisions.get('operation') == 'WHITEMAV')
            result.update(format='csv', candidates=choices, inventory=[])
            reader = choices[0]['reader'] if len(choices) == 1 else None
            if selected:
                if selected['format'] != 'csv':
                    raise ValueError('reader_format_mismatch')
                reader = {k: v for k, v in selected.items() if k != 'format'}
            if reader:
                table = CSVTable(path, source.id, **reader)
                result['reader'] = {'format': 'csv', **reader}
        if table:
            key = publish_raw_index(table, storage, directory)
            index = read_raw_index(storage, key)
            result.update(raw_index_key=key, columns=index['columns'], summary=index['summary'])
            auto = map_columns(index['columns'], aliases)
            operation = decisions.get('operation')
            if operation is None:
                if map_columns(index['columns'], aliases, ('STATUS',))['complete']:
                    operation = 'STATUS'
                elif set(HUB_COLUMNS) - ADD_FIELD_DEFAULTS.keys() <= auto['mapping'].keys():
                    operation = 'ADD'
                elif len(index['columns']) == 1 and map_columns(index['columns'], aliases, ('MSISDN',))['complete']:
                    operation = 'DELETE'
            result['operation'] = operation
            if not operation:
                questions.append(question('operation', 'operation_required', 'Выберите назначение файла.',
                                           options=['ADD', 'DELETE', 'CHANGE', 'STATUS']))
            if operation == 'REPAIR':
                from app.domain.repair_intake import configure_repair
                configure_repair(result, questions, decisions, aliases)
            else:
                required = HUB_COLUMNS if operation in (None, 'ADD', 'CHANGE') else ('MSISDN',)
                mapped = map_columns(index['columns'], aliases, required)
                mapping = decisions.get('mapping') if decisions.get('mapping') is not None else mapped['mapping']
                is_assignment = operation in ('ADD', 'CHANGE')
                explicit_mapping = decisions.get('mapping') is not None
                minimum = (set() if is_assignment and explicit_mapping
                           else set(required) - ADD_FIELD_DEFAULTS.keys())
                complete = (minimum <= set(mapping) <= set(required) and len(set(mapping.values())) == len(mapping)
                            and all(type(i) is int and 0 <= i < len(index['columns']) for i in mapping.values())
                            and (decisions.get('mapping') is not None or not mapped['ambiguous']))
                defaults = {field: value for field, value in ADD_FIELD_DEFAULTS.items()
                            if field in required and field not in mapping}
                if is_assignment and explicit_mapping:
                    flags = decisions.get('missing_flags')
                    defaults = {field: (flags if flags is not None else ADD_FIELD_DEFAULTS).get(field, '') for field in required if field not in mapping}
                result.update(mapping=mapping, mapping_analysis=mapped, field_defaults=defaults)
                if not complete:
                    questions.append(question('mapping', 'mapping_required', 'Уточните соответствие колонок. Отсутствующие параметры назначения можно заполнить при обработке.',
                                              required=sorted(minimum), columns=index['columns']))
            if operation == 'CHANGE':
                if not decisions.get('delete_scope'):
                    questions.append(question('delete_scope', 'delete_scope_required',
                        'Выберите и подтвердите подготовленный DELETE или NUMBERS со старыми номерами. '
                        'При необходимости загрузите старый список отдельно как DELETE.'))
                else:
                    result['delete_scope'] = decisions['delete_scope']
            if operation == 'STATUS':
                from app.domain.returns import configure_return
                configure_return(result, questions, decisions, aliases, context)
        else:
            questions.append(question('reader', 'reader_required', 'Выберите способ чтения и таблицу исходника.'))
    except (WorkbookError, ValueError) as error:
        questions.append(question('reader', getattr(error, 'code', 'reader_selection_invalid'),
                                  getattr(error, 'message', 'Выбранный способ чтения или диапазон недопустим.')))
    response = {'result': result, 'questions': questions, 'reader_version': table.reader_version if table else None}
    if result.get('operation') == 'STATUS' and not questions:
        from app.domain.returns import assess_return
        response['prepared_return'] = assess_return(sessions, version, result, storage, directory, checkpoint)
        counts = response['prepared_return']['counts']
        result['return_counts'] = counts
        if result['summary'].get('unknown_remainder') or result['summary'].get('file_errors'):
            questions.append(question('reconciliation', 'return_source_incomplete',
                'Исходная таблица прочитана не полностью или содержит ошибки; требуется сверка.'))
        if set(counts) - {'APPLIED', 'REJECTED'}:
            questions.append(question('reconciliation', 'return_rows_unresolved',
                'Есть неизвестные, отсутствующие или несопоставленные строки; требуется сверка.', counts=counts))
    return response


def finish_discovery(sessions, lease, assessment_data, settings):
    if assessment_data.get('prepared_return'):
        from app.domain.returns import finish_return
        return finish_return(sessions, lease, assessment_data)
    with sessions() as db, db.begin():
        case, run = locked_run(db, lease.run_id)
        if not owns_lease(run, lease, database_now(db)):
            return False
        version = db.get(IntakeVersion, run.intake_version_id)
        intake = db.get(Intake, version.intake_id)
        if intake.current_version_id != version.id or case.head_revision_id is not None:
            clear_lease(run)
            run.state = 'SUPERSEDED'
            if intake.current_version_id == version.id:
                intake.state = 'SUPERSEDED'
            audit(db, run, 'discovery.superseded', {})
            return False
        previous = db.scalar(select(ProcessingRevision).where(ProcessingRevision.case_id == case.id)
                             .order_by(ProcessingRevision.sequence.desc()).limit(1))
        overlay = deepcopy(previous.correction_overlay) if previous else []
        selections = deepcopy(previous.settings.get('row_selections', {})) if previous else {}
        result = assessment_data['result']
        if (overlay or selections) and not assessment_data['questions']:
            digest = mapping_digest(result['raw_index_key'], result['mapping'])
            if any(change.get('mapping_digest') != digest for change in [*overlay, *selections.values()]):
                assessment_data['questions'].append(question('mapping', 'saved_corrections_mapping_conflict',
                    'Сохранённые исправления относятся к прежнему чтению и сопоставлению колонок. '
                    'Верните прежний выбор либо загрузите файл отдельно: исправления нельзя перенести однозначно.'))
        assessment = IntakeAssessment(case_id=case.id, intake_id=intake.id, source_asset_id=intake.source_asset_id,
                                      intake_version_id=version.id, **assessment_data)
        db.add(assessment)
        db.flush()
        intake.current_assessment_id = assessment.id
        run.summary = {'assessment_id': str(assessment.id), 'question_count': len(assessment.questions)}
        run.progress = {'stage': 'complete', 'percent': 100}
        intake.state = 'NEEDS_DECISION' if assessment.questions else 'PROCESSING'
        if not assessment.questions:
            snapshot = version.decisions['rules_snapshot']
            partner = assessment.result['partner']['partner']
            if assessment.result['operation'] == 'WHITEMAV':
                from app.domain.whitemav import fixed_profile
                profile = fixed_profile(db)
            else:
                profile = published_profile(db, snapshot, partner)
            sequence, revision_id = (previous.sequence + 1 if previous else 1), uuid4()
            source = db.get(SourceAsset, intake.source_asset_id)
            saved_settings = {'rules_snapshot': snapshot, 'partner_attribution': assessment.result['partner'],
                              'operation': assessment.result['operation'],
                              'output_spec': output_spec(assessment.result['operation']),
                              'filename_policy': 'short-output-v1'}
            if assessment.result['operation'] in ('ADD', 'CHANGE'):
                flags = {field: profile.snapshot[field] for field in PARTNER_FLAG_FIELDS if field in profile.snapshot}
                if flags:
                    saved_settings['partner_flags'] = flags
            if assessment.result['operation'] == 'WHITEMAV':
                from app.domain.whitemav_inns import DEFAULT_INNS
                saved_settings['whitemav_inn'] = version.decisions.get('whitemav_inn', DEFAULT_INNS[0])
            if assessment.result['operation'] in ('ADD', 'DELETE', 'WHITEMAV'):
                from app.domain.output_spec import source_spec
                saved_settings.update(row_error_policy='separate-source-errors-v1',
                    output_spec=source_spec(assessment.result['operation']))
            if assessment.result['operation'] == 'REPAIR':
                from app.domain.output_spec import repair_spec
                saved_settings.update(repair_role=assessment.result['repair_role'],
                    repair_policy_version='status-repair-v1',
                    output_spec=repair_spec(assessment.result['repair_role']))
            if assessment.result['operation'] == 'CHANGE':
                saved_settings['delete_scope'] = assessment.result['delete_scope']
            if selections:
                saved_settings['row_selections'] = selections
                saved_settings['row_selection_history'] = deepcopy(previous.settings.get('row_selection_history', []))
            if previous and previous.profile_snapshot.get('partner') == partner:
                for key in ('profile_overrides', 'profile_override_history'):
                    if key in previous.settings:
                        saved_settings[key] = deepcopy(previous.settings[key])
            names = capture_filename_components(case.id, revision_id, sequence, source.filename)
            names['partner'] = 'WhiteMAV' if assessment.result['operation'] == 'WHITEMAV' else partner_filename_token(partner)
            names['operation'] = assessment.result['operation']
            revision = ProcessingRevision(id=revision_id, case_id=case.id, source_asset_id=source.id,
                parent_revision_id=previous.id if previous else None, sequence=sequence, assessment_id=assessment.id,
                created_by=version.created_by, profile_version_id=profile.id, profile_snapshot=profile.snapshot,
                settings=saved_settings, correction_overlay=overlay, rules_version='published-rules-v1',
                config_hash=canonical_digest({'profile': profile.snapshot, 'settings': saved_settings,
                    'assessment_id': str(assessment.id), 'correction_overlay': overlay}),
                export_timestamp=utcnow(), export_timezone=settings.timezone, filename_components=names)
            db.add(revision)
            db.flush()
            case.head_revision_id = revision.id
            from app.domain.change import link_scope
            link_scope(db, revision)
            enqueue(db, revision)
        if not owns_lease(run, lease, database_now(db)):
            db.rollback()
            return False
        run.state = 'COMPLETE'
        clear_lease(run)
        audit(db, run, 'discovery.completed', {'assessment_id': str(assessment.id), 'state': intake.state})
        return True
