"""One UTF-8 diagnostic row per excluded source identity, independently reconciled."""
from app.domain.canonical import sql_path
from app.domain.repair import ERROR_DATA_FIELDS

ERROR_DISPOSITIONS = "('excluded_error','excluded_scientific_inn','conflict')"


def source_error_query(fields, *, records='records', issues='issues'):
    columns = ','.join(f'r.{field}' if field in fields else f"''::VARCHAR AS {field}"
                       for field in ERROR_DATA_FIELDS)
    return f'''SELECT {columns},''::VARCHAR AS STATUS,CAST(r.ordinal AS VARCHAR) AS SOURCE_ROW,
        diagnostics.ERROR_FIELDS,diagnostics.ERROR_MESSAGES,r.ordinal AS page_index FROM {records} r
        JOIN (SELECT record_id,
            string_agg(DISTINCT CASE WHEN field='' THEN 'SOURCE_ROW' ELSE field END,
                '; ' ORDER BY CASE WHEN field='' THEN 'SOURCE_ROW' ELSE field END) AS ERROR_FIELDS,
            string_agg(field || ': ' || message, '\n' ORDER BY scope,field,code,message) AS ERROR_MESSAGES
            FROM (SELECT DISTINCT record_id,field,scope,code,message FROM {issues} WHERE scope<>'warning') GROUP BY record_id)
        diagnostics USING(record_id) WHERE r.disposition IN {ERROR_DISPOSITIONS}'''


def create_source_errors(db, directory, fields):
    query = source_error_query(fields)
    db.execute('CREATE TABLE errors AS ' + query)
    db.execute(f"COPY (SELECT * FROM errors ORDER BY page_index) TO {sql_path(directory / 'errors.parquet')} (FORMAT PARQUET)")


def reconcile_source_errors(db, directory, base):
    """Derive report cells from immutable records/issues rather than trusting counts."""
    db.read_parquet(str(directory / 'records.parquet')).create_view('source_checked_records', replace=True)
    db.read_parquet(str(directory / 'issues.parquet')).create_view('source_checked_issues', replace=True)
    db.read_parquet(str(directory / 'errors.parquet')).create_view('source_checked_errors', replace=True)
    expected = f'SELECT ordinal FROM source_checked_records WHERE disposition IN {ERROR_DISPOSITIONS}'
    actual = 'SELECT page_index AS ordinal FROM source_checked_errors'
    missing = db.execute(f'SELECT count(*) FROM ({expected} EXCEPT {actual})').fetchone()[0]
    unexpected = db.execute(f'SELECT count(*) FROM ({actual} EXCEPT {expected})').fetchone()[0]
    duplicate = db.execute('SELECT count(*)-count(DISTINCT page_index) FROM source_checked_errors').fetchone()[0]
    # Each report ordinal must belong to that same preserved source record and diagnostics.
    invalid = db.execute('''SELECT count(*) FROM source_checked_errors e
        JOIN source_checked_records r ON r.ordinal=e.page_index
        WHERE e.SOURCE_ROW<>CAST(r.ordinal AS VARCHAR) OR NOT EXISTS
        (SELECT 1 FROM source_checked_issues i WHERE i.record_id=r.record_id AND i.ordinal=r.ordinal)''').fetchone()[0]
    fields = {column[0] for column in db.execute('DESCRIBE source_checked_records').fetchall()}
    expected_cells = source_error_query(fields, records='source_checked_records', issues='source_checked_issues')
    actual_cells = 'SELECT * FROM source_checked_errors'
    invalid += db.execute(f'''WITH expected AS MATERIALIZED ({expected_cells}),
        actual AS ({actual_cells}) SELECT
        (SELECT count(*) FROM (SELECT * FROM expected EXCEPT SELECT * FROM actual)) +
        (SELECT count(*) FROM (SELECT * FROM actual EXCEPT SELECT * FROM expected))''').fetchone()[0]
    return {**base, 'complete': base['complete'] and not any((missing, unexpected, duplicate, invalid)),
            'missing_error_records': missing, 'unexpected_error_records': unexpected,
            'duplicate_error_records': duplicate, 'invalid_error_records': invalid}
