from uuid import uuid4

import pytest

from app.domain.readers.csv_reader import CSVTable, discover_csv
from app.domain.readers.mapping import map_columns
from app.domain.readers.base import MappedSource, publish_raw_index, raw_page
from app.storage.local import LocalStorage, StorageFailure

HEADERS = ['Номер телефона', 'MAV_LABEL_LATIN', 'ИНН', 'IS_KSS', 'MAV_LABEL_NAME', 'IS_MAV', 'Комментарий']
ROW = ['001900', 'Test', '1234567894', '0', 'Тест', '1', 'сохранить']


def source(tmp_path, rows=None):
    import csv
    path = tmp_path / 'input.csv'
    with path.open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.writer(stream, delimiter=';')
        writer.writerow(HEADERS)
        writer.writerows(rows or [ROW])
    return path


@pytest.mark.parametrize('inn_header', ['ИНН', 'ИНН клиента'])
def test_mapping_uses_meaning_without_reordering_or_losing_extra_cells(tmp_path, inn_header):
    path, source_id = source(tmp_path), uuid4()
    path.write_text(path.read_text(encoding='utf-8-sig').replace('ИНН;', inn_header + ';', 1), encoding='utf-8-sig')
    choices = discover_csv(path)
    assert len(choices) == 1
    mapping = map_columns(choices[0]['columns'])
    assert mapping['complete'] and mapping['mapping']['INN'] == 2
    assert mapping['extras'] == [6]
    storage = LocalStorage(tmp_path / 'storage')
    key = publish_raw_index(CSVTable(path, source_id, **choices[0]['reader']), storage, tmp_path / 'work')
    parsed = MappedSource(storage, key, source_id, mapping['mapping'])
    record = next(parsed.records())
    assert record.values == dict(INN='1234567894', MSISDN='001900', MAV_LABEL_NAME='Тест',
                                 MAV_LABEL_LATIN='Test', IS_MAV='1', IS_KSS='0')
    assert record.raw_cells == ROW
    assert record.as_arrow_row({'INN':'123456789047', **{k:v for k,v in record.values.items() if k!='INN'}})['effective_cells'][6] == 'сохранить'


def test_ambiguous_headers_and_anonymous_numbers_require_decision():
    result = map_columns(['INN', 'ИНН', *HEADERS])
    assert not result['complete'] and len(result['candidates']['INN']) == 3
    result = map_columns(['Число 1', 'Число 2'])
    assert not result['complete'] and result['mapping'] == {}


def test_supplied_english_headers_work_with_previously_published_aliases():
    columns = ['labelLatin', 'phonenumber', 'INN', 'IS_KSS', 'label']
    result = map_columns(columns, {'INN': ['ИНН']})
    assert result['complete'] and result['missing'] == ['IS_MAV']
    assert result['mapping'] == {'INN': 2, 'MSISDN': 1, 'MAV_LABEL_NAME': 4,
                                 'MAV_LABEL_LATIN': 0, 'IS_KSS': 3}
    ambiguous = map_columns([*columns, 'IS_MAV', 'Признак МАВ'])
    assert not ambiguous['complete'] and ambiguous['ambiguous'] == ['IS_MAV']


@pytest.mark.parametrize('fault', ['index', 'fragment'])
def test_bounded_deep_page_and_corruption_detection(tmp_path, monkeypatch, fault):
    path, source_id = source(tmp_path, [ROW] * 2500), uuid4()
    storage = LocalStorage(tmp_path / 'storage')
    key = publish_raw_index(CSVTable(path, source_id, encoding='utf-8-sig', delimiter=';'),
                            storage, tmp_path / 'work', chunk_rows=100)
    original, verified = storage.verify, []
    def verify(key, digest, size):
        verified.append(size)
        return original(key, digest, size)
    monkeypatch.setattr(storage, 'verify', verify)
    page = raw_page(storage, key, after=2400, limit=20)
    assert len(page['items']) == 20 and page['items'][0]['ordinal'] == 2401
    assert len(verified) <= 2  # bounded index plus only the selected fragment
    fragment = page['items'][0]
    assert fragment['cells'][0] == '001900'
    # Index itself is trusted by its content hash, never by timestamp.
    if fault == 'fragment':
        import json
        key_to_damage = json.loads(storage.path_for_key(key).read_bytes())['chunks'][-1]['key']
    else:
        key_to_damage = key
    storage.path_for_key(key_to_damage).write_bytes(b'{}')
    with pytest.raises(StorageFailure):
        raw_page(storage, key, after=2400, limit=20)


def test_multiline_and_malformed_prefix_are_retained(tmp_path):
    path = source(tmp_path, [[*ROW[:-1], 'first\nsecond'], ROW])
    with path.open('ab') as stream:
        stream.write(b'"unterminated')
    table = CSVTable(path, uuid4(), encoding='utf-8-sig', delimiter=';')
    records = list(table.records())
    assert len(records) == 2 and records[0]['line_end'] == 3
    assert records[0]['cells'][-1] == 'first\nsecond'
    assert table.summary['unknown_remainder']
    assert table.summary['file_errors'][0]['code'] == 'source_csv_syntax_error'


@pytest.mark.parametrize('ending,code,count', [(b'\xff', 'source_encoding_error', 1),
                                               (b'bad;shape\n', None, 2)])
def test_bad_encoding_retains_prefix_and_row_shape_retains_cells(tmp_path, ending, code, count):
    path = source(tmp_path)
    with path.open('ab') as stream:
        stream.write(ending)
    table = CSVTable(path, uuid4(), encoding='utf-8-sig', delimiter=';')
    records = list(table.records())
    assert len(records) == count
    if code:
        assert table.summary['file_errors'][0]['code'] == code
        assert table.summary['records_count'] is None
    else:
        assert records[-1]['cells'] == ['bad', 'shape']
        assert records[-1]['issues'][0]['code'] == 'row_shape'


def test_empty_and_cp1251_sources_have_explicit_results(tmp_path):
    path = tmp_path / 'empty.csv'
    path.write_bytes(b'INN;MSISDN\r\n')
    table = CSVTable(path, uuid4(), encoding='utf-8', delimiter=';')
    assert list(table.records()) == []
    assert table.summary['file_errors'][0]['code'] == 'source_empty'
    path.write_bytes((';'.join(HEADERS) + '\n' + ';'.join(ROW) + '\n').encode('cp1251'))
    choices = discover_csv(path)
    assert len(choices) == 1 and choices[0]['reader']['encoding'] == 'cp1251'


def test_blank_and_flag_only_rows_are_skipped_but_partial_records_keep_physical_coordinates(tmp_path):
    path = tmp_path / 'blank.csv'
    path.write_text('INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n'
                    '7805406976;001;Ёлка;Elka;1;0\n\n;;;;;\n;;;;;0\n'
                    ';;;;1;0\n\u00a0; ; ; ; ; \n7805406976;;;;;\n', encoding='utf-8')
    table = CSVTable(path, uuid4(), encoding='utf-8', delimiter=';')
    rows = list(table.records())
    assert len(rows) == table.summary['records_count'] == 2
    assert table.summary['skipped_empty_rows'] == 5
    assert [row['ordinal'] for row in rows] == [1, 2]
    assert [row['row_number'] for row in rows] == [2, 8]
    assert rows[-1]['cells'][0] == '7805406976'


def test_mapping_change_invalidates_correction_but_not_source_coordinates(tmp_path):
    from app.domain.canonical import build_dataset
    path, source_id = source(tmp_path), uuid4()
    storage = LocalStorage(tmp_path / 'storage')
    key = publish_raw_index(CSVTable(path, source_id, encoding='utf-8-sig', delimiter=';'),
                            storage, tmp_path / 'index')
    mapping = map_columns(HEADERS)['mapping']
    old = MappedSource(storage, key, source_id, mapping)
    record = next(old.records())
    changed = {**mapping, 'IS_MAV': mapping['IS_KSS'], 'IS_KSS': mapping['IS_MAV']}
    new = MappedSource(storage, key, source_id, changed)
    assert next(new.records()).record_id == record.record_id
    overlay = [{'record_id': record.record_id, 'ordinal': 1, 'field': 'INN',
                'before': '1234567894', 'after': '123456789047', 'mapping_digest': old.mapping_digest}]
    with pytest.raises(ValueError, match='Correction'):
        build_dataset(path, None, source_id, tmp_path / 'dataset',
                       {'id': 'hub-v1', 'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': 'hubRTK'},
                       parsed_source=new, correction_overlay=overlay)


def test_output_encoding_error_points_to_the_indexed_source_row(tmp_path):
    from app.domain.canonical import build_dataset
    from app.domain.serialization import SerializationFailure, write_csv
    path, source_id = source(tmp_path, [['900🙂', *ROW[1:]]]), uuid4()
    storage = LocalStorage(tmp_path / 'storage')
    key = publish_raw_index(CSVTable(path, source_id, encoding='utf-8-sig', delimiter=';'),
                            storage, tmp_path / 'raw')
    parsed = MappedSource(storage, key, source_id, map_columns(HEADERS)['mapping'])
    expected_id = next(parsed.records()).record_id
    dataset = build_dataset(path, None, source_id, tmp_path / 'dataset',
                            {'id': 'hub-v1', 'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': 'hubRTK'},
                            parsed_source=parsed)
    with pytest.raises(SerializationFailure) as error:
        write_csv(dataset, 'NUMBERS', tmp_path / 'numbers.csv')
    assert error.value.diagnostics[0]['record_id'] == expected_id


def test_utf8_without_bom_uses_unique_published_label_alphabet(tmp_path):
    path = tmp_path / 'no-bom.csv'
    path.write_text('MSISDN;MAV_LABEL_LATIN;INN;IS_KSS;MAV_LABEL_NAME;IS_MAV;EXTRA\n'
                    + ';'.join(ROW) + '\n', encoding='utf-8')
    choices = discover_csv(path)
    assert len(choices) == 1 and choices[0]['reader']['encoding'] == 'utf-8'


def test_encoding_stays_ambiguous_when_only_unmapped_text_distinguishes_it(tmp_path):
    row = [*ROW]
    row[4] = ''
    path = tmp_path / 'ambiguous.csv'
    path.write_text('MSISDN;MAV_LABEL_LATIN;INN;IS_KSS;MAV_LABEL_NAME;IS_MAV;EXTRA\n'
                    + ';'.join(row) + '\n', encoding='utf-8')
    # Empty labels are a business error, but do not prove how to decode extras.
    assert len(discover_csv(path)) == 2
