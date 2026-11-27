from uuid import uuid4

import pytest

from app.domain.canonical import build_dataset
from app.domain.ingress import source_record_id
from app.domain.projections import verify_projections
from app.domain.validation import validate_msisdn
from test_lineage import PROFILE, ROW, dataset
from test_validation import HEADER
from test_delete_contract import dataset_for


@pytest.mark.parametrize('dirty', ['+79878384919', '\ufeff+7 (987) 838-49-19\t', "'79878384919", '\u200b79878384919'])
def test_cleanup_retains_source_and_warns_without_blocking(tmp_path, dirty):
    _, result = dataset(tmp_path, [[ROW[0], dirty, *ROW[2:]]])
    row = result.page('records')['items'][0]
    assert row['effective']['MSISDN'] == '79878384919'
    assert row['raw_cells'][1] == dirty
    assert not result.summary['blocking']
    issues = [issue for issue in result.page('issues')['items'] if issue['code'] == 'msisdn_cleaned']
    assert len(issues) == 1 and issues[0]['scope'] == 'warning' and issues[0]['ordinal'] == 1
    assert '79878384919' in issues[0]['message']
    assert result.summary['issue_counts']['msisdn_cleaned'] == 1
    assert verify_projections(result)['reconciliation']['complete']


def test_cleanup_happens_before_duplicate_and_conflict_detection(tmp_path):
    _, result = dataset(tmp_path, [[ROW[0], '+79878384919', *ROW[2:]],
                                 [ROW[0], '79878384919', *ROW[2:]]])
    assert result.summary['dispositions'] == {'included': 1, 'exact_duplicate': 1}
    assert result.summary['counts']['NUMBERS'] == 1
    assert not result.summary['blocking']


def test_same_number_with_other_inn_is_conflict_not_full_duplicate(tmp_path):
    _, result = dataset(tmp_path, [[ROW[0], '+79878384919', *ROW[2:]],
                                 ['123456789047', '79878384919', *ROW[2:]]])
    assert result.summary['dispositions'] == {'conflict': 2}
    assert result.summary['issue_counts']['msisdn_assignment_conflict'] == 2


def test_same_inn_with_other_number_is_not_duplicate(tmp_path):
    _, result = dataset(tmp_path, [ROW, [ROW[0], '79878384919', *ROW[2:]]])
    assert result.summary['dispositions'] == {'included': 2}


def test_same_pair_with_different_label_is_not_a_full_duplicate(tmp_path):
    _, result = dataset(tmp_path, [ROW, [*ROW[:2], 'Другая', 'Other', *ROW[4:]]])
    assert result.summary['dispositions'] == {'included': 2}
    assert result.summary['counts']['NUMBERS'] == 2


@pytest.mark.parametrize('number', ['89878384919', '123', '798783849190', '７9878384919'])
def test_wrong_number_is_rejected(number):
    assert validate_msisdn(number)[0]['code'] == 'msisdn_format'


def test_delete_cleanup_preserves_export_hash_verification(tmp_path):
    result = dataset_for(tmp_path, ['+79878384919', '79878384919'])
    assert not result.summary['blocking']
    assert result.summary['counts'] == {'DELETE': 1}
    assert result.summary['issue_counts']['msisdn_cleaned'] == 1
    assert verify_projections(result)['reconciliation']['complete']


def test_displayed_cleaned_value_and_legacy_overlay_both_replay(tmp_path):
    for index, before in enumerate(('+79878384919', '79878384919')):
        path = tmp_path / f'source{index}.csv'
        path.write_text(HEADER + '\n' + ';'.join([ROW[0], '+79878384919', *ROW[2:]]) + '\n')
        source = uuid4()
        result = build_dataset(path, 'utf-8', source, tmp_path / f'data{index}', PROFILE, correction_overlay=[{
            'record_id': str(source_record_id(source, 1)), 'ordinal': 1, 'field': 'MSISDN',
            'before': before, 'after': '+79000000012', 'reason': 'Confirmed edit'}])
        assert result.page('records')['items'][0]['effective']['MSISDN'] == '79000000012'
        assert not result.summary['blocking']


def test_builtin_cleanup_and_flag_changes_are_in_normalization_audit(tmp_path):
    import pyarrow.parquet as pq
    from app.domain.rules import profile_for, rules_snapshot, seed_config
    snapshot = rules_snapshot(seed_config())
    path = tmp_path / 'source.csv'
    path.write_text(HEADER + '\n' + ';'.join([ROW[0], '+79878384919', *ROW[2:]]) + '\n')
    result = build_dataset(path, 'utf-8', uuid4(), tmp_path / 'dataset', profile_for(snapshot, 'RTK HUB'),
                           settings={'rules_snapshot': snapshot})
    changes = pq.read_table(result.directory / 'normalizations.parquet').to_pylist()
    assert {(c['field'], c['before'], c['after']) for c in changes} >= {
        ('IS_KSS', '1', '0'), ('MSISDN', '+79878384919', '79878384919')}
    assert result.summary['normalization_count'] == len(changes)


def test_manual_input_cleanup_also_has_a_popup_diagnostic(tmp_path):
    def overlay(source):
        return [{'record_id': str(source_record_id(source, 1)), 'ordinal': 1, 'field': 'MSISDN',
                 'before': ROW[1], 'after': '+79878384919', 'reason': 'Confirmed edit'}]
    _, result = dataset(tmp_path, [ROW], overlay)
    assert result.summary['issue_counts']['msisdn_cleaned'] == 1
    assert '+' in next(i['message'] for i in result.page('issues')['items'] if i['code'] == 'msisdn_cleaned')


def test_repair_cleanup_warning_does_not_block_delete_reconciliation(tmp_path):
    from test_repair import build, row
    from app.domain.projections import verify_projections
    result = build(tmp_path, 'NUMBERS', [row('NUMBERS', MSISDN='+79878384919',
        STATUS='Номер телефона уже есть в таблице MAV номеров')])
    assert result.summary['counts'] == {'DELETE': 1}
    assert result.summary['reconciliation']['complete']
    assert not result.summary['blocking']
    assert verify_projections(result)['counts'] == {'DELETE': 1}


def test_legacy_prefix_history_replays_without_changing_its_meaning(tmp_path):
    source = uuid4()
    path = tmp_path / 'legacy.csv'
    path.write_text(HEADER + '\n' + ';'.join([ROW[0], '+9878384919', *ROW[2:]]) + '\n')
    overlay = [
        {'action': 'prefix_ten_digit_msisdn', 'field': 'MSISDN', 'source_asset_id': str(source),
         'mapping_digest': None, 'rule_version': 'operator-confirmed-prefix-v1'},
        {'record_id': str(source_record_id(source, 1)), 'ordinal': 1, 'field': 'MSISDN',
         'before': '+9878384919', 'after': '79878384919', 'reason': 'Confirmed full number'}]
    result = build_dataset(path, 'utf-8', source, tmp_path / 'dataset', PROFILE, correction_overlay=overlay)
    assert not result.summary['blocking']
    assert result.page('records')['items'][0]['effective']['MSISDN'] == '79878384919'


def test_new_prefix_cleans_symbols_before_operator_confirmed_prefix(tmp_path):
    source = uuid4()
    path = tmp_path / 'new.csv'
    path.write_text(HEADER + '\n' + ';'.join([ROW[0], '+9878384919', *ROW[2:]]) + '\n')
    overlay = [{'action': 'prefix_ten_digit_msisdn', 'field': 'MSISDN', 'source_asset_id': str(source),
                'mapping_digest': None, 'rule_version': 'operator-confirmed-prefix-v2'}]
    result = build_dataset(path, 'utf-8', source, tmp_path / 'dataset', PROFILE, correction_overlay=overlay)
    assert not result.summary['blocking']
    assert result.page('records')['items'][0]['effective']['MSISDN'] == '79878384919'
