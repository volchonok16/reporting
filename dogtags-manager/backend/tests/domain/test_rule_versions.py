"""All replacements/status phrases below are synthetic, never production defaults."""
import copy
from uuid import uuid4

import pyarrow.parquet as pq
import pytest

from app.domain.rules import (RuleConfig, classify_status, normalize_values, profile_for,
                              resolve_partner, rules_snapshot, seed_config, validate_config)
from app.domain.canonical import build_dataset


def synthetic():
    config = seed_config()
    config['version'] = 'synthetic-v1'
    config['normalizations'] = [{'id': 'synthetic-label', 'field': 'MAV_LABEL_NAME',
                                 'before': 'Тeст', 'after': 'Тест'}]
    config['statuses'] = [{'value': 'SYNTHETIC_OK', 'classification': 'success'}]
    config['attribution'] = [{'id': 'synthetic-mail', 'field': 'sender',
                              'address': 'hub@example.invalid', 'partner': 'RTK HUB'}]
    config['examples'] = [{'kind': 'normalization', 'rule_id': 'synthetic-label',
                           'before': 'Тeст', 'after': 'Тест'},
                          {'kind': 'status', 'value': 'SYNTHETIC_OK', 'classification': 'success'},
                          {'kind': 'attribution', 'context': {'sender': ['hub@example.invalid']},
                           'partner': 'RTK HUB'}]
    return config


def test_seed_profiles_and_trust_boundary():
    snapshot = rules_snapshot(validate_config(synthetic()))
    assert resolve_partner(snapshot, manual='RTK ABC')['partner'] == 'RTK ABC'
    assert profile_for(snapshot, 'RTK ABC')['INTERNAL_OPERATOR_NAME'] == 'fRTK'
    assert profile_for(snapshot, 'RTK MVNO')['INTERNAL_OPERATOR_NAME'] == ''
    context = {'sender': ['hub@example.invalid'], 'verified': True}
    assert resolve_partner(snapshot, context=context)['partner'] is None
    assert resolve_partner(snapshot, context=context, trusted=True)['partner'] == 'RTK HUB'
    assert seed_config()['normalizations'] == seed_config()['statuses'] == []


def test_label_linebreaks_are_spaces_with_audit_and_historical_overlays():
    from types import SimpleNamespace
    from app.domain.rules import Normalizer
    from app.domain.corrections import effective_values
    normalizer = Normalizer(rules_snapshot(seed_config()))
    raw = {'MAV_LABEL_NAME': 'ООО\r\nТест', 'MAV_LABEL_LATIN': 'Test\nTaxi', 'MSISDN': '7900\n123'}
    normalized, audit = normalizer.apply(raw)
    assert normalized == {**raw, 'MAV_LABEL_NAME': 'ООО Тест', 'MAV_LABEL_LATIN': 'Test Taxi'}
    assert len(audit) == 2 and all(item['rule_id'] == 'label-linebreak-space-v1' for item in audit)
    assert raw['MAV_LABEL_NAME'] == 'ООО\r\nТест'
    record = SimpleNamespace(record_id='r', values=raw)
    overlay = [{'record_id': 'r', 'field': 'MAV_LABEL_NAME', 'before': raw['MAV_LABEL_NAME'], 'after': 'Новый\nТест'}]
    assert effective_values(record, overlay, normalizer=normalizer)['MAV_LABEL_NAME'] == 'Новый Тест'


def test_inn_boundary_spaces_are_audited_without_guessing_or_changing_digits():
    from app.domain.corrections import effective_values
    from app.domain.rules import Normalizer
    from types import SimpleNamespace
    normalizer = Normalizer(rules_snapshot(seed_config()))
    raw = {'INN': '\u00a07805406976  '}
    normalized, audit = normalizer.apply(raw)
    assert normalized['INN'] == '7805406976' and raw['INN'] == '\u00a07805406976  '
    assert audit[0]['before'] == raw['INN'] and audit[-1]['after'] == '7805406976'
    assert audit[0]['rule_id'] == 'nonbreaking-space-v1'
    assert audit[-1]['rule_id'] == 'inn-boundary-whitespace-v1'
    for value in ('7,84201E+11', ' 7,84201E+11 ', '7805 406976', '７８０５４０６９７６'):
        assert normalizer.apply({'INN': value})[0]['INN'] == value
    record = SimpleNamespace(record_id='r', values=raw)
    # Historical before-values and new normalized before-values both replay.
    for before in (raw['INN'], '7805406976'):
        result = effective_values(record, [{'record_id': 'r', 'field': 'INN', 'before': before,
                                           'after': '7707083893'}], normalizer=normalizer)
        assert result['INN'] == '7707083893'


def test_nonbreaking_spaces_are_normalized_in_every_field_and_overlay_history():
    from types import SimpleNamespace
    from app.domain.rules import Normalizer
    from app.domain.corrections import effective_values
    normalizer = Normalizer(rules_snapshot(seed_config()))
    raw = {'INN': '7805406976', 'MAV_LABEL_NAME': 'Ёлка\u00a0и\u202fёж', 'MSISDN': '00\u00a0123'}
    effective, changes = normalizer.apply(raw)
    assert effective['MAV_LABEL_NAME'] == 'Ёлка и ёж'
    assert effective['MSISDN'] == '00 123'
    assert {change['field'] for change in changes} == {'MAV_LABEL_NAME', 'MSISDN'}
    assert all(change['rule_id'] == 'nonbreaking-space-v1' for change in changes)
    record = SimpleNamespace(record_id='r', values=raw)
    overlay = [{'record_id': 'r', 'field': 'MAV_LABEL_NAME', 'before': raw['MAV_LABEL_NAME'], 'after': 'Новый\u00a0ёж'}]
    assert effective_values(record, overlay, normalizer=normalizer)['MAV_LABEL_NAME'] == 'Новый ёж'


def test_conflicting_attribution_requires_manual():
    config = synthetic()
    config['attribution'].append({'id': 'other', 'field': 'recipient', 'address': 'abc@example.invalid',
                                   'partner': 'RTK ABC'})
    config['examples'].append({'kind': 'attribution', 'context': {'recipient': ['abc@example.invalid']},
                               'partner': 'RTK ABC'})
    snapshot = rules_snapshot(validate_config(config))
    answer = resolve_partner(snapshot, context={'sender': ['hub@example.invalid'],
                                               'recipient': ['abc@example.invalid']}, trusted=True)
    assert answer['partner'] is None and answer['reason'] == 'conflict'


def test_exact_rules_and_examples_are_validated_and_snapshots_frozen():
    config = synthetic()
    snapshot = rules_snapshot(validate_config(config))
    values, changes = normalize_values({'MAV_LABEL_NAME': 'Тeст', 'IS_MAV': '0', 'IS_KSS': '1'}, snapshot)
    assert values == {'MAV_LABEL_NAME': 'Тест', 'IS_MAV': '0', 'IS_KSS': '1'}
    assert changes[0]['before'] == 'Тeст' and changes[0]['rule_version'] == 'synthetic-v1'
    assert classify_status('SYNTHETIC_OK', snapshot) == 'success'
    assert classify_status('synthetic_ok', snapshot) == 'unknown'
    newer = copy.deepcopy(config)
    newer['version'] = 'synthetic-v2'
    newer['normalizations'][0]['after'] = 'Другое'
    with pytest.raises(ValueError):
        validate_config(newer)  # stale example
    assert normalize_values({'MAV_LABEL_NAME': 'Тeст'}, snapshot)[0]['MAV_LABEL_NAME'] == 'Тест'
    snapshot['config']['version'] = 'tampered'
    with pytest.raises(ValueError):
        profile_for(snapshot, 'RTK HUB')
    assert RuleConfig.model_json_schema()['additionalProperties'] is False


def test_normalization_pipeline_logs_raw_before_after_without_summary_growth(tmp_path):
    snapshot = rules_snapshot(validate_config(synthetic()))
    path = tmp_path / 'input.csv'
    path.write_text('INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n'
                    '7707083893;79000000000;Тeст;Test;0;1\n'
                    '7707083893;79000000001;Тeст;Test;0;1\n', encoding='utf-8')
    dataset = build_dataset(path, 'utf-8', uuid4(), tmp_path / 'dataset',
                            profile_for(snapshot, 'RTK MVNO'), settings={'rules_snapshot': snapshot})
    assert dataset.summary['normalization_count'] == 2
    assert not dataset.summary['blocking']
    logs = pq.read_table(dataset.directory / 'normalizations.parquet').to_pylist()
    assert len(logs) == 2 and logs[0]['before'] == 'Тeст' and logs[0]['after'] == 'Тест'
    assert logs[0]['rule_digest'] == snapshot['digest']
    assert dataset.page('raw')['items'][0]['MAV_LABEL_NAME'] == 'Тeст'
    assert dataset.page('NUMBERS')['items'][0]['IS_KSS'] == '1'
    assert dataset.page('NUMBERS')['items'][0]['INTERNAL_OPERATOR_NAME'] == ''


def test_multiline_labels_are_normalized_before_validation_and_export(tmp_path):
    import csv
    snapshot = rules_snapshot(seed_config())
    path = tmp_path / 'multiline.csv'
    with path.open('w', newline='') as stream:
        writer = csv.writer(stream, delimiter=';')
        writer.writerow(['INN', 'MSISDN', 'MAV_LABEL_NAME', 'MAV_LABEL_LATIN', 'IS_MAV', 'IS_KSS'])
        writer.writerow(['7707083893', '79000000000', 'ООО\r\nТест', 'Test\nTaxi', '0', '1'])
    dataset = build_dataset(path, 'utf-8', uuid4(), tmp_path / 'dataset',
                            profile_for(snapshot, 'RTK HUB'), settings={'rules_snapshot': snapshot})
    assert not dataset.summary['blocking']
    assert dataset.summary['normalization_count'] == 2
    assert dataset.page('DOGTAGS')['items'][0]['MAV_LABEL'] == 'ООО Тест'
    assert dataset.page('DOGTAGS')['items'][0]['MAV_LABEL_LATIN'] == 'Test Taxi'
    assert dataset.page('raw')['items'][0]['MAV_LABEL_LATIN'] == 'Test\nTaxi'


def test_manual_correction_uses_normalized_before_and_overrides_rule(tmp_path):
    from app.domain.ingress import source_record_id
    snapshot = rules_snapshot(validate_config(synthetic()))
    source_id = uuid4()
    path = tmp_path / 'manual.csv'
    path.write_text('INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n'
                    '7707083893;79000000000;Тeст;Test;0;1\n', encoding='utf-8')
    overlay = [{'record_id': str(source_record_id(source_id, 1)), 'ordinal': 1,
                'field': 'MAV_LABEL_NAME', 'before': 'Тест', 'after': 'Проверено'}]
    dataset = build_dataset(path, 'utf-8', source_id, tmp_path / 'corrected',
                            profile_for(snapshot, 'RTK HUB'), settings={'rules_snapshot': snapshot},
                            correction_overlay=overlay)
    assert dataset.page('DOGTAGS')['items'][0]['MAV_LABEL'] == 'Проверено'
    assert pq.read_table(dataset.directory / 'normalizations.parquet').to_pylist()[0]['after'] == 'Тест'


def test_legacy_pinned_none_profile_outputs_empty_without_rewriting_snapshot(tmp_path):
    from app.domain.serialization import write_csv
    config = seed_config()
    config['version'] = 'legacy-placeholder-test'
    config['profiles']['RTK MVNO']['INTERNAL_OPERATOR_NAME'] = 'none'
    snapshot = rules_snapshot(config)
    original = copy.deepcopy(snapshot)
    path = tmp_path / 'source.csv'
    path.write_text('INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n'
                    '7707083893;79000000000;Тест;Test;0;1\n', encoding='utf-8')
    dataset = build_dataset(path, 'utf-8', uuid4(), tmp_path / 'dataset',
        profile_for(snapshot, 'RTK MVNO'), settings={'rules_snapshot': snapshot})
    assert dataset.page('NUMBERS')['items'][0]['INTERNAL_OPERATOR_NAME'] == ''
    assert snapshot == original
    obj = write_csv(dataset, 'NUMBERS', tmp_path / 'numbers.csv')
    assert obj.path.read_bytes().endswith(b';0;1;1;\r\n')
