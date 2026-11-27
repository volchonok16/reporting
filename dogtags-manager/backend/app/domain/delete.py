"""Single-field deletion dataset with complete original-row disposition and lineage."""
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from app.domain.canonical import CanonicalDataset, ISSUE_SCHEMA, connection, sql_path, write_rows
from app.domain.corrections import effective_values, overlay_index
from app.domain.row_selections import excluded_records, install_exclusions, verify_selection
from app.domain.validation import validate_msisdn

DELETE_VERSION = 'delete-canonical-v1'
DELETE_ROLES = {name: name for name in ('raw', 'effective', 'records', 'issues', 'lineage')}
DELETE_ROLES['DELETE'] = 'deletions'
DELETE_SCHEMA = pa.schema([('record_id', pa.string()), ('ordinal', pa.int64()),
    ('line_start', pa.int64()), ('line_end', pa.int64()), ('raw_cells', pa.list_(pa.string())),
    ('effective_cells', pa.list_(pa.string())), ('MSISDN', pa.string()), ('page_index', pa.int64())])


def reconcile_delete(db, directory):
    for name in ('raw', 'records', 'lineage', 'deletions'):
        db.read_parquet(str(directory / f'{name}.parquet')).create_view(f'checked_{name}', replace=True)
    unaccounted = 0
    for name in ('records', 'lineage'):
        for left, right in [('raw', name), (name, 'raw')]:
            unaccounted += db.execute(f'SELECT count(*) FROM (SELECT record_id FROM checked_{left} '
                f'EXCEPT SELECT record_id FROM checked_{right})').fetchone()[0]
        unaccounted += db.execute(f'SELECT count(*)-count(DISTINCT record_id) FROM checked_{name}').fetchone()[0]
    unaccounted += db.execute("SELECT count(*) FROM checked_records WHERE disposition NOT IN "
        "('included','exact_duplicate','excluded_error','excluded_manual') OR disposition IS NULL").fetchone()[0]
    expected = "SELECT DISTINCT MSISDN FROM checked_records WHERE disposition IN ('included','exact_duplicate')"
    missing = db.execute(f'SELECT count(*) FROM ({expected} EXCEPT SELECT MSISDN FROM checked_deletions)').fetchone()[0]
    unexpected = db.execute(f'SELECT count(*) FROM (SELECT MSISDN FROM checked_deletions EXCEPT {expected})').fetchone()[0]
    duplicate = db.execute('SELECT count(*)-count(DISTINCT MSISDN) FROM checked_deletions').fetchone()[0]
    return {'complete': not any((unaccounted, missing, unexpected, duplicate)), 'unaccounted_records': unaccounted,
            'missing_assignments': missing, 'unexpected_assignments': unexpected, 'duplicate_outputs': duplicate}


def build_delete_dataset(path, encoding, source_asset_id, output_directory, profile_snapshot, *, settings=None,
                         correction_overlay=None, chunk_rows=1000, memory_limit='1GiB', threads=1, parsed_source=None):
    if parsed_source is None or chunk_rows < 1:
        raise ValueError('DELETE requires an immutable mapped source.')
    from app.domain.output_spec import source_separation
    separate_errors = source_separation(settings or {})
    directory = Path(output_directory)
    directory.mkdir(parents=True, exist_ok=False)
    indexed = overlay_index(correction_overlay or [], source_asset_id, mapping_digest=parsed_source.mapping_digest)
    excluded = excluded_records(settings or {}, source_asset_id, parsed_source)
    seen_exclusions = set()
    seen, raw, effective, issues = set(), [], [], []
    with (pq.ParquetWriter(directory / 'raw.parquet', DELETE_SCHEMA) as raw_writer,
          pq.ParquetWriter(directory / 'effective.parquet', DELETE_SCHEMA) as effective_writer,
          pq.ParquetWriter(directory / 'issues.parquet', ISSUE_SCHEMA) as issue_writer):
        for record in parsed_source.records():
            verify_selection(record, excluded, seen_exclusions)
            changes = indexed.get(record.ordinal, [])
            if changes:
                if any(not i.get('field') for i in record.issues) or any(c['field'] != 'MSISDN' for c in changes):
                    raise ValueError('Correction does not belong to the DELETE source contract.')
                seen.add(record.ordinal)
            values = effective_values(record, changes, bulk_steps=indexed.bulk_steps)
            raw.append(record.as_arrow_row())
            effective.append(record.as_arrow_row(values))
            remaining = [i for i in record.issues if i.get('field') not in {c['field'] for c in changes}]
            remaining.extend(validate_msisdn(values['MSISDN']))
            if separate_errors:
                try:
                    values['MSISDN'].encode('cp1251', errors='strict')
                except UnicodeEncodeError:
                    remaining.append({'field': 'MSISDN', 'code': 'output_encoding_error',
                        'message': 'Значение не представимо в Windows-1251; исходные символы сохранены в файле ошибок.'})
            issues.extend({'record_id': record.record_id, 'ordinal': record.ordinal, 'scope': 'cell', **i}
                          for i in remaining)
            if len(raw) >= chunk_rows:
                write_rows(raw_writer, raw, DELETE_SCHEMA)
                write_rows(effective_writer, effective, DELETE_SCHEMA)
                write_rows(issue_writer, issues, ISSUE_SCHEMA)
                raw, effective, issues = [], [], []
        write_rows(raw_writer, raw, DELETE_SCHEMA)
        write_rows(effective_writer, effective, DELETE_SCHEMA)
        write_rows(issue_writer, issues, ISSUE_SCHEMA)
    if seen != set(indexed):
        raise ValueError('Correction points to a missing record.')
    if seen_exclusions != set(excluded):
        raise ValueError('Excluded row was not parsed.')
    with connection(directory / 'work.duckdb', memory_limit=memory_limit, threads=threads,
                    temp_directory=directory / '.spill') as db:
        install_exclusions(db, excluded)
        for name in ('effective', 'issues'):
            db.execute(f'CREATE TABLE {name} AS SELECT * FROM read_parquet(?)', [str(directory / f'{name}.parquet')])
        db.execute('''CREATE TABLE grouped AS SELECT *, min(ordinal) OVER (PARTITION BY MSISDN,
            ordinal IN (SELECT ordinal FROM manual_exclusions))
            AS representative_ordinal FROM effective''')
        db.execute('''CREATE TABLE records AS SELECT g.*, r.record_id AS representative_id,
            CASE WHEN g.ordinal IN (SELECT ordinal FROM manual_exclusions) THEN 'excluded_manual'
            WHEN EXISTS (SELECT 1 FROM issues i WHERE i.record_id=g.record_id) THEN 'excluded_error'
            WHEN g.ordinal<>g.representative_ordinal THEN 'exact_duplicate' ELSE 'included' END AS disposition,
            CASE WHEN g.ordinal<>g.representative_ordinal THEN 'msisdn_exact' ELSE '' END AS duplicate_kind
            FROM grouped g JOIN effective r ON r.ordinal=g.representative_ordinal''')
        db.execute("CREATE TABLE deletions AS SELECT MSISDN,ordinal AS page_index FROM records WHERE disposition='included'")
        db.execute('''CREATE TABLE lineage AS SELECT record_id,ordinal,page_index,representative_id,disposition,
            duplicate_kind,MSISDN FROM records''')
        from app.domain.msisdn_warnings import add_msisdn_cleanup_warnings
        add_msisdn_cleanup_warnings(db, directory, indexed)
        db.execute('ALTER TABLE issues ADD COLUMN page_index BIGINT')
        db.execute('''UPDATE issues SET page_index=ordered.idx FROM (SELECT rowid,
            row_number() OVER (ORDER BY ordinal,field,code) AS idx FROM issues) ordered WHERE issues.rowid=ordered.rowid''')
        for name in ('records', 'lineage', 'deletions', 'issues'):
            db.execute(f'COPY (SELECT * FROM {name} ORDER BY page_index) TO '
                       f"{sql_path(directory / f'{name}.parquet')} (FORMAT PARQUET)")
        reconciliation = reconcile_delete(db, directory)
        counts = {'DELETE': db.execute('SELECT count(*) FROM deletions').fetchone()[0]}
        dispositions = dict(db.execute('SELECT disposition,count(*) FROM records GROUP BY disposition').fetchall())
        issue_counts = dict(db.execute('SELECT code,count(*) FROM issues GROUP BY code').fetchall())
        blocking_issues = db.execute("SELECT count(*) FROM issues JOIN records USING(record_id) "
                                    "WHERE scope<>'warning' AND disposition <> 'excluded_manual'").fetchone()[0]
        structural_issues = db.execute("SELECT count(*) FROM issues WHERE coalesce(field,'')='' ").fetchone()[0]
        if separate_errors:
            from app.domain.source_errors import create_source_errors, reconcile_source_errors
            create_source_errors(db, directory, ('MSISDN',))
            counts['ERRORS'] = db.execute('SELECT count(*) FROM errors').fetchone()[0]
            counts = {role: count for role, count in counts.items() if count}
            reconciliation = reconcile_source_errors(db, directory, reconciliation)
    (directory / 'work.duckdb').unlink()
    summary = {'dataset_version': DELETE_VERSION, 'operation': 'DELETE', 'source_asset_id': str(source_asset_id),
        **parsed_source.summary, 'counts': counts, 'dispositions': dispositions, 'issue_counts': issue_counts,
        'reconciliation': reconciliation,
        'blocking': bool(parsed_source.summary['file_errors'] or blocking_issues or not reconciliation['complete'])}
    if separate_errors:
        from app.domain.output_spec import source_spec
        if summary.get('error_source'):
            summary['error_source'] = {**summary['error_source'], 'diagnostic_column': 'Ошибка', 'utf8_bom': True}
        summary['dataset_version'] = 'source-delete-canonical-v1'
        summary['record_fields'] = ['MSISDN']
        summary['output_spec'] = source_spec('DELETE', list(counts) or None)
        summary['blocking'] = bool(summary['file_errors'] or summary.get('unknown_remainder')
                                   or structural_issues or not reconciliation['complete'] or not counts)
    (directory / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return CanonicalDataset(directory, summary, memory_limit, threads)
