from uuid import uuid4

import pytest

from app.domain.canonical import build_dataset
from app.domain.projections import verify_projections
from app.domain.readers.base import MappedSource, publish_raw_index
from app.domain.readers.csv_reader import CSVTable
from app.domain.readers.mapping import map_columns
from app.domain.readers.xlsx_reader import XLSXTable
from app.storage.local import LocalStorage
from test_lineage import dataset, ROW


def test_distinct_label_pairs_and_case_variants_preserve_every_label(tmp_path):
    first = [*ROW[:3], 'OOO TsS ASTREYa: meditsina', *ROW[4:]]
    second = [*first[:3], 'OOO TSS ASTREYA: meditsina', *first[4:]]
    other = [first[0], '900', 'Другая этикетка', 'Another label', *first[4:]]
    _, result = dataset(tmp_path, [first, second, other, first])
    assert not result.summary['blocking']
    assert verify_projections(result)['counts'] == {'CLIENTS': 1, 'DOGTAGS': 3, 'NUMBERS': 2}
    records = result.page('records')['items']
    assert [r['disposition'] for r in records] == ['included', 'included', 'included', 'exact_duplicate']
    issues = result.page('issues')['items']
    assert {i['ordinal'] for i in issues} == {1, 2, 4}
    assert all(i['scope'] == 'warning' and i['code'] == 'label_case_variant' for i in issues)
    assert 'TsS ASTREYa' in issues[0]['message'] and 'TSS ASTREYA' in issues[0]['message']
    lineage = result.page('lineage')['items']
    assert lineage[0]['number_record_id'] == lineage[1]['number_record_id'] == lineage[3]['number_record_id']


@pytest.mark.parametrize('format_', ['csv', 'xlsx'])
def test_cells_outside_headers_are_ignored_before_validation(tmp_path, format_):
    headers = ['INN', 'MSISDN', 'MAV_LABEL_NAME', 'MAV_LABEL_LATIN', 'IS_MAV', 'IS_KSS']
    path = tmp_path / f'source.{format_}'
    source_id = uuid4()
    if format_ == 'csv':
        path.write_text(';'.join(headers) + '\n' + ';'.join([*ROW, 'ignore']) + '\n;;;;;;trash\n')
        table = CSVTable(path, source_id, encoding='utf-8', delimiter=';')
    else:
        from openpyxl import Workbook
        book = Workbook()
        book.active.append(headers)
        book.active.append([*ROW, '#VALUE!'])
        book.active.append(['', '', '', '', '', '', 'trash'])
        book.save(path)
        table = XLSXTable(path, source_id, sheet='Sheet', header_row=1)
    storage = LocalStorage(tmp_path / 'objects')
    key = publish_raw_index(table, storage, tmp_path / 'raw')
    parsed = MappedSource(storage, key, source_id, map_columns(headers)['mapping'])
    result = build_dataset(path, 'utf-8', source_id, tmp_path / 'dataset',
        {'id': 'hub-v1', 'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': 'hubRTK'}, parsed_source=parsed)
    assert verify_projections(result)['counts'] == {'CLIENTS': 1, 'DOGTAGS': 1, 'NUMBERS': 1}
    assert result.summary['skipped_empty_rows'] == 1
    assert result.summary['ignored_extra_cells'] == 2
    assert result.page('records')['items'][0]['raw_cells'] == ROW
    assert not result.page('issues')['items']
