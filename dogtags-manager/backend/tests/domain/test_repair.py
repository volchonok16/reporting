"""Returned-file repair vectors through immutable CSV mapping and real projections."""
import csv
from uuid import uuid4

import pyarrow.parquet as pq
import pytest

from app.domain.canonical import connection
from app.domain.readers.base import MappedSource, publish_raw_index
from app.domain.readers.csv_reader import CSVTable
from app.domain.repair import build_repair_dataset, reconcile_repair
from app.storage.local import LocalStorage


FIELDS = {
    'CLIENTS': ('COMPANY_NAME', 'COMPANY_CONTRACT', 'MAV_OPERATOR_NAME', 'INN'),
    'DOGTAGS': ('INN', 'MAV_LABEL_NAME', 'MAV_LABEL_LATIN', 'IS_ACTIVE'),
    'NUMBERS': ('INN', 'MAV_LABEL_NAME', 'MSISDN', 'IS_MAV', 'IS_KSS', 'SPREADING', 'INTERNAL_OPERATOR_NAME'),
}
FILES = {'CLIENTS': 'clients', 'DOGTAGS': 'dogtags', 'NUMBERS': 'numbers', 'DELETE': 'deletions', 'ERRORS': 'errors'}
INN = '1234567894'
LABEL_ERROR = 'Длина MAV_LABEL не должна превышать 32 символа или имеются некорретные символы'
MISSING_CLIENT = 'ИНН отсутствует в таблице MAV клиентов'


def row(role, **changes):
    defaults = {'COMPANY_NAME': 'Компания', 'COMPANY_CONTRACT': '', 'MAV_OPERATOR_NAME': '',
                'INN': INN, 'MAV_LABEL_NAME': 'Тест', 'MAV_LABEL_LATIN': 'Test', 'IS_ACTIVE': '1',
                'MSISDN': '79000001900', 'IS_MAV': '1', 'IS_KSS': '0', 'SPREADING': '1',
                'INTERNAL_OPERATOR_NAME': 'sourceOperator', 'STATUS': ''}
    return {field: changes.get(field, defaults[field]) for field in (*FIELDS[role], 'STATUS')}


def mapped(tmp_path, role, rows):
    tmp_path.mkdir(parents=True, exist_ok=True)
    source_id = uuid4()
    fields = (*FIELDS[role], 'STATUS')
    path = tmp_path / 'returned.csv'
    with path.open('w', encoding='utf-8', newline='') as stream:
        writer = csv.writer(stream, delimiter=';')
        writer.writerow(fields)
        writer.writerows([[r[f] for f in fields] for r in rows])
    storage = LocalStorage(tmp_path / 'objects')
    key = publish_raw_index(CSVTable(path, source_id, encoding='utf-8', delimiter=';'), storage,
                            tmp_path / 'raw', chunk_rows=1)
    parsed = MappedSource(storage, key, source_id, {f: i for i, f in enumerate(fields)}, required=fields)
    return path, source_id, parsed


def build(tmp_path, role, rows, *, setup=None):
    path, source_id, parsed = mapped(tmp_path, role, rows)
    options = setup(source_id, parsed) if setup else {}
    return build_repair_dataset(path, 'utf-8', source_id, tmp_path / 'dataset', {},
        settings={'repair_role': role, **options.get('settings', {})}, parsed_source=parsed,
        correction_overlay=options.get('overlay'), chunk_rows=1, memory_limit='128MiB')


def output(dataset, role):
    return [{k: v for k, v in r.items() if k != 'page_index'}
            for r in pq.read_table(dataset.directory / f'{FILES[role]}.parquet').to_pylist()]


@pytest.mark.parametrize('role,status,target', [
    ('CLIENTS', 'ИНН уже есть в списке MAV клиентов', None),
    ('NUMBERS', 'Номер телефона уже есть в таблице MAV номеров', 'DELETE'),
    ('NUMBERS', 'MAV_LABEL_NAME отсутствует в таблице этикеток', None),
    ('NUMBERS', 'MAV_LABEL_NAME отсутствуют в таблице этикеток', None),
    ('DOGTAGS', 'Указанный MAV_LABEL уже есть у данного клиента', None),
    ('DOGTAGS', MISSING_CLIENT, 'CLIENTS'),
    ('NUMBERS', MISSING_CLIENT, 'CLIENTS'),
])
def test_confirmed_status_actions_keep_coverage_and_source_order(tmp_path, role, status, target):
    dataset = build(tmp_path, role, [row(role, STATUS=status), row(role, INN='0000000000', MSISDN='79000002900')])
    assert dataset.summary['operation'] == 'REPAIR'
    assert dataset.summary['repair_role'] == role
    expected = {role: 1}
    if target:
        expected[target] = expected.get(target, 0) + 1
    assert dataset.summary['counts'] == expected
    assert dataset.summary['reconciliation']['complete'] is True
    assert dataset.summary['blocking'] is False
    records = pq.read_table(dataset.directory / 'records.parquet').to_pylist()
    assert [r['disposition'] for r in records] == ['agreed_skip', 'included']
    assert len(pq.read_table(dataset.directory / 'lineage.parquet')) == 2
    if target == 'CLIENTS':
        assert output(dataset, target) == [{'COMPANY_NAME': '', 'COMPANY_CONTRACT': '', 'MAV_OPERATOR_NAME': '', 'INN': INN}]
    if target == 'DELETE':
        assert output(dataset, target) == [{'MSISDN': '79000001900'}]


@pytest.mark.parametrize('role', ['DOGTAGS', 'NUMBERS'])
@pytest.mark.parametrize('status', ['', LABEL_ERROR, LABEL_ERROR.replace('некорретные', 'некорректные')])
def test_actual_labels_validated_even_without_status_and_corrected_reenter(tmp_path, role, status):
    invalid = row(role, MAV_LABEL_NAME='Mixed Я_', STATUS=status)
    dataset = build(tmp_path / 'bad', role, [invalid])
    assert dataset.summary['counts'] == {'ERRORS': 1}
    assert dataset.summary['blocking'] is False
    error = output(dataset, 'ERRORS')[0]
    assert error['MAV_LABEL_NAME'] == 'Mixed Я_' and error['STATUS'] == status
    assert error['SOURCE_ROW'] == '1'
    assert 'MAV_LABEL_NAME' in error['ERROR_FIELDS']
    def correction(source_id, parsed):
        original = next(parsed.records())
        return {'overlay': [{'record_id': original.record_id, 'ordinal': 1,
            'mapping_digest': parsed.mapping_digest, 'field': 'MAV_LABEL_NAME', 'before': 'Mixed Я_', 'after': 'Исправлено'}]}
    corrected = build(tmp_path / 'corrected', role, [invalid], setup=correction)
    assert corrected.summary['counts'] == {role: 1}
    record = pq.read_table(corrected.directory / 'records.parquet').to_pylist()[0]
    assert record['raw_cells'][1] == 'Mixed Я_' and record['MAV_LABEL_NAME'] == 'Исправлено'


@pytest.mark.parametrize('role,changes,field', [
    ('CLIENTS', {'INN': '1234567895'}, 'INN'),
    ('DOGTAGS', {'MAV_LABEL_LATIN': 'Тест'}, 'MAV_LABEL_LATIN'),
    ('DOGTAGS', {'MAV_LABEL_NAME': 'Я' * 33}, 'MAV_LABEL_NAME'),
    ('DOGTAGS', {'IS_ACTIVE': '0'}, 'IS_ACTIVE'),
    ('NUMBERS', {'IS_MAV': ''}, 'IS_MAV'),
    ('NUMBERS', {'IS_KSS': '2'}, 'IS_KSS'),
    ('NUMBERS', {'SPREADING': ''}, 'SPREADING'),
    ('NUMBERS', {'MSISDN': ''}, 'MSISDN'),
    ('NUMBERS', {'STATUS': 'Совсем неизвестно'}, 'STATUS'),
    ('DOGTAGS', {'STATUS': 'Номер телефона уже есть в таблице MAV номеров'}, 'STATUS'),
])
def test_invalid_cells_unknown_and_wrong_role_status_are_reported(tmp_path, role, changes, field):
    dataset = build(tmp_path, role, [row(role, **changes)])
    assert dataset.summary['counts'] == {'ERRORS': 1}
    assert field in output(dataset, 'ERRORS')[0]['ERROR_FIELDS']
    assert dataset.summary['reconciliation']['complete'] is True


def test_manual_exclusion_does_not_hide_other_duplicate_or_create_errors(tmp_path):
    def select(source_id, parsed):
        record = next(parsed.records())
        return {'settings': {'row_selections': {record.record_id: {'record_id': record.record_id,
            'ordinal': 1, 'excluded': True, 'source_asset_id': str(source_id), 'mapping_digest': parsed.mapping_digest}}}}
    dataset = build(tmp_path, 'NUMBERS', [row('NUMBERS'), row('NUMBERS')], setup=select)
    assert dataset.summary['counts'] == {'NUMBERS': 1}
    records = pq.read_table(dataset.directory / 'records.parquet').to_pylist()
    assert [r['disposition'] for r in records] == ['excluded_manual', 'included']
    assert records[1]['representative_id'] == records[1]['record_id']
    assert output(dataset, 'NUMBERS')[0]['SPREADING'] == '1'
    assert output(dataset, 'NUMBERS')[0]['INTERNAL_OPERATOR_NAME'] == 'sourceOperator'


@pytest.mark.parametrize('role', ['CLIENTS', 'DOGTAGS', 'NUMBERS'])
def test_exact_duplicates_share_representative(tmp_path, role):
    dataset = build(tmp_path, role, [row(role), row(role)])
    assert dataset.summary['counts'] == {role: 1}
    records = pq.read_table(dataset.directory / 'records.parquet').to_pylist()
    assert [r['disposition'] for r in records] == ['included', 'exact_duplicate']
    assert records[1]['representative_id'] == records[0]['record_id']


@pytest.mark.parametrize('role,changed', [('NUMBERS', {'SPREADING': '0'})])
def test_conflicting_main_rows_are_errors_and_do_not_contaminate_valid_subset(tmp_path, role, changed):
    dataset = build(tmp_path, role, [row(role), row(role, **changed), row(role, INN='0000000000', MSISDN='79000002900')])
    assert dataset.summary['counts'] == {role: 1, 'ERRORS': 2}
    assert dataset.summary['dispositions'] == {'conflict': 2, 'included': 1}
    assert dataset.summary['blocking'] is False
    assert len(output(dataset, 'ERRORS')) == 2


def test_different_assignment_flags_warn_but_both_rows_are_exported(tmp_path):
    dataset = build(tmp_path, 'NUMBERS', [row('NUMBERS'), row('NUMBERS', IS_MAV='0', IS_KSS='1')])
    assert dataset.summary['counts'] == {'NUMBERS': 2}
    assert dataset.summary['dispositions'] == {'included': 2}
    issues = pq.read_table(dataset.directory / 'issues.parquet').to_pylist()
    assert all(issue['scope'] == 'warning' for issue in issues)
    assert dataset.summary['issue_counts']['assignment_key_conflict'] == 2


@pytest.mark.parametrize('same_inn_changes', [{}, {'IS_KSS': '1'}])
def test_phone_assigned_to_different_inns_conflicts_every_main_candidate(tmp_path, same_inn_changes):
    from app.domain.projections import verify_projections
    dataset = build(tmp_path, 'NUMBERS', [row('NUMBERS'), row('NUMBERS', **same_inn_changes),
        row('NUMBERS', INN='0000000000'), row('NUMBERS', MSISDN='79000002900')])
    assert dataset.summary['counts'] == {'NUMBERS': 1, 'ERRORS': 3}
    assert dataset.summary['dispositions'] == {'conflict': 3, 'included': 1}
    assert dataset.summary['issue_counts']['msisdn_assignment_conflict'] == 3
    assert dataset.summary['reconciliation']['complete'] is True
    assert dataset.summary['blocking'] is False
    assert [r['MSISDN'] for r in output(dataset, 'NUMBERS')] == ['79000002900']
    assert [r['SOURCE_ROW'] for r in output(dataset, 'ERRORS')] == ['1', '2', '3']
    assert all('MSISDN' in r['ERROR_FIELDS'] for r in output(dataset, 'ERRORS'))
    issues = pq.read_table(dataset.directory / 'issues.parquet').to_pylist()
    assert [(i['ordinal'], i['scope'], i['field']) for i in issues
            if i['code'] == 'msisdn_assignment_conflict'] == [
                (1, 'global', 'MSISDN'), (2, 'global', 'MSISDN'), (3, 'global', 'MSISDN')]
    assert verify_projections(dataset)['counts'] == {'NUMBERS': 1, 'ERRORS': 3}


def test_manual_exclusion_resolves_phone_assignment_conflict(tmp_path):
    def exclude(source_id, parsed):
        original = next(parsed.records())
        return {'settings': {'row_selections': {original.record_id: {'record_id': original.record_id,
            'ordinal': 1, 'excluded': True, 'source_asset_id': str(source_id), 'mapping_digest': parsed.mapping_digest}}}}
    dataset = build(tmp_path, 'NUMBERS', [row('NUMBERS'), row('NUMBERS', INN='0000000000')], setup=exclude)
    assert dataset.summary['counts'] == {'NUMBERS': 1}
    assert dataset.summary['dispositions'] == {'excluded_manual': 1, 'included': 1}
    assert dataset.summary['issue_counts'] == {}
    assert dataset.summary['reconciliation']['complete'] is True
    assert output(dataset, 'NUMBERS')[0]['INN'] == '0000000000'


def test_auxiliary_phone_recovery_does_not_conflict_with_main_assignment(tmp_path):
    dataset = build(tmp_path, 'NUMBERS', [row('NUMBERS'),
        row('NUMBERS', INN='0000000000', STATUS='Номер телефона уже есть в таблице MAV номеров'),
        row('NUMBERS', INN='0000000000', STATUS=MISSING_CLIENT)])
    assert dataset.summary['counts'] == {'CLIENTS': 1, 'NUMBERS': 1, 'DELETE': 1}
    assert dataset.summary['dispositions'] == {'included': 1, 'agreed_skip': 2}
    assert dataset.summary['issue_counts'] == {}
    assert dataset.summary['reconciliation']['complete'] is True
    assert output(dataset, 'NUMBERS')[0]['INN'] == INN
    assert output(dataset, 'CLIENTS')[0]['INN'] == '0000000000'
    assert output(dataset, 'DELETE') == [{'MSISDN': '79000001900'}]


@pytest.mark.parametrize('role,status,target', [('NUMBERS', MISSING_CLIENT, 'CLIENTS'),
    ('DOGTAGS', MISSING_CLIENT, 'CLIENTS'), ('NUMBERS', 'Номер телефона уже есть в таблице MAV номеров', 'DELETE')])
def test_auxiliary_roles_deduplicate_and_reconciliation_detects_missing_projection(tmp_path, role, status, target):
    dataset = build(tmp_path, role, [row(role, STATUS=status), row(role, STATUS=status)])
    assert dataset.summary['counts'] == {target: 1}
    path = dataset.directory / f'{FILES[target]}.parquet'
    table = pq.read_table(path)
    pq.write_table(table.slice(0, 0), path)
    with connection() as db:
        checked = reconcile_repair(db, dataset.directory, dataset.summary)
    assert checked['complete'] is False and checked['missing_assignments'] == 1


def test_zero_output_skip_is_blocked_and_preserves_lineage(tmp_path):
    dataset = build(tmp_path, 'CLIENTS', [row('CLIENTS', STATUS='ИНН уже есть в списке MAV клиентов')])
    assert dataset.summary['counts'] == {}
    assert dataset.summary['blocking'] is True
    assert dataset.summary['reconciliation']['complete'] is True
    assert len(pq.read_table(dataset.directory / 'lineage.parquet')) == 1


@pytest.mark.parametrize('role,field,before,after', [
    ('CLIENTS', 'COMPANY_NAME', 'Компания', 'Исправленная компания'),
    ('CLIENTS', 'INN', INN, '0000000000'),
    ('DOGTAGS', 'IS_ACTIVE', '0', '1'),
    ('DOGTAGS', 'MAV_LABEL_LATIN', 'Test', 'Updated'),
    ('NUMBERS', 'SPREADING', '1', '0'),
    ('NUMBERS', 'INTERNAL_OPERATOR_NAME', 'sourceOperator', 'updatedOperator'),
    ('NUMBERS', 'STATUS', 'Неизвестно', ''),
])
def test_manual_corrections_apply_to_the_actual_role_contract(tmp_path, role, field, before, after):
    def correction(source_id, parsed):
        original = next(parsed.records())
        return {'overlay': [{'record_id': original.record_id, 'ordinal': 1,
            'mapping_digest': parsed.mapping_digest, 'field': field, 'before': before, 'after': after}]}
    dataset = build(tmp_path, role, [row(role, **{field: before})], setup=correction)
    assert dataset.summary['counts'] == {role: 1}
    record = pq.read_table(dataset.directory / 'records.parquet').to_pylist()[0]
    assert record[field] == after
    assert record['raw_cells'][(*FIELDS[role], 'STATUS').index(field)] == before


def test_all_invalid_cells_retained_in_single_error_report_and_skip_rows_are_validated(tmp_path):
    dataset = build(tmp_path, 'NUMBERS', [row('NUMBERS', INN='123', MAV_LABEL_NAME='A_',
        MSISDN='', IS_KSS='bad', SPREADING='', INTERNAL_OPERATOR_NAME='',
        STATUS='Номер телефона уже есть в таблице MAV номеров')])
    assert dataset.summary['counts'] == {'ERRORS': 1}
    report = output(dataset, 'ERRORS')[0]
    assert set(report['ERROR_FIELDS'].split('; ')) == {'INN', 'MAV_LABEL_NAME', 'MSISDN', 'IS_KSS',
                                                        'SPREADING'}
    assert len(report['ERROR_MESSAGES'].splitlines()) == 5
    assert report['MAV_LABEL_NAME'] == 'A_' and report['INN'] == '123'


@pytest.mark.parametrize('name', ['raw', 'effective', 'records', 'lineage', 'errors'])
def test_missing_source_or_error_row_invalidates_reconciliation(tmp_path, name):
    dataset = build(tmp_path, 'NUMBERS', [row('NUMBERS'), row('NUMBERS', INN='bad')])
    path = dataset.directory / f'{name}.parquet'
    table = pq.read_table(path)
    pq.write_table(table.slice(0, max(0, len(table) - 1)), path)
    with connection() as db:
        checked = reconcile_repair(db, dataset.directory, dataset.summary)
    assert checked['complete'] is False


def test_unknown_remainder_blocks_even_with_valid_prefix(tmp_path):
    path, source_id, parsed = mapped(tmp_path, 'NUMBERS', [row('NUMBERS')])
    parsed.summary['unknown_remainder'] = True
    parsed.summary['file_errors'] = [{'code': 'source_encoding_error', 'message': 'Не прочитан остаток.'}]
    dataset = build_repair_dataset(path, 'utf-8', source_id, tmp_path / 'dataset', {},
        settings={'repair_role': 'NUMBERS'}, parsed_source=parsed, chunk_rows=1)
    assert dataset.summary['counts'] == {'NUMBERS': 1}
    assert dataset.summary['blocking'] is True


def test_clients_missing_optional_mapping_defaults_to_empty_without_losing_raw_cells(tmp_path):
    source_id = uuid4()
    path = tmp_path / 'clients.csv'
    path.write_text(f'INN;STATUS\n{INN};\n')
    storage = LocalStorage(tmp_path / 'objects')
    key = publish_raw_index(CSVTable(path, source_id, encoding='utf-8', delimiter=';'), storage, tmp_path / 'raw')
    parsed = MappedSource(storage, key, source_id, {'INN': 0, 'STATUS': 1}, required=('INN', 'STATUS'))
    dataset = build_repair_dataset(path, 'utf-8', source_id, tmp_path / 'dataset', {},
        settings={'repair_role': 'CLIENTS'}, parsed_source=parsed)
    assert output(dataset, 'CLIENTS') == [{'COMPANY_NAME': '', 'COMPANY_CONTRACT': '', 'MAV_OPERATOR_NAME': '', 'INN': INN}]
    assert pq.read_table(dataset.directory / 'raw.parquet').to_pylist()[0]['raw_cells'] == [INN, '']


def test_many_rows_stream_across_small_chunks_with_stable_source_identity(tmp_path):
    source_id = uuid4()
    path = tmp_path / 'numbers.csv'
    fields = (*FIELDS['NUMBERS'], 'STATUS')
    with path.open('w', encoding='utf-8', newline='') as stream:
        writer = csv.writer(stream, delimiter=';')
        writer.writerow(fields)
        for ordinal in range(1, 5001):
            values = row('NUMBERS', MSISDN=f'79{ordinal:09}')
            writer.writerow([values[field] for field in fields])
    storage = LocalStorage(tmp_path / 'objects')
    key = publish_raw_index(CSVTable(path, source_id, encoding='utf-8', delimiter=';'), storage,
                            tmp_path / 'raw', chunk_rows=100)
    parsed = MappedSource(storage, key, source_id, {f: i for i, f in enumerate(fields)}, required=fields)
    dataset = build_repair_dataset(path, 'utf-8', source_id, tmp_path / 'dataset', {},
        settings={'repair_role': 'NUMBERS'}, parsed_source=parsed, chunk_rows=31, memory_limit='64MiB')
    assert dataset.summary['counts'] == {'NUMBERS': 5000}
    assert dataset.summary['reconciliation']['complete'] is True
    assert dataset.summary['blocking'] is False
    page = dataset.page('records', after=4998, limit=2)['items']
    assert [r['effective']['MSISDN'] for r in page] == ['79000004999', '79000005000']
    assert [r['ordinal'] for r in page] == [4999, 5000]


@pytest.mark.parametrize('role,field', [('CLIENTS', 'COMPANY_NAME'), ('CLIENTS', 'COMPANY_CONTRACT'),
    ('CLIENTS', 'MAV_OPERATOR_NAME'), ('NUMBERS', 'INTERNAL_OPERATOR_NAME')])
def test_unencodable_import_value_is_preserved_in_errors_without_blocking_valid_subset(tmp_path, role, field):
    dataset = build(tmp_path, role, [row(role, **{field: 'Исходное 😀'}),
                                    row(role, INN='0000000000', MSISDN='79000002900')])
    assert dataset.summary['counts'] == {role: 1, 'ERRORS': 1}
    assert dataset.summary['blocking'] is False
    report = output(dataset, 'ERRORS')[0]
    assert report[field] == 'Исходное 😀'
    assert field in report['ERROR_FIELDS']
    assert dataset.summary['issue_counts']['output_encoding_error'] == 1


@pytest.mark.parametrize('role,expected_csv', [
    ('CLIENTS', 'COMPANY_NAME;COMPANY_CONTRACT;MAV_OPERATOR_NAME;INN\r\nКомпания;;;1234567894\r\n'),
    ('DOGTAGS', 'INN;MAV_LABEL;MAV_LABEL_LATIN;IS_ACTIVE\r\n1234567894;Тест;Test;1\r\n'),
    ('NUMBERS', 'INN;MAV_LABEL_NAME;MSISDN;IS_MAV;IS_KSS;SPREADING;INTERNAL_OPERATOR_NAME\r\n'
                '1234567894;Тест;79000001900;1;0;1;sourceOperator\r\n'),
])
def test_import_bytes_keep_frozen_templates_and_errors_remain_utf8(tmp_path, role, expected_csv):
    from app.domain.projections import verify_projections
    from app.domain.serialization import write_csv
    dataset = build(tmp_path, role, [row(role), row(role, INN='Ошибка 😀')])
    assert verify_projections(dataset)['counts'] == {role: 1, 'ERRORS': 1}
    imported = write_csv(dataset, role, tmp_path / 'import.csv')
    assert imported.path.read_bytes() == expected_csv.encode('cp1251')
    report = write_csv(dataset, 'ERRORS', tmp_path / 'errors.csv')
    assert report.path.read_bytes().startswith(b'\xef\xbb\xbf')
    report_text = report.path.read_bytes().decode('utf-8-sig')
    assert 'Ошибка 😀' in report_text
    assert report_text.split('\r\n')[0] == ';'.join((*FIELDS[role], 'STATUS'))
    report_rows = list(csv.DictReader(report_text.splitlines(), delimiter=';'))
    assert len(report_rows) == 1 and report_rows[0]['INN'] == 'Ошибка 😀'


@pytest.mark.parametrize('status', ['', 'Номер телефона уже есть в таблице MAV номеров', MISSING_CLIENT])
def test_extra_cells_are_ignored_without_affecting_status_actions(tmp_path, status):
    from app.domain.projections import verify_projections
    source_id = uuid4()
    path = tmp_path / 'numbers.csv'
    fields = (*FIELDS['NUMBERS'], 'STATUS')
    with path.open('w', encoding='utf-8', newline='') as stream:
        writer = csv.writer(stream, delimiter=';')
        writer.writerow(fields)
        values = row('NUMBERS', STATUS=status)
        writer.writerow([values[field] for field in fields] + ['Extra original cell'])
        values = row('NUMBERS', MSISDN='79000002900')
        writer.writerow([values[field] for field in fields])
    storage = LocalStorage(tmp_path / 'objects')
    key = publish_raw_index(CSVTable(path, source_id, encoding='utf-8', delimiter=';'), storage, tmp_path / 'raw')
    parsed = MappedSource(storage, key, source_id, {f: i for i, f in enumerate(fields)}, required=fields)
    dataset = build_repair_dataset(path, 'utf-8', source_id, tmp_path / 'dataset', {},
        settings={'repair_role': 'NUMBERS'}, parsed_source=parsed)
    expected = ({'NUMBERS': 2} if not status else {'NUMBERS': 1, 'CLIENTS' if status == MISSING_CLIENT else 'DELETE': 1})
    assert verify_projections(dataset)['counts'] == expected
    assert not output(dataset, 'ERRORS')
    assert parsed.summary['ignored_extra_cells'] == 1
    assert len(next(parsed.records()).raw_cells) == len(fields)


@pytest.mark.parametrize('role', ['DOGTAGS', 'NUMBERS'])
def test_pinned_normalizations_precede_manual_correction_and_keep_audit(tmp_path, role):
    from types import SimpleNamespace
    from uuid import UUID
    from app.domain.revisions import source_records
    from app.domain.rules import rules_snapshot, seed_config, validate_config
    from app.domain.serialization import write_csv
    config = seed_config()
    config['version'] = 'repair-approved-normalization-v1'
    config['normalizations'] = [{'id': 'approved-label', 'field': 'MAV_LABEL_NAME',
                                 'before': 'Тeст', 'after': 'Тест'}]
    config['examples'] = [{'kind': 'normalization', 'rule_id': 'approved-label', 'before': 'Тeст', 'after': 'Тест'}]
    snapshot = rules_snapshot(validate_config(config))
    path, source_id, parsed = mapped(tmp_path, role, [row(role, MAV_LABEL_NAME='Тeст'),
        row(role, INN='0000000000', MSISDN='79000002900', MAV_LABEL_NAME='Тeст')])
    originals = list(parsed.records())
    overlay = [{'record_id': originals[1].record_id, 'ordinal': 2, 'mapping_digest': parsed.mapping_digest,
                'field': 'MAV_LABEL_NAME', 'before': 'Тест', 'after': 'Проверено'}]
    reviewed = source_records(parsed.storage, {'id': source_id, 'rules_snapshot': snapshot,
        'reader_result': {'operation': 'REPAIR', 'repair_role': role, 'raw_index_key': parsed.key,
                          'mapping': parsed.mapping}}, overlay,
        [SimpleNamespace(ordinal=r.ordinal, record_id=UUID(r.record_id)) for r in originals])
    dataset = build_repair_dataset(path, 'utf-8', source_id, tmp_path / 'dataset', {}, parsed_source=parsed,
        settings={'repair_role': role, 'rules_snapshot': snapshot}, correction_overlay=overlay, chunk_rows=1)
    assert dataset.summary['counts'] == {role: 2}
    records = dataset.page('records')['items']
    assert [r['effective']['MAV_LABEL_NAME'] for r in records] == ['Тест', 'Проверено']
    assert [r['effective'] for r in records] == [reviewed[1], reviewed[2]]
    assert all(r['raw_cells'][1] == 'Тeст' for r in records)
    exported = write_csv(dataset, role, tmp_path / 'import.csv').path.read_bytes().decode('cp1251')
    assert ';Тест;' in exported and ';Проверено;' in exported and ';Тeст;' not in exported
    assert dataset.summary['normalization_count'] == 2
    assert dataset.summary['rules_version'] == 'repair-approved-normalization-v1'
    assert dataset.summary['rules_digest'] == snapshot['digest']
    audit = pq.read_table(dataset.directory / 'normalizations.parquet').to_pylist()
    assert [(a['ordinal'], a['before'], a['after'], a['rule_id']) for a in audit] == [
        (1, 'Тeст', 'Тест', 'approved-label'), (2, 'Тeст', 'Тест', 'approved-label')]
    assert [a['record_id'] for a in audit] == [r.record_id for r in originals]
    assert all(a['rule_digest'] == snapshot['digest'] for a in audit)


@pytest.mark.parametrize('role,status,target,key,value', [
    ('NUMBERS', 'Номер телефона уже есть в таблице MAV номеров', 'DELETE', 'MSISDN', '79000001900'),
    ('NUMBERS', MISSING_CLIENT, 'CLIENTS', 'INN', INN),
    ('DOGTAGS', MISSING_CLIENT, 'CLIENTS', 'INN', INN),
])
def test_auxiliary_recovery_uses_valid_key_even_when_unrelated_cells_have_errors(tmp_path, role, status, target, key, value):
    from app.domain.projections import verify_projections
    from app.domain.serialization import write_csv
    dataset = build(tmp_path, role, [row(role, STATUS=status, MAV_LABEL_NAME='Latin_'),
                                     row(role, STATUS=status, MAV_LABEL_NAME='Other_')])
    assert dataset.summary['counts'] == {target: 1, 'ERRORS': 2}
    assert dataset.summary['dispositions'] == {'excluded_error': 2}
    assert dataset.summary['blocking'] is False
    assert [item[key] for item in output(dataset, target)] == [value]
    assert len(output(dataset, 'ERRORS')) == 2
    assert verify_projections(dataset)['counts'] == {target: 1, 'ERRORS': 2}
    write_csv(dataset, target, tmp_path / 'recovery.csv')
    write_csv(dataset, 'ERRORS', tmp_path / 'errors.csv')
    output_path = dataset.directory / f'{FILES[target]}.parquet'
    table = pq.read_table(output_path)
    pq.write_table(table.slice(0, 0), output_path)
    with connection() as db:
        checked = reconcile_repair(db, dataset.directory, dataset.summary)
    assert checked['complete'] is False and checked['missing_assignments'] == 1


@pytest.mark.parametrize('role,status,key,value', [
    ('NUMBERS', 'Номер телефона уже есть в таблице MAV номеров', 'MSISDN', ''),
    ('NUMBERS', 'Номер телефона уже есть в таблице MAV номеров', 'MSISDN', '😀'),
    ('NUMBERS', MISSING_CLIENT, 'INN', '123'),
    ('NUMBERS', MISSING_CLIENT, 'INN', '1234567895'),
    ('NUMBERS', MISSING_CLIENT, 'INN', '1.234e9'),
    ('DOGTAGS', MISSING_CLIENT, 'INN', '123'),
    ('DOGTAGS', MISSING_CLIENT, 'INN', '1.234e9'),
])
def test_invalid_auxiliary_key_stays_in_errors_without_recovery(tmp_path, role, status, key, value):
    dataset = build(tmp_path, role, [row(role, STATUS=status, **{key: value})])
    assert dataset.summary['counts'] == {'ERRORS': 1}
    assert dataset.summary['reconciliation']['complete'] is True


@pytest.mark.parametrize('role,status', [('NUMBERS', 'Номер телефона уже есть в таблице MAV номеров'),
    ('NUMBERS', MISSING_CLIENT), ('DOGTAGS', MISSING_CLIENT)])
def test_manual_exclusion_suppresses_auxiliary_recovery_and_errors(tmp_path, role, status):
    def exclude(source_id, parsed):
        original = next(parsed.records())
        return {'settings': {'row_selections': {original.record_id: {'record_id': original.record_id,
            'ordinal': 1, 'excluded': True, 'source_asset_id': str(source_id), 'mapping_digest': parsed.mapping_digest}}}}
    dataset = build(tmp_path, role, [row(role, STATUS=status, MAV_LABEL_NAME='Latin_')], setup=exclude)
    assert dataset.summary['counts'] == {}
    assert dataset.summary['dispositions'] == {'excluded_manual': 1}
    assert dataset.summary['reconciliation']['complete'] is True


@pytest.mark.parametrize('operator', ['', 'none'])
def test_repair_numbers_preserves_absent_operator_as_empty_cell(tmp_path, operator):
    dataset = build(tmp_path, 'NUMBERS', [row('NUMBERS', INTERNAL_OPERATOR_NAME=operator)])
    assert dataset.summary['counts'] == {'NUMBERS': 1}
    assert output(dataset, 'NUMBERS')[0]['INTERNAL_OPERATOR_NAME'] == ''


@pytest.mark.parametrize('role', ['DOGTAGS', 'NUMBERS'])
def test_returned_general_label_accepts_latin_with_nonblocking_notice(tmp_path, role):
    dataset = build(tmp_path, role, [row(role, MAV_LABEL_NAME='Тест Brand')])
    assert dataset.summary['counts'] == {role: 1}
    assert dataset.summary['blocking'] is False
    assert output(dataset, role)[0]['MAV_LABEL' if role == 'DOGTAGS' else 'MAV_LABEL_NAME'] == 'Тест Brand'
    notices = [i for i in dataset.page('issues')['items'] if i['code'] == 'label_contains_latin']
    assert len(notices) == 1 and notices[0]['scope'] == 'warning'
