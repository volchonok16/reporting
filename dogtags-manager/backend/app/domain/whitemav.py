"""WhiteMAV uses the existing single-number review pipeline and fixed NUMBERS values."""
import json
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app.domain.canonical import connection, sql_path
from app.domain.delete import build_delete_dataset, reconcile_delete
from app.domain.operations import canonical_digest
from app.domain.output_spec import CONTRACTS, source_spec
from app.domain.whitemav_inns import DEFAULT_INNS, checked_inn
from app.domain.source_errors import reconcile_source_errors
from app.models import SourceProfileVersion

CONSTANTS = CONTRACTS['WHITEMAV']['files']['NUMBERS']['constants']
PROFILE = {'partner': 'WhiteMAV', 'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': CONSTANTS['INTERNAL_OPERATOR_NAME']}


def fixed_profile(db):
    version = 'whitemav-fixed-v2'
    digest = canonical_digest(PROFILE)
    db.execute(insert(SourceProfileVersion).values(id=uuid4(), version=version,
        config_hash=digest, snapshot=PROFILE).on_conflict_do_nothing(index_elements=['version']))
    profile = db.scalar(select(SourceProfileVersion).where(SourceProfileVersion.version == version))
    if profile.snapshot != PROFILE or profile.config_hash != digest:
        raise ValueError('WhiteMAV profile differs from its fixed contract.')
    return profile


def reconcile_whitemav(db, directory, inn=DEFAULT_INNS[0]):
    result = reconcile_delete(db, directory)
    db.read_parquet(str(directory / 'numbers.parquet')).create_view('checked_numbers', replace=True)
    mismatch = db.execute('''SELECT count(*) FROM (
        (SELECT MSISDN FROM checked_deletions EXCEPT SELECT MSISDN FROM checked_numbers)
        UNION ALL (SELECT MSISDN FROM checked_numbers EXCEPT SELECT MSISDN FROM checked_deletions))''').fetchone()[0]
    mismatch += db.execute('SELECT count(*)-count(DISTINCT MSISDN) FROM checked_numbers').fetchone()[0]
    for field, expected in {**CONSTANTS, 'INN': checked_inn(inn)}.items():
        mismatch += db.execute(f'SELECT count(*) FROM checked_numbers WHERE {field} IS DISTINCT FROM ?', [expected]).fetchone()[0]
    result['unexpected_assignments'] += mismatch
    result['complete'] = result['complete'] and mismatch == 0
    return result


def build_whitemav_dataset(path, encoding, source_asset_id, output_directory, profile_snapshot, *, settings=None, **options):
    inn = checked_inn((settings or {}).get('whitemav_inn', DEFAULT_INNS[0]))
    constants = {**CONSTANTS, 'INN': inn}
    dataset = build_delete_dataset(path, encoding, source_asset_id, output_directory, profile_snapshot,
        settings={**(settings or {}), 'operation': 'DELETE', 'row_error_policy': 'separate-source-errors-v1'}, **options)
    columns = CONTRACTS['WHITEMAV']['files']['NUMBERS']['columns']
    projection = ','.join(field if field == 'MSISDN' else f"'{constants[field]}' AS {field}" for field in columns)
    with connection(memory_limit=dataset.memory_limit, threads=dataset.threads) as db:
        db.execute(f'COPY (SELECT {projection},page_index FROM read_parquet(?) ORDER BY page_index) '
                   f"TO {sql_path(dataset.directory / 'numbers.parquet')} (FORMAT PARQUET)",
                   [str(dataset.directory / 'deletions.parquet')])
        reconciliation = reconcile_source_errors(db, dataset.directory, reconcile_whitemav(db, dataset.directory, inn))
    summary = dataset.summary
    summary.update(dataset_version='source-whitemav-canonical-v1', operation='WHITEMAV',
                   whitemav_inn=inn, reconciliation=reconciliation)
    counts = summary['counts']
    if 'DELETE' in counts:
        counts['NUMBERS'] = counts.pop('DELETE')
    summary['counts'] = {role: counts[role] for role in ('NUMBERS', 'ERRORS') if role in counts}
    summary['output_spec'] = source_spec('WHITEMAV', list(summary['counts']) or None)
    summary['blocking'] = summary['blocking'] or not reconciliation['complete']
    (dataset.directory / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return dataset
