from dataclasses import replace
from html import escape
import struct
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from app.domain.readers.containers import ExcelLimits, WorkbookError, detect_format
from app.domain.readers.xlsx_reader import XLSXTable, discover_xlsx
from app.domain.readers.xls_reader import XLSTable, discover_xls
from app.domain.readers.base import MappedSource, publish_raw_index, raw_page
from app.domain.readers.mapping import map_columns
from app.storage.local import LocalStorage

HEADERS = ['INN', 'MSISDN', 'MAV_LABEL_NAME', 'MAV_LABEL_LATIN', 'IS_MAV', 'IS_KSS']
VALUES = ['0012345678', '79001234567', 'Тест', 'Test', '1', '0']


def workbook(path, sheets, *, dimensions='A1:F2', extra=None):
    """Small real OOXML fixture, including caches that workbook writers cannot create."""
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    with ZipFile(path, 'w', ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>')
        archive.writestr('xl/workbook.xml', f'<workbook xmlns="{ns}" xmlns:r="{rel}"><sheets>' + ''.join(f'<sheet name="{name}" sheetId="{i}" state="{state}" r:id="rId{i}"/>' for i, (name, state, _) in enumerate(sheets, 1)) + '</sheets></workbook>')
        archive.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + ''.join(f'<Relationship Id="rId{i}" Type="{rel}/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(sheets) + 1)) + '</Relationships>')
        for i, (_, _, rows) in enumerate(sheets, 1):
            body = []
            for rn, row in enumerate(rows, 1):
                cells = []
                for col, value in enumerate(row):
                    coord = f'{chr(65+col)}{rn}'
                    cells.append(value.format(coord=coord) if isinstance(value, str) and value.startswith('<c ') else f'<c r="{coord}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>')
                body.append(f'<row r="{rn}">{"".join(cells)}</row>')
            archive.writestr(f'xl/worksheets/sheet{i}.xml', f'<worksheet xmlns="{ns}"><dimension ref="{dimensions}"/><sheetData>{"".join(body)}</sheetData></worksheet>')
        for name, value in (extra or {}).items():
            archive.writestr(name, value)
    return path


def test_xlsx_preserves_values_positions_and_hidden_sheet_candidates(tmp_path):
    path = workbook(tmp_path / 'input.xlsx', [('Main', 'visible', [['Title'], HEADERS, VALUES]),
                                             ('Hidden', 'hidden', [HEADERS, VALUES])], dimensions='A1:A1')
    result = discover_xlsx(path)
    assert len(result['candidates']) == 2
    assert result['inventory'][1]['state'] == 'hidden'
    assert result['candidates'][0]['reader']['header_row'] == 2
    source_id = uuid4()
    storage = LocalStorage(tmp_path / 'storage')
    table = XLSXTable(path, source_id, **result['candidates'][0]['reader'])
    key = publish_raw_index(table, storage, tmp_path / 'scratch')
    row = raw_page(storage, key)['items'][0]
    assert row['row_number'] == 3 and row['cells'] == VALUES
    assert row['cell_metadata'][0]['coordinate'] == 'A3'
    mapped = MappedSource(storage, key, source_id, map_columns(HEADERS)['mapping'])
    assert next(mapped.records()).values == dict(zip(HEADERS, VALUES))


def test_xlsx_skips_empty_and_flag_only_rows_but_keeps_missing_formula_cache(tmp_path):
    path = workbook(tmp_path / 'blanks.xlsx', [('Main', 'visible', [HEADERS, VALUES, [''] * 6,
        ['', '', '', '', '0', '0'], [' ', '\u00a0'],
        ['<c r="{coord}"><f>1+1</f></c>'], VALUES])])
    table = XLSXTable(path, uuid4(), sheet='Main', header_row=1)
    rows = list(table.records())
    assert [row['row_number'] for row in rows] == [2, 6, 7]
    assert [row['ordinal'] for row in rows] == [1, 2, 3]
    assert table.summary['skipped_empty_rows'] == 3
    assert rows[1]['issues'][0]['code'] == 'excel_formula_cache_missing'


def test_cached_formula_missing_cache_and_errors_are_honest(tmp_path):
    row = [VALUES[0], '<c r="{coord}"><f>70000000000+1</f><v>70000000001</v></c>',
           VALUES[2], '<c r="{coord}" t="str"><f>"Test"</f></c>',
           '<c r="{coord}" t="e"><v>#VALUE!</v></c>', '0']
    path = workbook(tmp_path / 'formula.xlsx', [('Main', 'visible', [HEADERS, row])])
    table = XLSXTable(path, uuid4(), sheet='Main', header_row=1)
    record = list(table.records())[0]
    assert record['cells'][1] == '70000000001'
    assert record['cell_metadata'][1]['formula'] == '=70000000000+1'
    assert record['cell_metadata'][1]['cached_value'] == 70000000001
    assert {i['code'] for i in record['issues']} == {'excel_formula_cache_missing', 'excel_error'}


def test_numeric_mask_never_restores_zero_and_precision_is_flagged(tmp_path):
    from openpyxl import Workbook
    book = Workbook()
    sheet = book.active
    sheet.append(HEADERS)
    sheet.append([123456789, 1234567890123456, 'Тест', 'Test', 1, 0])
    sheet['A2'].number_format = '0000000000'
    sheet['B2'].number_format = '0.00E+00'
    path = tmp_path / 'numbers.xlsx'
    book.save(path)
    record = list(XLSXTable(path, uuid4(), sheet=sheet.title, header_row=1).records())[0]
    assert record['cells'][0] == '123456789'
    assert record['cell_metadata'][0]['number_format'] == '0000000000'
    assert {i['code'] for i in record['issues']} >= {'excel_numeric_precision', 'excel_scientific_notation'}


def test_excel_container_and_cell_budgets_fail_with_explicit_reason(tmp_path):
    path = workbook(tmp_path / 'large.xlsx', [('Main', 'visible', [HEADERS, VALUES])])
    with pytest.raises(WorkbookError, match='excel_uncompressed_limit'):
        discover_xlsx(path, limits=replace(ExcelLimits(), max_uncompressed_bytes=100))
    with pytest.raises(WorkbookError, match='excel_cell_limit'):
        discover_xlsx(path, limits=replace(ExcelLimits(), max_cells=7))
    path.write_bytes(b'not a workbook')
    with pytest.raises(WorkbookError, match='excel_invalid_container'):
        discover_xlsx(path)


def test_xml_entity_and_encrypted_container_are_rejected(tmp_path):
    path = workbook(tmp_path / 'entity.xlsx', [('Main', 'visible', [HEADERS, VALUES])],
                    extra={'custom.xml': '<!DOCTYPE a [<!ENTITY x "secret">]><a>&x;</a>'})
    with pytest.raises(WorkbookError, match='excel_unsafe_xml'):
        discover_xlsx(path)
    path.write_bytes(bytes.fromhex('d0cf11e0a1b11ae1') + b'EncryptedPackage')
    assert detect_format(path) == 'xls'
    with pytest.raises(WorkbookError):
        discover_xls(path)


def biff2(path):
    def record(code, data):
        return struct.pack('<HH', code, len(data)) + data
    data = record(0x0009, struct.pack('<HH', 0x0002, 0x0010))
    for rn, row in enumerate([HEADERS, [*VALUES[:2], 'Test', *VALUES[3:]]]):
        for cn, value in enumerate(row):
            encoded = value.encode('ascii')
            data += record(0x0004, struct.pack('<HH', rn, cn) + b'\x00\x00\x00' + bytes([len(encoded)]) + encoded)
    path.write_bytes(data + record(0x000a, b''))
    return path


def test_xls_stored_values_use_shared_raw_interface(tmp_path):
    path = biff2(tmp_path / 'input.xls')
    choices = discover_xls(path)
    assert len(choices['candidates']) == 1
    table = XLSTable(path, uuid4(), **choices['candidates'][0]['reader'])
    record = list(table.records())[0]
    assert record['cells'] == [*VALUES[:2], 'Test', *VALUES[3:]]
    assert record['cell_metadata'][0]['formula_provenance'] == 'unavailable_in_xlrd'
    assert 'formula_provenance_unavailable' in table.summary['limitations']


@pytest.mark.parametrize('setting,code', [('max_members', 'excel_member_limit'),
                                        ('max_compressed_bytes', 'excel_compressed_limit'),
                                        ('max_shared_strings_bytes', 'excel_shared_strings_limit')])
def test_declared_resource_budgets_are_enforced(tmp_path, setting, code):
    path = workbook(tmp_path / 'limited.xlsx', [('Main', 'visible', [HEADERS, VALUES])],
                    extra={'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>long shared string</t></si></sst>'})
    with pytest.raises(WorkbookError, match=code):
        discover_xlsx(path, limits=replace(ExcelLimits(), **{setting: 1}))


def test_cell_failures_map_to_fields_but_extra_cells_remain_evidence(tmp_path):
    error = '<c r="{coord}" t="e"><v>#VALUE!</v></c>'
    path = workbook(tmp_path / 'errors.xlsx', [('Main', 'visible', [[*HEADERS, 'Extra'], [error, *VALUES[1:], error]])])
    source_id = uuid4()
    storage = LocalStorage(tmp_path / 'storage')
    key = publish_raw_index(XLSXTable(path, source_id, sheet='Main', header_row=1), storage, tmp_path / 'scratch')
    raw = raw_page(storage, key)['items'][0]
    assert len(raw['issues']) == 2 and raw['cell_metadata'][6]['issues']
    parsed = MappedSource(storage, key, source_id, map_columns([*HEADERS, 'Extra'])['mapping'])
    assert [issue['field'] for issue in next(parsed.records()).issues] == ['INN']


def test_table_range_changes_preserve_row_identity_and_budget_reports_prefix(tmp_path):
    path = workbook(tmp_path / 'range.xlsx', [('Main', 'visible', [HEADERS, VALUES, VALUES])])
    source_id = uuid4()
    storage = LocalStorage(tmp_path / 'storage')
    first = publish_raw_index(XLSXTable(path, source_id, sheet='Main', header_row=1, end_row=2), storage, tmp_path / 'one')
    second = publish_raw_index(XLSXTable(path, source_id, sheet='Main', header_row=1), storage, tmp_path / 'two')
    mapping = map_columns(HEADERS)['mapping']
    assert next(MappedSource(storage, first, source_id, mapping).records()).record_id == next(MappedSource(storage, second, source_id, mapping).records()).record_id
    table = XLSXTable(path, source_id, sheet='Main', header_row=1, limits=replace(ExcelLimits(), max_cells=12))
    assert len(list(table.records())) == 1
    assert table.summary['unknown_remainder'] and table.summary['records_count'] is None
    assert table.summary['file_errors'][0]['code'] == 'excel_cell_limit'


def test_content_addressed_original_without_extension_is_readable(tmp_path):
    path = workbook(tmp_path / 'source.xlsx', [('Main', 'visible', [HEADERS, VALUES])])
    hashed = tmp_path / ('a' * 64)
    path.rename(hashed)
    result = discover_xlsx(hashed)
    storage = LocalStorage(tmp_path / 'storage')
    key = publish_raw_index(XLSXTable(hashed, uuid4(), **result['candidates'][0]['reader']), storage, tmp_path / 'raw')
    assert raw_page(storage, key)['items'][0]['cells'] == VALUES


def test_scientific_saved_xml_number_is_diagnosed_even_with_general_format(tmp_path):
    row = [VALUES[0], '<c r="{coord}"><v>7.9001234567e10</v></c>', *VALUES[2:]]
    path = workbook(tmp_path / 'scientific.xlsx', [('Main', 'visible', [HEADERS, row])])
    record = list(XLSXTable(path, uuid4(), sheet='Main', header_row=1).records())[0]
    assert record['cells'][1] == VALUES[1]
    assert record['cell_metadata'][1]['stored_numeric_text'] == '7.9001234567e10'
    assert record['issues'][0]['code'] == 'excel_scientific_notation'


def biff8_ole(path, *, numeric_inn=None):
    """Minimal genuine BIFF8 in OLE2, with Unicode strings and a regular FAT stream."""
    def record(code, data):
        return struct.pack('<HH', code, len(data)) + data
    def bof(kind):
        return record(0x0809, struct.pack('<HHHHII', 0x0600, kind, 0x0DBB, 1997, 0, 0))
    strings = HEADERS + VALUES
    sst = struct.pack('<II', len(strings), len(strings)) + b''.join(struct.pack('<HB', len(s), 1) + s.encode('utf-16le') for s in strings)
    xf = struct.pack('<HH', 0, 11 if numeric_inn is not None else 0) + bytes(16)
    prefix = bof(5) + record(0x0042, struct.pack('<H', 1200)) + record(0x00E0, xf) + record(0x00FC, sst)
    bounds = record(0x0085, struct.pack('<IBBB', len(prefix) + 16 + 4, 0, 0, 4) + b'\x00Main')
    globals_ = prefix + bounds + record(0x000A, b'')
    sheet = bof(0x10) + record(0x0200, struct.pack('<IIHHH', 0, 2, 0, 6, 0))
    for index in range(12):
        if index == 6 and numeric_inn is not None:
            sheet += record(0x0203, struct.pack('<HHHd', 1, 0, 0, numeric_inn))
        else:
            sheet += record(0x00FD, struct.pack('<HHHI', index // 6, index % 6, 0, index))
    stream = (globals_ + sheet + record(0x000A, b'')).ljust(4096, b'\x00')
    header = bytearray(512)
    header[:8] = bytes.fromhex('d0cf11e0a1b11ae1')
    struct.pack_into('<HHHH', header, 24, 0x003E, 3, 0xFFFE, 9)
    struct.pack_into('<H', header, 32, 6)
    struct.pack_into('<IIIIIIIII', header, 40, 0, 1, 8, 0, 4096, 0xFFFFFFFE, 0, 0xFFFFFFFE, 0)
    struct.pack_into('<109I', header, 76, 9, *([0xFFFFFFFF] * 108))
    def directory(name, kind, start, size, child=0xFFFFFFFF):
        entry = bytearray(128)
        encoded = (name + '\x00').encode('utf-16le')
        entry[:len(encoded)] = encoded
        struct.pack_into('<HBBIII', entry, 64, len(encoded), kind, 1, 0xFFFFFFFF, 0xFFFFFFFF, child)
        struct.pack_into('<IQ', entry, 116, start, size)
        return entry
    directory_stream = directory('Root Entry', 5, 0xFFFFFFFE, 0, 1) + directory('Workbook', 2, 0, 4096) + bytes(256)
    fat = struct.pack('<128I', *range(1, 8), 0xFFFFFFFE, 0xFFFFFFFE, 0xFFFFFFFD, *([0xFFFFFFFF] * 118))
    path.write_bytes(header + stream + directory_stream + fat)
    return path


def test_ole_biff8_unicode_values_match_xlsx(tmp_path):
    path = biff8_ole(tmp_path / 'biff8.xls')
    result = discover_xls(path)
    assert result['inventory'][0]['sheet'] == 'Main'
    table = XLSTable(path, uuid4(), **result['candidates'][0]['reader'])
    assert list(table.records())[0]['cells'] == VALUES


def test_xls_scientific_display_preserves_full_numeric_inn(tmp_path):
    from app.domain.canonical import build_dataset
    from app.domain.projections import verify_projections
    path = biff8_ole(tmp_path / 'numeric.xls', numeric_inn=123456789047)
    storage, source_id = LocalStorage(tmp_path / 'storage'), uuid4()
    key = publish_raw_index(XLSTable(path, source_id, sheet='Main', header_row=1), storage, tmp_path / 'raw')
    raw = raw_page(storage, key)['items'][0]
    assert raw['cell_metadata'][0]['number_format'] == '0.00E+00'
    parsed = MappedSource(storage, key, source_id, map_columns(HEADERS)['mapping'])
    dataset = build_dataset(path, None, source_id, tmp_path / 'dataset',
        {'id': 'hub-v1', 'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': 'hubRTK'}, parsed_source=parsed)
    assert verify_projections(dataset)['counts']['NUMBERS'] == 1
    assert dataset.page('NUMBERS')['items'][0]['INN'] == '123456789047'


def test_excel_uncertainty_can_be_corrected_through_the_common_pipeline(tmp_path):
    from app.domain.canonical import build_dataset
    from app.domain.serialization import write_csv
    values = ['1234567894', '001900', 'Тест', '<c r="{coord}" t="str"><f>"Test"</f></c>', '1', '0']
    path = workbook(tmp_path / 'input.xlsx', [('Main', 'visible', [HEADERS, values])])
    storage, source_id = LocalStorage(tmp_path / 'storage'), uuid4()
    key = publish_raw_index(XLSXTable(path, source_id, sheet='Main', header_row=1), storage, tmp_path / 'raw')
    parsed = MappedSource(storage, key, source_id, map_columns(HEADERS)['mapping'])
    row = next(parsed.records())
    profile = {'id': 'hub-v1', 'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': 'hubRTK'}
    blocked = build_dataset(path, None, source_id, tmp_path / 'blocked', profile, parsed_source=parsed)
    assert blocked.summary['blocking'] and blocked.summary['issue_counts']['excel_formula_cache_missing'] == 1
    correction = {'record_id': row.record_id, 'ordinal': row.ordinal, 'field': 'MAV_LABEL_LATIN',
                  'before': '', 'after': 'Test', 'mapping_digest': parsed.mapping_digest}
    fixed = build_dataset(path, None, source_id, tmp_path / 'fixed', profile,
                          parsed_source=parsed, correction_overlay=[correction])
    assert not fixed.summary['blocking'] and fixed.page('records')['items'][0]['raw_cells'][3] == ''
    result = write_csv(fixed, 'DOGTAGS', tmp_path / 'dogtags.csv')
    assert result.path.read_bytes() == ('INN;MAV_LABEL;MAV_LABEL_LATIN;IS_ACTIVE\r\n'
                                        '1234567894;Тест;Test;1\r\n').encode('cp1251')


def test_nonfinite_saved_number_remains_reviewable_json():
    import json
    from app.domain.readers.excel_values import cell_value
    metadata = {'type': 'number', 'cached_value': float('nan')}
    text, issues = cell_value(float('nan'), metadata)
    assert text == 'nan' and issues[0]['code'] == 'excel_numeric_precision'
    json.dumps(metadata, allow_nan=False)


def test_scientific_excel_display_uses_stored_inn_but_text_row_is_excluded(tmp_path):
    from openpyxl import Workbook
    from app.domain.canonical import build_dataset
    from app.domain.serialization import write_csv
    from app.domain.projections import verify_projections

    book = Workbook()
    sheet = book.active
    sheet.append(HEADERS)
    sheet.append([123456789047, '001900', 'Тест', 'Test', 1, 0])
    sheet['A2'].number_format = '0.00000E+00'
    sheet.append(['7,84201E+11', '002900', 'Ошибка', 'Error', 1, 0])
    path = tmp_path / 'display-and-text.xlsx'
    book.save(path)
    storage, source_id = LocalStorage(tmp_path / 'storage'), uuid4()
    key = publish_raw_index(XLSXTable(path, source_id, sheet=sheet.title, header_row=1), storage, tmp_path / 'raw')
    raw = raw_page(storage, key)['items']
    assert raw[0]['cell_metadata'][0]['stored_numeric_text'] == '123456789047'
    assert raw[0]['cell_metadata'][0]['number_format'] == '0.00000E+00'
    parsed = MappedSource(storage, key, source_id, map_columns(HEADERS)['mapping'])
    dataset = build_dataset(path, None, source_id, tmp_path / 'dataset',
        {'id': 'hub-v1', 'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': 'hubRTK'}, parsed_source=parsed)
    assert verify_projections(dataset)['counts'] == {'CLIENTS': 1, 'DOGTAGS': 1, 'NUMBERS': 1}
    assert [r['disposition'] for r in dataset.page('records')['items']] == ['included', 'excluded_scientific_inn']
    result = write_csv(dataset, 'DOGTAGS', tmp_path / 'dogtags.csv')
    assert result.path.read_bytes() == ('INN;MAV_LABEL;MAV_LABEL_LATIN;IS_ACTIVE\r\n'
                                      '123456789047;Тест;Test;1\r\n').encode('cp1251')
