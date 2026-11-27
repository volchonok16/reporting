import csv
from uuid import uuid4

from app.domain.canonical import build_dataset
from app.domain.error_exports import preview_diagnostics, error_description
from app.domain.output_spec import source_spec
from app.domain.projections import verify_projections
from app.domain.readers.base import MappedSource, publish_raw_index
from app.domain.readers.csv_reader import CSVTable
from app.domain.readers.mapping import map_columns
from app.domain.serialization import write_csv
from app.storage.local import LocalStorage, StagedObject
from app.storage.artifact_sets import PublishedArtifact
from app.storage.output_pages import publish_output_pages, preview_page, verify_output_pages


def test_error_export_keeps_source_order_extra_cells_and_only_current_errors(tmp_path):
    columns = ['Комментарий', 'IS_KSS', 'Номер телефона', 'MAV_LABEL_LATIN', 'ИНН', 'MAV_LABEL_NAME', 'IS_MAV']
    rows = [['без ошибки', '0', '0001', 'Test', '1234567894', 'Тест', '1'],
            ['исправлена', '0', '0002', 'Test', 'bad', 'Тест', '1'],
            ['осталась\nошибка', '0', '0003', 'Test', 'bad', 'Тест', '1']]
    path = tmp_path / 'source.csv'
    with path.open('w', encoding='utf-8', newline='') as stream:
        writer = csv.writer(stream, delimiter=';')
        writer.writerow(columns)
        writer.writerows(rows)
    source_id = uuid4()
    storage = LocalStorage(tmp_path / 'objects')
    key = publish_raw_index(CSVTable(path, source_id, encoding='utf-8', delimiter=';'), storage, tmp_path / 'raw')
    parsed = MappedSource(storage, key, source_id, map_columns(columns)['mapping'])
    record = list(parsed.records())[1]
    dataset = build_dataset(path, 'utf-8', source_id, tmp_path / 'dataset',
        {'id': 'hub-v1', 'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': 'hubRTK'}, parsed_source=parsed,
        settings={'operation': 'ADD', 'row_error_policy': 'separate-source-errors-v1', 'output_spec': source_spec()},
        correction_overlay=[{'record_id': record.record_id, 'ordinal': 2, 'field': 'INN',
            'before': 'bad', 'after': '1234567894', 'mapping_digest': parsed.mapping_digest}])
    assert verify_projections(dataset)['counts']['ERRORS'] == 1
    obj = write_csv(dataset, 'ERRORS', tmp_path / 'errors.csv')
    diagnostics = list(preview_diagnostics(dataset))
    description = error_description(diagnostics[0]['error_messages'])
    assert description.startswith('ИНН: ')
    assert obj.path.read_bytes().startswith(b'\xef\xbb\xbf')
    assert obj.path.read_bytes().count(b'\xef\xbb\xbf') == 1
    with obj.path.open(encoding='utf-8-sig', newline='') as stream:
        assert list(csv.reader(stream, delimiter=';')) == [[*columns, 'Ошибка'], [*rows[2], description]]
    assert diagnostics[0]['error_fields'] == 'ИНН'
    descriptors = publish_output_pages([obj], tmp_path, storage, 'ADD', dataset=dataset)
    page = preview_page(storage, descriptors['ERRORS'], 'ERRORS')
    assert page['items'][0]['values'] == [*rows[2], description]
    assert page['items'][0]['diagnostics']['source_row'] == '3'
    stored = PublishedArtifact(obj.role, obj.download_filename, obj.sha256, obj.size_bytes,
        storage.publish(StagedObject(obj.path, obj.sha256, obj.size_bytes)), obj.row_count)
    verify_output_pages(storage, descriptors['ERRORS'], stored, 'ADD', error_source=dataset.summary['error_source'])
    # Previously saved layouts retain their original verified CSV shape.
    dataset.summary['error_source'].pop('diagnostic_column')
    dataset.summary['error_source'].pop('utf8_bom')
    legacy = write_csv(dataset, 'ERRORS', tmp_path / 'legacy-errors.csv')
    assert not legacy.path.read_bytes().startswith(b'\xef\xbb\xbf')
    with legacy.path.open(encoding='utf-8', newline='') as stream:
        assert list(csv.reader(stream, delimiter=';')) == [columns, rows[2]]
