"""New-source separation never changes legacy release policy or import templates."""
import csv
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pyarrow.parquet as pq
import pytest

from app.domain.manifest import capture_filename_components, export_filename
from app.domain.output_spec import source_spec
from app.domain.projections import ProjectionFailure, projection_rows, verify_projections
from app.domain.serialization import write_csv
from test_projections import ROWS, make_dataset


def settings(operation='ADD'):
    return {'operation': operation, 'row_error_policy': 'separate-source-errors-v1',
            'filename_policy': 'short-output-v1', 'output_spec': source_spec(operation)}


def test_new_source_separates_invalid_record_once_and_preserves_all_source_coverage(tmp_path):
    bad = ['bad', '009900', 'Latin', 'Кириллица', 'wrong', '0']
    dataset = make_dataset(tmp_path / 'source', [ROWS[0], bad], settings=settings())
    assert dataset.summary['blocking'] is False
    assert verify_projections(dataset)['counts'] == {'CLIENTS': 1, 'DOGTAGS': 1, 'NUMBERS': 1, 'ERRORS': 1}
    errors = list(projection_rows(dataset, 'ERRORS'))
    assert len(errors) == 1
    obj = write_csv(dataset, 'ERRORS', tmp_path / 'errors.csv')
    with obj.path.open(encoding='utf-8', newline='') as stream:
        rows = list(csv.DictReader(stream, delimiter=';'))
    assert rows[0]['SOURCE_ROW'] == '2'
    assert rows[0]['INN'] == 'bad'
    assert set(rows[0]['ERROR_FIELDS'].split('; ')) == {'INN', 'MAV_LABEL_LATIN', 'IS_MAV'}
    assert 'ИНН' in rows[0]['ERROR_MESSAGES']
    assert dataset.summary['reconciliation']['complete'] is True


def test_error_only_source_has_no_empty_import_artifacts_and_report_coverage_is_verified(tmp_path):
    dataset = make_dataset(tmp_path / 'source', [['bad', '001900', 'Тест', 'Test', '1', '1']], settings=settings())
    assert dataset.summary['blocking'] is False
    assert verify_projections(dataset)['counts'] == {'ERRORS': 1}
    path = dataset.directory / 'errors.parquet'
    table = pq.read_table(path)
    pq.write_table(table.slice(0, 0), path)
    with pytest.raises(ProjectionFailure):
        verify_projections(dataset)


def test_unversioned_source_keeps_strict_row_errors_and_incomplete_sources_remain_blocked(tmp_path):
    bad = ['bad', '001900', 'Тест', 'Test', '1', '1']
    assert make_dataset(tmp_path / 'old', [bad]).summary['blocking'] is True
    malformed = [*ROWS[0], 'extra']
    dataset = make_dataset(tmp_path / 'damaged', [ROWS[0], malformed], settings=settings())
    assert dataset.summary['blocking'] is True


@pytest.mark.parametrize('partner', ['RTK-HUB', 'RTK-ABC', 'RTK-MVNO'])
def test_short_filename_uses_frozen_formation_date_not_upload_or_download_date(partner):
    revision = SimpleNamespace(settings=settings(),
        export_timestamp=datetime(2026, 10, 10, tzinfo=timezone.utc), export_timezone='Europe/Moscow',
        filename_components=capture_filename_components(uuid4(), uuid4(), 1, 'source.xlsx'))
    revision.filename_components['partner'] = partner
    formed = datetime(2026, 10, 12, 21, 5, tzinfo=timezone.utc)
    assert export_filename(revision, 'NUMBERS', formed_at=formed) == partner.replace('-', '_') + '_NUMBERS_13.10.26.csv'
    assert export_filename(revision, 'ERRORS', formed_at=formed) == partner.replace('-', '_') + '_SOURCE_ERRORS_13.10.26.csv'
    assert export_filename(revision, 'ZIP', formed_at=formed) == partner.replace('-', '_') + '_FILES_13.10.26.zip'


def test_publication_freezes_short_bundle_names_and_report_bytes(tmp_path, monkeypatch):
    from app.storage.artifact_sets import publish_artifact_bundle, verify_bundle
    from app.storage.local import LocalStorage
    import app.storage.artifact_sets as publication
    dataset = make_dataset(tmp_path / 'source', [ROWS[0], ['bad', '002900', 'Тест', 'Test', '1', '1']], settings=settings())
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 10, 12, 21, 5, tzinfo=timezone.utc)
    monkeypatch.setattr(publication, 'utcnow', lambda: Clock.now(timezone.utc))
    source = SimpleNamespace(id=dataset.summary['source_asset_id'], sha256='a' * 64, size_bytes=50, encoding='utf-8')
    revision = SimpleNamespace(id=uuid4(), source_asset_id=source.id, settings=settings(), config_hash='b' * 64,
        rules_version='hub-rules-v1', serializer_version='cp1251-crlf-v1',
        export_timestamp=datetime(2026, 10, 10, tzinfo=timezone.utc), export_timezone='Europe/Moscow',
        filename_components=capture_filename_components(uuid4(), uuid4(), 1, 'source.csv'))
    storage = LocalStorage(tmp_path / 'store')
    bundle = publish_artifact_bundle(dataset, revision, source, storage, tmp_path / 'exports')
    assert bundle.manifest['naming']['formed_on'] == '2026-10-13'
    assert [obj.download_filename for obj in bundle.artifacts] == [
        f'RTK_HUB_{role}_13.10.26.csv' for role in ('CLIENTS', 'DOGTAGS', 'NUMBERS', 'SOURCE_ERRORS')
    ] + ['RTK_HUB_FILES_13.10.26.zip']
    revision.export_timestamp = datetime(2026, 10, 20, tzinfo=timezone.utc)
    verify_bundle(bundle, storage)
    assert bundle.artifacts[0].download_filename == 'RTK_HUB_CLIENTS_13.10.26.csv'


def test_delete_and_encoding_errors_go_only_to_the_separate_report(tmp_path):
    from app.domain.delete import build_delete_dataset
    from app.domain.readers.base import MappedSource, publish_raw_index
    from app.domain.readers.csv_reader import CSVTable
    from app.storage.local import LocalStorage
    source_id = uuid4()
    path = tmp_path / 'source.csv'
    path.write_text('MSISDN\r\n001900\r\n""\r\n😀\r\n', encoding='utf-8', newline='')
    storage = LocalStorage(tmp_path / 'store')
    key = publish_raw_index(CSVTable(path, source_id, encoding='utf-8', delimiter=';'), storage,
                            tmp_path / 'raw', chunk_rows=1)
    parsed = MappedSource(storage, key, source_id, {'MSISDN': 0}, required=('MSISDN',))
    dataset = build_delete_dataset(path, 'utf-8', source_id, tmp_path / 'dataset', {},
                                  parsed_source=parsed, settings=settings('DELETE'))
    assert verify_projections(dataset)['counts'] == {'DELETE': 1, 'ERRORS': 1}
    assert list(projection_rows(dataset, 'DELETE')) == [['001900']]
    assert dataset.summary['reconciliation']['complete']
    obj = write_csv(dataset, 'ERRORS', tmp_path / 'errors.csv')
    assert '😀' in obj.path.read_text(encoding='utf-8')


def test_bad_row_does_not_poison_valid_same_inn_and_report_cells_cannot_be_forged(tmp_path):
    bad = [*ROWS[0]]
    bad[3] = 'Кириллица'
    dataset = make_dataset(tmp_path / 'source', [bad, ROWS[0]], settings=settings())
    assert verify_projections(dataset)['counts'] == {'CLIENTS': 1, 'DOGTAGS': 1, 'NUMBERS': 1, 'ERRORS': 1}
    path = dataset.directory / 'errors.parquet'
    table = pq.read_table(path)
    changed = table.to_pylist()
    changed[0]['ERROR_MESSAGES'] = 'False clean report'
    import pyarrow as pa
    pq.write_table(pa.Table.from_pylist(changed, schema=table.schema), path)
    with pytest.raises(ProjectionFailure):
        verify_projections(dataset)


def test_latin_in_general_label_is_notice_and_reaches_all_imports(tmp_path):
    row = ['7707083893', '79000000000', 'Тест Brand', 'Test Brand', '0', '1']
    dataset = make_dataset(tmp_path / 'latin-notice', [row], settings=settings())
    assert verify_projections(dataset)['counts'] == {'CLIENTS': 1, 'DOGTAGS': 1, 'NUMBERS': 1}
    assert dataset.summary['blocking'] is False
    assert next(projection_rows(dataset, 'DOGTAGS'))[1] == 'Тест Brand'
    assert next(projection_rows(dataset, 'NUMBERS'))[1] == 'Тест Brand'
    notices = [i for i in dataset.page('issues')['items'] if i['code'] == 'label_contains_latin']
    assert len(notices) == 1 and notices[0]['scope'] == 'warning'
