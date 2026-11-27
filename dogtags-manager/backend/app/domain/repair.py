"""Streaming returned-file repair with explicit actions and complete source coverage.

STATUS is a routing instruction, never evidence of external acceptance. Every row
is validated from its effective cells before it can enter an import projection.
"""
import json
from dataclasses import replace
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from app.domain.canonical import CanonicalDataset, ISSUE_SCHEMA, NORMALIZATION_SCHEMA, connection, sql_path, write_rows, add_assignment_flag_warnings
from app.domain.corrections import effective_values, overlay_index
from app.domain.row_selections import excluded_records, install_exclusions, verify_selection
from app.domain.rules import Normalizer
from app.domain.validation import validate_record

REPAIR_VERSION = 'repair-canonical-v2'
SOURCE_FIELDS = {
    'CLIENTS': ('COMPANY_NAME', 'COMPANY_CONTRACT', 'MAV_OPERATOR_NAME', 'INN'),
    'DOGTAGS': ('INN', 'MAV_LABEL_NAME', 'MAV_LABEL_LATIN', 'IS_ACTIVE'),
    'NUMBERS': ('INN', 'MAV_LABEL_NAME', 'MSISDN', 'IS_MAV', 'IS_KSS', 'SPREADING', 'INTERNAL_OPERATOR_NAME'),
}
ERROR_DATA_FIELDS = tuple(dict.fromkeys(field for fields in SOURCE_FIELDS.values() for field in fields))
ERROR_COLUMNS = (*ERROR_DATA_FIELDS, 'STATUS', 'SOURCE_ROW', 'ERROR_FIELDS', 'ERROR_MESSAGES')
REPAIR_ROLES = {name: name for name in ('raw', 'effective', 'records', 'issues', 'lineage')}
REPAIR_ROLES.update(CLIENTS='clients', DOGTAGS='dogtags', NUMBERS='numbers', DELETE='deletions', ERRORS='errors', ERROR_OTHER_OPERATOR='other_operators')
OUTPUT_ORDER = ('CLIENTS', 'DOGTAGS', 'NUMBERS', 'DELETE', 'ERRORS', 'ERROR_OTHER_OPERATOR')

LABEL_STATUSES = (
    'Длина MAV_LABEL не должна превышать 32 символа или имеются некорретные символы',
    'Длина MAV_LABEL не должна превышать 32 символа или имеются некорректные символы',
)
STATUS_ACTIONS = {
    'CLIENTS': {'ИНН уже есть в списке MAV клиентов': 'skip'},
    'DOGTAGS': {'Указанный MAV_LABEL уже есть у данного клиента': 'skip',
                'ИНН отсутствует в таблице MAV клиентов': 'client',
                **{status: 'main' for status in LABEL_STATUSES}},
    'NUMBERS': {'Номер телефона уже есть в таблице MAV номеров': 'delete',
                'MAV_LABEL_NAME отсутствует в таблице этикеток': 'skip',
                'MAV_LABEL_NAME отсутствуют в таблице этикеток': 'skip',
                'ИНН отсутствует в таблице MAV клиентов': 'client',
                **{status: 'main' for status in LABEL_STATUSES}},
}


def _validate(values, role):
    # Reuse the published INN checksum and alphabet rules while validating only
    # fields that belong to this returned-file contract.
    hub = {'INN': values['INN'], 'MSISDN': '79000000000', 'MAV_LABEL_NAME': 'А',
           'MAV_LABEL_LATIN': 'A', 'IS_MAV': '0', 'IS_KSS': '0'}
    hub.update({field: values[field] for field in hub if field in values})
    issues = [issue for issue in validate_record(hub) if issue['field'] in SOURCE_FIELDS[role]]
    if role == 'DOGTAGS' and values['IS_ACTIVE'] != '1':
        issues.append({'field': 'IS_ACTIVE', 'code': 'active_value', 'message': 'IS_ACTIVE должен быть строкой 1.'})
    if role == 'NUMBERS':
        if values['SPREADING'] not in ('0', '1'):
            issues.append({'field': 'SPREADING', 'code': 'flag_value', 'message': 'SPREADING принимает только строку 0 или 1.'})
    for field in SOURCE_FIELDS[role]:
        try:
            values[field].encode('cp1251', errors='strict')
        except UnicodeEncodeError:
            issues.append({'field': field, 'code': 'output_encoding_error',
                           'message': 'Значение не представимо в Windows-1251 импортного файла; исходные символы сохранены в ERRORS.'})
    return issues


def _error_query(role, records='records', issues='issues', *, other_operator=False, operator_guard=False):
    columns = ','.join(f'r.{field}' if field in SOURCE_FIELDS[role] or (operator_guard and field == 'MAV_OPERATOR_NAME') else f"''::VARCHAR AS {field}"
                       for field in ERROR_DATA_FIELDS)
    selection = ("r.repair_action='other_operator' AND r.disposition<>'excluded_manual'" if other_operator else
                 "r.disposition IN ('excluded_error','conflict') AND r.repair_action<>'other_operator'")
    return f'''SELECT {columns},r.STATUS,CAST(r.ordinal AS VARCHAR) AS SOURCE_ROW,
        diagnostics.ERROR_FIELDS,diagnostics.ERROR_MESSAGES,r.ordinal AS page_index
        FROM {records} r JOIN (SELECT record_id,
            string_agg(DISTINCT CASE WHEN field='' THEN 'SOURCE_ROW' ELSE field END,
                '; ' ORDER BY CASE WHEN field='' THEN 'SOURCE_ROW' ELSE field END) AS ERROR_FIELDS,
            string_agg(message, '\n' ORDER BY scope,field,code,message) AS ERROR_MESSAGES
            FROM {issues} WHERE scope<>'warning' GROUP BY record_id) diagnostics USING(record_id)
        WHERE {selection}'''


def _projection_queries(role, records='records', issues='issues', *, operator_guard=False):
    main = f"FROM {records} WHERE disposition='included'"
    clients = (f'SELECT COMPANY_NAME,COMPANY_CONTRACT,MAV_OPERATOR_NAME,INN,ordinal AS page_index {main}'
               if role == 'CLIENTS' else f'''SELECT ''::VARCHAR AS COMPANY_NAME,''::VARCHAR AS COMPANY_CONTRACT,
                   ''::VARCHAR AS MAV_OPERATOR_NAME,INN,min(ordinal) AS page_index FROM {records} r
                   WHERE disposition<>'excluded_manual' AND repair_action='client'
                   AND NOT EXISTS (SELECT 1 FROM {issues} i WHERE i.record_id=r.record_id
                       AND i.scope<>'warning' AND coalesce(i.field,'') IN ('','INN')) GROUP BY INN''')
    dogtags = (f"SELECT INN,MAV_LABEL_NAME AS MAV_LABEL,MAV_LABEL_LATIN,'1'::VARCHAR AS IS_ACTIVE,ordinal AS page_index {main}"
               if role == 'DOGTAGS' else "SELECT ''::VARCHAR AS INN,''::VARCHAR AS MAV_LABEL,"
               "''::VARCHAR AS MAV_LABEL_LATIN,''::VARCHAR AS IS_ACTIVE,0::BIGINT AS page_index WHERE false")
    numbers = (f"SELECT {','.join(SOURCE_FIELDS['NUMBERS'])},ordinal AS page_index {main}"
               if role == 'NUMBERS' else 'SELECT ' + ','.join(f"''::VARCHAR AS {f}" for f in SOURCE_FIELDS['NUMBERS'])
               + ',0::BIGINT AS page_index WHERE false')
    # Recovery uses the relevant validated key even when another cell requires
    # ERRORS review. Main imports still require complete row validation.
    deletions = (f"SELECT MSISDN,min(ordinal) AS page_index FROM {records} r "
                 "WHERE disposition<>'excluded_manual' AND repair_action='delete' "
                 f"AND NOT EXISTS (SELECT 1 FROM {issues} i WHERE i.record_id=r.record_id "
                 "AND i.scope<>'warning' AND coalesce(i.field,'') IN ('','MSISDN')) GROUP BY MSISDN"
                 if role == 'NUMBERS' else "SELECT ''::VARCHAR AS MSISDN,0::BIGINT AS page_index WHERE false")
    return {'CLIENTS': clients, 'DOGTAGS': dogtags, 'NUMBERS': numbers, 'DELETE': deletions,
            'ERRORS': _error_query(role, records, issues, operator_guard=operator_guard),
            'ERROR_OTHER_OPERATOR': _error_query(role, records, issues, other_operator=True, operator_guard=operator_guard)}


def reconcile_repair(db, directory, summary):
    """Check source identities, representatives, lineage, and all projection cells."""
    directory = Path(directory)
    role = summary['repair_role']
    for name in REPAIR_ROLES.values():
        db.read_parquet(str(directory / f'{name}.parquet')).create_view(f'checked_{name}', replace=True)
    unaccounted = 0
    for name in ('raw', 'effective', 'records', 'lineage'):
        unaccounted += db.execute(f'SELECT count(*)-count(DISTINCT record_id) FROM checked_{name}').fetchone()[0]
        unaccounted += db.execute(f'SELECT count(*)-count(DISTINCT ordinal) FROM checked_{name}').fetchone()[0]
        unaccounted += db.execute(f'SELECT count(*) FROM checked_{name} WHERE page_index IS DISTINCT FROM ordinal').fetchone()[0]
        if name != 'raw':
            for left, right in [('raw', name), (name, 'raw')]:
                unaccounted += db.execute(f'SELECT count(*) FROM (SELECT record_id,ordinal FROM checked_{left} '
                    f'EXCEPT SELECT record_id,ordinal FROM checked_{right})').fetchone()[0]
    unaccounted += db.execute('SELECT count(*) FROM checked_effective e JOIN checked_raw r USING(record_id) '
        'WHERE e.raw_cells IS DISTINCT FROM r.raw_cells OR e.line_start IS DISTINCT FROM r.line_start '
        'OR e.line_end IS DISTINCT FROM r.line_end').fetchone()[0]
    unaccounted += db.execute('SELECT count(*) FROM checked_issues i LEFT JOIN checked_raw r USING(record_id) '
        'WHERE r.record_id IS NULL OR i.ordinal IS DISTINCT FROM r.ordinal').fetchone()[0]
    source_count, minimum, maximum = db.execute('SELECT count(*),min(ordinal),max(ordinal) FROM checked_raw').fetchone()
    if source_count != summary['parsed_records'] or (source_count and (minimum != 1 or maximum != source_count)):
        unaccounted += 1
    fields = summary['record_fields']
    unaccounted += db.execute('SELECT count(*) FROM checked_records r JOIN checked_effective e USING(record_id) WHERE '
        + ' OR '.join(f'r.{field} IS DISTINCT FROM e.{field}' for field in (*fields, 'repair_action', 'raw_cells', 'effective_cells'))).fetchone()[0]
    unaccounted += db.execute("SELECT count(*) FROM checked_records WHERE disposition NOT IN "
        "('included','exact_duplicate','excluded_error','excluded_manual','conflict','agreed_skip') OR disposition IS NULL").fetchone()[0]
    unaccounted += db.execute("SELECT count(*) FROM checked_records WHERE disposition NOT IN "
        "('included','exact_duplicate') AND representative_id IS DISTINCT FROM record_id").fetchone()[0]
    unaccounted += db.execute("SELECT count(*) FROM checked_records r WHERE "
        "(disposition IN ('included','exact_duplicate') AND (repair_action<>'main' OR EXISTS "
        "(SELECT 1 FROM checked_issues i WHERE i.record_id=r.record_id AND i.scope<>'warning'))) OR "
        "(disposition='agreed_skip' AND (repair_action NOT IN ('client','delete','skip') OR EXISTS "
        "(SELECT 1 FROM checked_issues i WHERE i.record_id=r.record_id AND i.scope<>'warning'))) OR "
        "(disposition IN ('excluded_error','conflict') AND NOT EXISTS "
        "(SELECT 1 FROM checked_issues i WHERE i.record_id=r.record_id))").fetchone()[0]
    keys = ('INN',) if role == 'CLIENTS' else SOURCE_FIELDS[role]
    unaccounted += db.execute("SELECT count(*) FROM checked_records r LEFT JOIN checked_records representative "
        "ON representative.record_id=r.representative_id WHERE r.disposition IN ('included','exact_duplicate') AND "
        "(representative.record_id IS NULL OR representative.disposition<>'included' OR "
        + ' OR '.join(f'r.{field} IS DISTINCT FROM representative.{field}' for field in keys) + ')').fetchone()[0]
    lineage_fields = ('record_id', 'ordinal', 'page_index', 'representative_id', 'disposition', 'duplicate_kind', 'repair_action')
    for left, right in [('records', 'lineage'), ('lineage', 'records')]:
        columns = ','.join(lineage_fields)
        unaccounted += db.execute(f'SELECT count(*) FROM (SELECT {columns} FROM checked_{left} '
                                 f'EXCEPT SELECT {columns} FROM checked_{right})').fetchone()[0]
    missing = unexpected = duplicate = 0
    for output_role, expected in _projection_queries(role, 'checked_records', 'checked_issues',
            operator_guard=role == 'NUMBERS' and 'MAV_OPERATOR_NAME' in summary['record_fields']).items():
        name = REPAIR_ROLES[output_role]
        actual = f'SELECT * FROM checked_{name}'
        missing += db.execute(f'SELECT count(*) FROM ({expected} EXCEPT {actual})').fetchone()[0]
        unexpected += db.execute(f'SELECT count(*) FROM ({actual} EXCEPT {expected})').fetchone()[0]
        duplicate += db.execute(f'SELECT count(*) FROM checked_{name}').fetchone()[0] - db.execute(
            f'SELECT count(*) FROM (SELECT DISTINCT * FROM checked_{name})').fetchone()[0]
    return {'complete': not any((unaccounted, missing, unexpected, duplicate)),
            'unaccounted_records': unaccounted, 'missing_assignments': missing,
            'unexpected_assignments': unexpected, 'duplicate_outputs': duplicate}


def build_repair_dataset(path, encoding, source_asset_id, output_directory, profile_snapshot, *, settings=None,
                         correction_overlay=None, chunk_rows=1000, memory_limit='1GiB', threads=1, parsed_source=None):
    settings = settings or {}
    role = settings.get('repair_role')
    if parsed_source is None or role not in SOURCE_FIELDS or chunk_rows < 1 or threads < 1:
        raise ValueError('REPAIR requires a role and an immutable mapped source.')
    fields = (*SOURCE_FIELDS[role], 'STATUS')
    policy_version = settings.get('output_spec', {}).get('version', 'repair-output-v2')
    operator_guard = role == 'NUMBERS' and policy_version == 'repair-output-v3'
    if operator_guard:
        fields = (*fields, 'MAV_OPERATOR_NAME')
    snapshot = settings.get('rules_snapshot')
    normalizer = Normalizer(snapshot) if snapshot else None
    directory = Path(output_directory)
    directory.mkdir(parents=True, exist_ok=False)
    indexed = overlay_index(correction_overlay or [], source_asset_id,
                            mapping_digest=parsed_source.mapping_digest, allowed_fields=fields)
    excluded = excluded_records(settings, source_asset_id, parsed_source)
    seen_corrections, seen_exclusions = set(), set()
    schema = pa.schema([('record_id', pa.string()), ('ordinal', pa.int64()), ('line_start', pa.int64()),
        ('line_end', pa.int64()), ('raw_cells', pa.list_(pa.string())), ('effective_cells', pa.list_(pa.string())),
        *[(field, pa.string()) for field in fields], ('page_index', pa.int64())])
    effective_schema = pa.schema([*schema, ('repair_action', pa.string())])
    raw, effective, issues = [], [], []
    normalizations, normalization_count = [], 0
    normalization_writer = pq.ParquetWriter(directory / 'normalizations.parquet', NORMALIZATION_SCHEMA)
    with (pq.ParquetWriter(directory / 'raw.parquet', schema) as raw_writer,
          pq.ParquetWriter(directory / 'effective.parquet', effective_schema) as effective_writer,
          pq.ParquetWriter(directory / 'issues.parquet', ISSUE_SCHEMA) as issue_writer,
          normalization_writer as rule_writer):
        for original in parsed_source.records():
            verify_selection(original, excluded, seen_exclusions)
            missing = set(fields) - set(original.values)
            optional = set(SOURCE_FIELDS['CLIENTS'][:3]) if role == 'CLIENTS' else {'MAV_OPERATOR_NAME'}
            if missing - optional:
                raise ValueError('Mapped source is missing required REPAIR fields.')
            record = replace(original, values={field: original.values.get(field, '') for field in fields})
            changes = indexed.get(record.ordinal, [])
            if changes:
                if any(not issue.get('field') for issue in record.issues):
                    raise ValueError('Cell corrections cannot repair source structure.')
                seen_corrections.add(record.ordinal)
            automatic_changes = []
            values = effective_values(record, changes, normalizer=normalizer, bulk_steps=indexed.bulk_steps,
                                         normalization_log=automatic_changes)
            applied = normalizer.apply(record.values)[1] if normalizer else []
            for change in [*applied, *automatic_changes]:
                normalization_count += 1
                normalizations.append({'record_id': record.record_id, 'ordinal': record.ordinal,
                                       'page_index': normalization_count, **change})
            changed_fields = {change['field'] for change in changes} | indexed.bulk_label_fields
            remaining = [issue for issue in record.issues if issue.get('field') not in changed_fields]
            remaining.extend(_validate(values, role))
            action = 'main' if values['STATUS'] == '' else STATUS_ACTIONS[role].get(values['STATUS'], 'error')
            if operator_guard and action == 'delete' and values['MAV_OPERATOR_NAME'] != 'mTELE2':
                action = 'other_operator'
                remaining.append({'field': 'MAV_OPERATOR_NAME', 'code': 'other_operator',
                    'message': f"Оператор «{values['MAV_OPERATOR_NAME'] or 'не указан'}» отличается от mTELE2. Строка передана в ERROR OTHER OPERATOR и исключена из DELETE."})
            if action == 'error':
                remaining.append({'field': 'STATUS', 'code': 'status_unresolved',
                    'message': 'STATUS не соответствует подтверждённому действию для этого файла; требуется ручное решение.'})
            raw.append(record.as_arrow_row())
            effective.append({**record.as_arrow_row(values), 'repair_action': action})
            issues.extend({'record_id': record.record_id, 'ordinal': record.ordinal, 'scope': 'cell', **issue}
                          for issue in remaining)
            if len(raw) >= chunk_rows:
                write_rows(raw_writer, raw, schema)
                write_rows(effective_writer, effective, effective_schema)
                write_rows(issue_writer, issues, ISSUE_SCHEMA)
                raw, effective, issues = [], [], []
                if rule_writer:
                    write_rows(rule_writer, normalizations, NORMALIZATION_SCHEMA)
                    normalizations = []
        write_rows(raw_writer, raw, schema)
        write_rows(effective_writer, effective, effective_schema)
        write_rows(issue_writer, issues, ISSUE_SCHEMA)
        if rule_writer:
            write_rows(rule_writer, normalizations, NORMALIZATION_SCHEMA)
    if seen_corrections != set(indexed) or seen_exclusions != set(excluded):
        raise ValueError('Correction or exclusion points to an unparsed source row.')
    summary = {'dataset_version': REPAIR_VERSION, 'operation': 'REPAIR', 'source_asset_id': str(source_asset_id),
               **parsed_source.summary, 'repair_role': role, 'record_fields': list(fields)}
    if summary.get('error_source'):
        summary['error_source'] = {**summary['error_source'], 'utf8_bom': True}
    summary['normalization_count'] = normalization_count
    if snapshot:
        summary.update(rules_version=snapshot['version'], rules_digest=snapshot['digest'])
    with connection(directory / 'work.duckdb', memory_limit=memory_limit, threads=threads,
                    temp_directory=directory / '.spill') as db:
        install_exclusions(db, excluded)
        for name in ('effective', 'issues'):
            db.execute(f'CREATE TABLE {name} AS SELECT * FROM read_parquet(?)', [str(directory / f'{name}.parquet')])
        db.execute('''CREATE VIEW candidates AS SELECT * FROM effective e WHERE repair_action='main'
            AND ordinal NOT IN (SELECT ordinal FROM manual_exclusions)
            AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.record_id=e.record_id)''')
        if role == 'NUMBERS':
            keys = 'INN,MSISDN'
            attributes = 'SPREADING,INTERNAL_OPERATOR_NAME'
            field, code = 'MSISDN', 'assignment_attributes_conflict'
            # Materialize the candidate set before adding issues; otherwise the
            # anti-issue view could change membership during conflict insertion.
            db.execute('CREATE TABLE conflict_candidates AS SELECT * FROM candidates')
            db.execute(f'''INSERT INTO issues SELECT e.record_id,e.ordinal,?,?,?,'global'
                FROM conflict_candidates e JOIN (SELECT {keys} FROM conflict_candidates
                    GROUP BY {keys} HAVING count(DISTINCT ({attributes}))>1) conflicts USING({keys})''',
                [field, code, 'Для одного ключа различаются значения; исправьте или исключите конфликтующие строки.'])
            db.execute('''INSERT INTO issues SELECT e.record_id,e.ordinal,?,?,?,'global'
                FROM conflict_candidates e JOIN (SELECT MSISDN FROM conflict_candidates
                    GROUP BY MSISDN HAVING count(DISTINCT INN)>1) conflicts USING(MSISDN)''',
                ['MSISDN', 'msisdn_assignment_conflict',
                 'Один MSISDN назначен разным ИНН; требуется решение.'])
        duplicate_keys = 'INN' if role == 'CLIENTS' else ','.join(SOURCE_FIELDS[role])
        db.execute(f'''CREATE TABLE grouped AS SELECT record_id,
            min(ordinal) OVER (PARTITION BY {duplicate_keys}) AS representative_ordinal FROM candidates''')
        db.execute('''CREATE TABLE records AS SELECT e.*,
            coalesce(g.representative_ordinal,e.ordinal) AS representative_ordinal,
            coalesce(representative.record_id,e.record_id) AS representative_id,
            CASE WHEN e.ordinal IN (SELECT ordinal FROM manual_exclusions) THEN 'excluded_manual'
                WHEN EXISTS (SELECT 1 FROM issues i WHERE i.record_id=e.record_id AND scope='global') THEN 'conflict'
                WHEN EXISTS (SELECT 1 FROM issues i WHERE i.record_id=e.record_id) THEN 'excluded_error'
                WHEN e.repair_action<>'main' THEN 'agreed_skip'
                WHEN e.ordinal<>g.representative_ordinal THEN 'exact_duplicate' ELSE 'included' END AS disposition,
            CASE WHEN e.ordinal<>g.representative_ordinal THEN 'repair_exact' ELSE '' END AS duplicate_kind
            FROM effective e LEFT JOIN grouped g USING(record_id)
            LEFT JOIN effective representative ON representative.ordinal=g.representative_ordinal''')
        for output_role, query in _projection_queries(role, operator_guard=operator_guard).items():
            db.execute(f'CREATE TABLE {REPAIR_ROLES[output_role]} AS {query}')
        db.execute('''CREATE TABLE lineage AS SELECT record_id,ordinal,page_index,representative_id,
            disposition,duplicate_kind,repair_action FROM records''')
        if role in ('DOGTAGS', 'NUMBERS'):
            from app.domain.label_warnings import add_label_case_warnings, add_label_latin_warnings
            add_label_case_warnings(db, fields=('MAV_LABEL_NAME', 'MAV_LABEL_LATIN') if role == 'DOGTAGS' else ('MAV_LABEL_NAME',))
            add_label_latin_warnings(db)
        if role == 'NUMBERS':
            add_assignment_flag_warnings(db, 'conflict_candidates')
        from app.domain.msisdn_warnings import add_msisdn_cleanup_warnings
        if role == 'NUMBERS':
            add_msisdn_cleanup_warnings(db, directory, indexed)
        db.execute('ALTER TABLE issues ADD COLUMN page_index BIGINT')
        db.execute('''UPDATE issues SET page_index=ordered.idx FROM (SELECT rowid,
            row_number() OVER (ORDER BY ordinal,scope,field,code,message) AS idx FROM issues) ordered
            WHERE issues.rowid=ordered.rowid''')
        for name in ('records', 'issues', 'lineage', 'clients', 'dogtags', 'numbers', 'deletions', 'errors', 'other_operators'):
            db.execute(f'COPY (SELECT * FROM {name} ORDER BY page_index) TO '
                       f"{sql_path(directory / f'{name}.parquet')} (FORMAT PARQUET)")
        counts = {output_role: db.execute(f'SELECT count(*) FROM {REPAIR_ROLES[output_role]}').fetchone()[0]
                  for output_role in OUTPUT_ORDER}
        summary['counts'] = {output_role: count for output_role, count in counts.items() if count}
        summary['dispositions'] = dict(db.execute('SELECT disposition,count(*) FROM records GROUP BY disposition').fetchall())
        summary['issue_counts'] = dict(db.execute("SELECT code,count(*) FROM issues WHERE code<>'label_contains_latin' GROUP BY code").fetchall())
        summary['reconciliation'] = reconcile_repair(db, directory, summary)
    (directory / 'work.duckdb').unlink()
    from app.domain.output_spec import repair_spec
    # An empty bundle is blocked; pin the full contract so it remains reviewable.
    summary['output_spec'] = repair_spec(role, list(summary['counts']) or None,
        version=settings.get('output_spec', {}).get('version', 'repair-output-v2'))
    summary['blocking'] = bool(summary['file_errors'] or summary.get('unknown_remainder')
                               or not summary['reconciliation']['complete'] or not summary['counts'])
    if not summary['counts']:
        summary['blocking_reason'] = 'После обработки не осталось строк для выходных файлов.'
    (directory / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False), encoding='utf-8')
    return CanonicalDataset(directory, summary, memory_limit, threads)
