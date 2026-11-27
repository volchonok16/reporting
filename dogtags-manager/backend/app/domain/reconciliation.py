"""Coverage is dependency/assignment coverage, never equality of file row counts."""
from pathlib import Path


def reconcile(db, directory, *, numbers_table=None):
    directory = Path(directory)
    db.read_parquet(str(directory / "records.parquet")).create_view("checked_records", replace=True)
    for name in ("clients", "dogtags", "numbers"):
        if name == "numbers" and numbers_table:
            if numbers_table != "numbers":
                raise ValueError("Unsupported projection table.")
            continue
        db.read_parquet(str(directory / f"{name}.parquet")).create_view(f"checked_{name}", replace=True)
    numbers = "numbers" if numbers_table else "checked_numbers"
    active = "SELECT * FROM checked_records WHERE disposition IN ('included','exact_duplicate')"
    db.execute(f"CREATE OR REPLACE VIEW coverage_expected AS {active}")
    missing_assignments = db.execute(f"""
        SELECT count(*) FROM (SELECT DISTINCT INN,MAV_LABEL_NAME,MSISDN,IS_MAV,IS_KSS,
            SPREADING,INTERNAL_OPERATOR_NAME FROM coverage_expected
        EXCEPT SELECT INN,MAV_LABEL_NAME,MSISDN,IS_MAV,IS_KSS,SPREADING,INTERNAL_OPERATOR_NAME FROM {numbers})
        """).fetchone()[0]
    unexpected_assignments = db.execute(f"""
        SELECT count(*) FROM (SELECT INN,MAV_LABEL_NAME,MSISDN,IS_MAV,IS_KSS,
            SPREADING,INTERNAL_OPERATOR_NAME FROM {numbers}
        EXCEPT SELECT DISTINCT INN,MAV_LABEL_NAME,MSISDN,IS_MAV,IS_KSS,SPREADING,INTERNAL_OPERATOR_NAME
            FROM coverage_expected)""").fetchone()[0]
    missing_clients = db.execute("""SELECT count(*) FROM (SELECT DISTINCT INN FROM coverage_expected
        EXCEPT SELECT INN FROM checked_clients)""").fetchone()[0]
    missing_labels = db.execute("""SELECT count(*) FROM (SELECT DISTINCT INN,MAV_LABEL_NAME,MAV_LABEL_LATIN
        FROM coverage_expected EXCEPT SELECT INN,MAV_LABEL,MAV_LABEL_LATIN FROM checked_dogtags)""").fetchone()[0]
    unaccounted = db.execute("""SELECT count(*) FROM checked_records WHERE disposition NOT IN
        ('included','exact_duplicate','excluded_error','excluded_scientific_inn','excluded_manual','conflict','agreed_skip') OR disposition IS NULL""").fetchone()[0]
    db.read_parquet(str(directory / "raw.parquet")).create_view("checked_raw", replace=True)
    db.read_parquet(str(directory / "lineage.parquet")).create_view("checked_lineage", replace=True)
    for role in ("records", "lineage"):
        missing = db.execute(f"""SELECT count(*) FROM (SELECT record_id FROM checked_raw
            EXCEPT SELECT record_id FROM checked_{role})""").fetchone()[0]
        unexpected = db.execute(f"""SELECT count(*) FROM (SELECT record_id FROM checked_{role}
            EXCEPT SELECT record_id FROM checked_raw)""").fetchone()[0]
        duplicate = db.execute(f"""SELECT count(*)-count(DISTINCT record_id) FROM checked_{role}""").fetchone()[0]
        if role == "records":
            unaccounted += missing + unexpected + duplicate
        else:
            missing_lineage, unexpected_lineage, duplicate_lineage = missing, unexpected, duplicate
    return {"complete": not any((missing_assignments, unexpected_assignments, missing_clients,
                                missing_labels, unaccounted, missing_lineage, unexpected_lineage, duplicate_lineage)),
            "missing_assignments": missing_assignments, "unexpected_assignments": unexpected_assignments,
            "missing_clients": missing_clients, "missing_labels": missing_labels, "unaccounted_records": unaccounted,
            "missing_lineage": missing_lineage, "unexpected_lineage": unexpected_lineage,
            "duplicate_lineage": duplicate_lineage}


def reconcile_change(db, directory):
    replacement = reconcile(db, directory)
    for role in ('delete_scope', 'deletions'):
        db.read_parquet(str(Path(directory) / f'{role}.parquet')).create_view(role, replace=True)
    missing = db.execute('SELECT count(*) FROM (SELECT DISTINCT MSISDN FROM delete_scope '
                         'EXCEPT SELECT MSISDN FROM deletions)').fetchone()[0]
    unexpected = db.execute('SELECT count(*) FROM (SELECT MSISDN FROM deletions '
                            'EXCEPT SELECT MSISDN FROM delete_scope)').fetchone()[0]
    duplicate = db.execute('SELECT count(*)-count(DISTINCT MSISDN) FROM deletions').fetchone()[0]
    return {'complete': replacement['complete'] and not any((missing, unexpected, duplicate)),
            'replacement': replacement, 'delete_scope': {'missing': missing, 'unexpected': unexpected,
                                                       'duplicate': duplicate}}


def reconcile_retry(db, directory, summary):
    """Independently derive source membership and closure; ledgers cannot excuse missing outputs."""
    from app.domain.output_spec import file_definition, output_spec
    directory = Path(directory)
    for name in ('applied', 'decisions', 'original_rows', 'original_records', 'selected_records'):
        db.read_parquet(str(directory / f'retry_{name}.parquet')).create_view(f'retry_{name}', replace=True)
    db.read_parquet(str(directory / 'records.parquet')).create_view('retry_records', replace=True)
    role = summary['retry']['role']
    missing = unexpected = duplicate = lineage = 0
    # Export coverage and exact original serialized values, independent of the selection flags.
    for left, right in [('decisions', 'original_rows'), ('original_rows', 'decisions')]:
        lineage += db.execute(f'SELECT count(*) FROM (SELECT export_ordinal FROM retry_{left} '
                              f'EXCEPT SELECT export_ordinal FROM retry_{right})').fetchone()[0]
    lineage += db.execute('SELECT count(*)-count(DISTINCT export_ordinal) FROM retry_decisions').fetchone()[0]
    lineage += db.execute('SELECT count(*)-count(DISTINCT export_row_id) FROM retry_decisions').fetchone()[0]
    fields = file_definition(role, 'DELETE' if role == 'DELETE' else 'ADD')['columns']
    mismatch = ' OR '.join(f"(d.values_json->>'{f}') IS DISTINCT FROM o.{f}" for f in fields)
    lineage += db.execute('SELECT count(*) FROM retry_decisions d JOIN retry_original_rows o USING(export_ordinal) '
                          'WHERE ' + mismatch).fetchone()[0]
    lineage += db.execute("SELECT count(*) FROM retry_decisions WHERE selected AND state NOT IN ('REJECTED','APPLIED')").fetchone()[0]
    allowed = list(summary['retry']['success_reasons'])
    lineage += db.execute("SELECT count(*) FROM retry_decisions WHERE selected AND state='APPLIED' "
                          'AND NOT list_contains(?,export_row_id)', [allowed]).fetchone()[0]
    keys = {'CLIENTS': [('INN', 'INN')],
            'DOGTAGS': [('INN', 'INN'), ('MAV_LABEL_NAME', 'MAV_LABEL'), ('MAV_LABEL_LATIN', 'MAV_LABEL_LATIN')],
            'NUMBERS': [(f, f) for f in file_definition('NUMBERS')['columns']],
            'DELETE': [('MSISDN', 'MSISDN')]}[role]
    match = ' AND '.join(f'old.{left}=o.{right}' for left, right in keys)
    db.execute('CREATE OR REPLACE TEMP VIEW retry_expected_sources AS SELECT DISTINCT old.page_index '
               'FROM retry_original_records old JOIN retry_original_rows o ON ' + match +
               ' JOIN retry_decisions d USING(export_ordinal) WHERE d.selected')
    for left, right in [('expected_sources', 'selected_records'), ('selected_records', 'expected_sources')]:
        lineage += db.execute(f'SELECT count(*) FROM (SELECT page_index FROM retry_{left} '
                              f'EXCEPT SELECT page_index FROM retry_{right})').fetchone()[0]
    lineage += db.execute('SELECT count(*)-count(DISTINCT page_index) FROM retry_selected_records').fetchone()[0]
    # Every selected export must still have a source (including dependency rows shared by many numbers).
    lineage += db.execute('SELECT count(*) FROM retry_decisions d WHERE d.selected AND NOT EXISTS '
        '(SELECT 1 FROM retry_original_rows o JOIN retry_original_records old ON ' + match +
        ' WHERE o.export_ordinal=d.export_ordinal)').fetchone()[0]
    source_fields = ['MSISDN'] if role == 'DELETE' else list(file_definition('NUMBERS')['columns']) + ['MAV_LABEL_LATIN']
    lineage += db.execute('SELECT count(*) FROM retry_selected_records s JOIN retry_records r USING(page_index) '
        'WHERE ' + ' OR '.join(f's.{f} IS DISTINCT FROM r.{f}' for f in source_fields)).fetchone()[0]
    expected = {'DELETE': 'SELECT DISTINCT MSISDN FROM retry_selected_records'} if role == 'DELETE' else {
        'CLIENTS': "SELECT DISTINCT '' AS COMPANY_NAME,'' AS COMPANY_CONTRACT,'' AS MAV_OPERATOR_NAME,INN FROM retry_selected_records"}
    if role in ('DOGTAGS', 'NUMBERS'):
        expected['DOGTAGS'] = ("SELECT DISTINCT INN,MAV_LABEL_NAME AS MAV_LABEL,MAV_LABEL_LATIN,'1' AS IS_ACTIVE "
                               'FROM retry_selected_records')
    if role == 'NUMBERS':
        expected['NUMBERS'] = 'SELECT DISTINCT ' + ','.join(file_definition('NUMBERS')['columns']) + ' FROM retry_selected_records'
    for item in output_spec(summary.get('operation', 'ADD'))['roles']:
        name = {'CLIENTS': 'clients', 'DOGTAGS': 'dogtags', 'NUMBERS': 'numbers', 'DELETE': 'deletions'}[item]
        db.read_parquet(str(directory / f'{name}.parquet')).create_view('retry_actual', replace=True)
        db.read_parquet(str(directory / f'retry_wanted_{name}.parquet')).create_view('retry_wanted', replace=True)
        fields = file_definition(item, summary.get('operation', 'ADD'))['columns']
        columns = ','.join(fields)
        wanted = expected.get(item, f'SELECT {columns} FROM retry_wanted WHERE false')
        db.execute('CREATE OR REPLACE TEMP VIEW retry_derived AS ' + wanted)
        recorded = f'SELECT {columns} FROM retry_wanted'
        lineage += db.execute(f'SELECT count(*) FROM ({wanted} EXCEPT {recorded})').fetchone()[0]
        lineage += db.execute(f'SELECT count(*) FROM ({recorded} EXCEPT {wanted})').fetchone()[0]
        excluded = ''
        if item != role:
            excluded = (" WHERE NOT EXISTS (SELECT 1 FROM retry_applied a WHERE a.role='" + item +
                "' AND a.state='APPLIED' AND " + ' AND '.join(f"(a.values_json->>'{f}')=p.{f}" for f in fields) + ')')
        required = f'SELECT {columns} FROM retry_derived p' + excluded
        actual = f'SELECT {columns} FROM retry_actual'
        missing += db.execute(f'SELECT count(*) FROM ({required} EXCEPT {actual})').fetchone()[0]
        unexpected += db.execute(f'SELECT count(*) FROM ({actual} EXCEPT {required})').fetchone()[0]
        duplicate += db.execute('SELECT count(*) FROM retry_actual').fetchone()[0] - db.execute(
            f'SELECT count(*) FROM (SELECT DISTINCT {columns} FROM retry_actual)').fetchone()[0]
    return {'complete': not (missing or unexpected or duplicate or lineage or summary.get('retry_diagnostics')),
            'missing_retry_rows': missing, 'unexpected_retry_rows': unexpected, 'duplicate_retry_rows': duplicate,
            'retry_lineage_errors': lineage, 'snapshot_version': summary['retry']['snapshot_version']}
