from zipfile import ZipFile
from uuid import uuid4

import pytest
from numbers_parser import Document

from app.domain.readers.containers import ExcelLimits, WorkbookError, detect_format
from app.domain.readers.numbers_reader import NumbersTable, discover_numbers


def test_identifies_numbers_by_content_without_extension(tmp_path):
    source = tmp_path / 'sha256-original'
    with ZipFile(source, 'w') as archive:
        archive.writestr('Index/Document.iwa', b'fixture')
        archive.writestr('Metadata/Properties.plist', b'fixture')
    assert detect_format(source) == 'numbers'


def workbook(tmp_path, *, second=False):
    path = tmp_path / 'source'  # Stored originals have content hashes, without extensions.
    document = Document(sheet_name='Данные', table_name='Номера', num_rows=5, num_cols=2)
    table = document.sheets[0].tables[0]
    for rn, row in enumerate([['Номер', 'Комментарий'], [74955475144, 'Не включать'],
                             ['79937967877', ''], ['7,84201E+11', 'Текст источника']]):
        for cn, value in enumerate(row):
            table.write(rn, cn, value)
    if second:
        other = document.sheets[0].add_table('Другие номера', num_rows=2, num_cols=1)
        other.write(0, 0, 'MSISDN')
        other.write(1, 0, '79937967878')
    document.save(path)
    return path


def test_numbers_tables_preserve_values_and_skip_empty_rows(tmp_path):
    path = workbook(tmp_path)
    found = discover_numbers(path, number_only=True)
    assert len(found['candidates']) == 1
    reader = NumbersTable(path, uuid4(), **{**found['candidates'][0]['reader'], 'end_row': None})
    rows = list(reader.records())
    assert [r['cells'][0] for r in rows] == ['74955475144', '79937967877', '7,84201E+11']
    assert rows[2]['issues'][0]['code'] == 'excel_scientific_notation'
    assert reader.summary['records_count'] == 3
    assert reader.summary['skipped_empty_rows'] == 1
    assert not reader.summary['unknown_remainder']


def test_numbers_keeps_multiple_tables_separate_and_selectable(tmp_path):
    path = workbook(tmp_path, second=True)
    found = discover_numbers(path, number_only=True)
    assert len(found['candidates']) == 2
    assert len({c['reader']['sheet'] for c in found['candidates']}) == 2
    reader = NumbersTable(path, uuid4(), **found['candidates'][1]['reader'])
    assert [r['cells'] for r in reader.records()] == [['79937967878']]


def test_numbers_resource_limits_and_corrupt_books_are_explicit(tmp_path):
    path = workbook(tmp_path)
    with pytest.raises(WorkbookError, match='excel_cell_limit'):
        discover_numbers(path, limits=ExcelLimits(max_cells=2))
    with pytest.raises(WorkbookError, match='excel_uncompressed_limit'):
        discover_numbers(path, limits=ExcelLimits(max_uncompressed_bytes=1))
    with ZipFile(path, 'w') as archive:
        archive.writestr('Index/Document.iwa', b'corrupt')
    with pytest.raises(WorkbookError, match='numbers_invalid_container'):
        discover_numbers(path)


def test_numbers_checks_nested_iwa_expansion_before_parsing(tmp_path):
    import snappy
    path = tmp_path / 'nested.numbers'
    chunk = snappy.compress(b'x' * 4000)
    with ZipFile(path, 'w') as archive:
        archive.writestr('Index/Document.iwa', b'\0' + len(chunk).to_bytes(3, 'little') + chunk)
    with pytest.raises(WorkbookError, match='excel_uncompressed_limit'):
        discover_numbers(path, limits=ExcelLimits(max_uncompressed_bytes=1000))
