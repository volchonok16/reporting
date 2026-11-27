from uuid import uuid4

from app.domain.ingress import source_record_id
from app.domain.projections import verify_projections
from test_projections import ROWS, make_dataset


def selection(source_id, ordinal):
    record_id = str(source_record_id(source_id, ordinal))
    return {record_id: {'record_id': record_id, 'ordinal': ordinal, 'excluded': True,
                        'source_asset_id': str(source_id), 'mapping_digest': None}}


def test_excluding_duplicate_representative_keeps_the_other_assignment(tmp_path):
    source_id = uuid4()
    dataset = make_dataset(tmp_path / 'duplicate', [ROWS[0], ROWS[0], ROWS[2]], source_id=source_id,
                           settings={'row_selections': selection(source_id, 1)})
    assert verify_projections(dataset)['counts'] == {'CLIENTS': 2, 'DOGTAGS': 2, 'NUMBERS': 2}
    rows = dataset.page('records')['items']
    assert [r['disposition'] for r in rows] == ['excluded_manual', 'included', 'included']
    assert rows[1]['representative_id'] == rows[1]['record_id']
    assert dataset.summary['reconciliation']['complete']
    assert len(dataset.page('raw')['items']) == len(dataset.page('lineage')['items']) == 3


def test_excluded_conflicting_or_invalid_row_does_not_block_valid_outputs(tmp_path):
    source_id = uuid4()
    conflict = [ROWS[0][0], ROWS[0][1], 'Другой', 'Other', '', '1']
    dataset = make_dataset(tmp_path / 'conflict', [ROWS[0], conflict], source_id=source_id,
                           settings={'row_selections': selection(source_id, 2)})
    assert verify_projections(dataset)['counts'] == {'CLIENTS': 1, 'DOGTAGS': 1, 'NUMBERS': 1}
    assert dataset.summary['issue_counts'] == {'flag_value': 1}
    assert dataset.page('records')['items'][1]['disposition'] == 'excluded_manual'


def test_delete_exclusion_preserves_duplicate_representative_and_raw_rows(tmp_path):
    from app.domain.delete import build_delete_dataset
    from app.domain.readers.base import MappedSource, publish_raw_index
    from app.domain.readers.csv_reader import CSVTable
    from app.storage.local import LocalStorage
    source_id = uuid4()
    path = tmp_path / 'delete.csv'
    path.write_text('MSISDN\n001900\n001900\n009900\n')
    storage = LocalStorage(tmp_path / 'objects')
    key = publish_raw_index(CSVTable(path, source_id, encoding='utf-8', delimiter=';'), storage,
                            tmp_path / 'raw', chunk_rows=1)
    parsed = MappedSource(storage, key, source_id, {'MSISDN': 0}, required=('MSISDN',))
    records = list(parsed.records())
    selected = {r.record_id: {'record_id': r.record_id, 'ordinal': r.ordinal, 'excluded': True,
        'source_asset_id': str(source_id), 'mapping_digest': parsed.mapping_digest} for r in (records[0], records[2])}
    dataset = build_delete_dataset(path, 'utf-8', source_id, tmp_path / 'dataset', {}, parsed_source=parsed,
                                   settings={'row_selections': selected})
    assert verify_projections(dataset)['counts'] == {'DELETE': 1}
    assert [r['disposition'] for r in dataset.page('records')['items']] == ['excluded_manual', 'included', 'excluded_manual']
    assert len(dataset.page('raw')['items']) == len(dataset.page('lineage')['items']) == 3
