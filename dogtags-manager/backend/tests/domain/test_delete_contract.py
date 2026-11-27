"""DELETE retains source identities and exact text while deduplicating only MSISDN."""
from uuid import uuid4

import pytest

from app.domain.readers.base import MappedSource, publish_raw_index
from app.domain.readers.csv_reader import CSVTable
from app.storage.local import LocalStorage


def dataset_for(tmp_path, values):
    from app.domain.delete import build_delete_dataset
    source_id = uuid4()
    path = tmp_path / 'source.csv'
    path.write_text('MSISDN\r\n' + ''.join(v + '\r\n' for v in values), newline='')
    storage = LocalStorage(tmp_path / 'objects')
    key = publish_raw_index(CSVTable(path, source_id, encoding='utf-8', delimiter=';'), storage,
                            tmp_path / 'raw', chunk_rows=1)
    parsed = MappedSource(storage, key, source_id, {'MSISDN': 0}, required=('MSISDN',))
    return build_delete_dataset(path, 'utf-8', source_id, tmp_path / 'dataset', {},
                                 parsed_source=parsed, chunk_rows=1)


def test_delete_exact_contract_duplicates_and_lineage(tmp_path):
    from app.domain.projections import verify_projections
    from app.domain.serialization import write_csv, write_zip
    dataset = dataset_for(tmp_path, ['79000001900', '79000001900', '79000002900'])
    assert verify_projections(dataset)['counts'] == {'DELETE': 2}
    assert dataset.summary['dispositions'] == {'included': 2, 'exact_duplicate': 1}
    records = dataset.page('records')['items']
    assert records[0]['record_id'] == records[1]['representative_id']
    assert records[1]['effective'] == {'MSISDN': '79000001900'}
    assert len(dataset.page('lineage')['items']) == 3
    obj = write_csv(dataset, 'DELETE', tmp_path / 'delete.csv')
    assert obj.path.read_bytes() == b'MSISDN\r\n79000001900\r\n79000002900\r\n'
    write_zip([obj], tmp_path / 'delete.zip', operation='DELETE')
    with pytest.raises(ValueError):
        write_zip([obj], tmp_path / 'wrong.zip', operation='ADD')


def test_delete_blank_row_is_not_a_record_or_error(tmp_path):
    from app.domain.projections import verify_projections
    dataset = dataset_for(tmp_path, ['79000001900', '""'])
    assert dataset.summary['blocking'] is False
    assert dataset.summary['issue_counts'] == {}
    assert verify_projections(dataset)['counts'] == {'DELETE': 1}


def test_delete_ten_digit_number_is_an_error_without_adding_prefix(tmp_path):
    dataset = dataset_for(tmp_path, ['9937967877'])
    assert dataset.summary['issue_counts']['msisdn_country_prefix'] == 1
    assert dataset.page('records')['items'][0]['effective']['MSISDN'] == '9937967877'


def bundle_for(tmp_path, values):
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from app.domain.manifest import capture_filename_components
    from app.domain.output_spec import output_spec
    from app.storage.artifact_sets import publish_artifact_bundle
    dataset = dataset_for(tmp_path, values)
    source = SimpleNamespace(id=dataset.summary['source_asset_id'], sha256='a' * 64, size_bytes=50, encoding='utf-8')
    revision_id, case_id = uuid4(), uuid4()
    revision = SimpleNamespace(id=revision_id, source_asset_id=source.id, config_hash='b' * 64,
        rules_version='hub-rules-v1', serializer_version='cp1251-crlf-v1',
        settings={'operation': 'DELETE', 'output_spec': output_spec('DELETE')},
        export_timestamp=datetime(2026, 10, 11, tzinfo=timezone.utc), export_timezone='UTC',
        filename_components=capture_filename_components(case_id, revision_id, 1, 'delete.csv'))
    revision.filename_components['operation'] = 'DELETE'
    storage = LocalStorage(tmp_path / 'objects')
    return publish_artifact_bundle(dataset, revision, source, storage, tmp_path / 'exports'), storage


def test_versioned_manifest_and_indexed_serialized_preview(tmp_path, monkeypatch):
    from app.storage.output_pages import preview_page
    from app.storage.artifact_sets import verify_bundle
    bundle, storage = bundle_for(tmp_path, [f'79{i:09}' for i in range(2100)])
    assert bundle.manifest['version'] == 'operation-artifact-manifest-v2'
    descriptor = bundle.manifest['previews']['DELETE']
    checked, original = [], storage.verify
    def counted(key, digest, size):
        checked.append(key)
        return original(key, digest, size)
    monkeypatch.setattr(storage, 'verify', counted)
    verify_bundle(bundle, storage, full=False)
    page = preview_page(storage, descriptor, 'DELETE', after=2050, limit=2)
    assert [r['values'] for r in page['items']] == [['79000002050'], ['79000002051']]
    assert len(checked) == 3  # Manifest, role index, one selected fragment; no whole CSV or ZIP hash.
    assert not set(checked) & {obj.storage_key for obj in bundle.artifacts}


@pytest.mark.parametrize('corruption', ['csv', 'preview', 'zip'])
def test_corrupt_bytes_never_pass_full_release_verification(tmp_path, corruption):
    import json
    from app.storage.artifact_sets import verify_bundle
    from app.storage.local import StorageFailure
    bundle, storage = bundle_for(tmp_path, ['79000001900'])
    if corruption == 'preview':
        descriptor = bundle.manifest['previews']['DELETE']
        index = json.loads(storage.path_for_key(descriptor['key']).read_bytes())
        key = index['chunks'][0]['key']
    else:
        key = bundle.artifacts[0 if corruption == 'csv' else -1].storage_key
    storage.path_for_key(key).write_bytes(b'corruption')
    with pytest.raises(StorageFailure):
        verify_bundle(bundle, storage)


@pytest.mark.parametrize('fault', ['role', 'encoding', 'zip_extra', 'zip_missing'])
def test_wrong_composition_or_encoding_rejected_even_with_matching_object_hashes(tmp_path, fault):
    from copy import deepcopy
    from dataclasses import replace
    from zipfile import ZipFile
    from app.domain.canonical import file_digest
    from app.domain.operations import canonical_digest
    from app.domain.manifest import canonical_manifest_bytes
    from app.storage.artifact_sets import verify_bundle
    from app.storage.local import StagedObject, StorageFailure
    bundle, storage = bundle_for(tmp_path, ['79000001900'])
    manifest, artifacts = deepcopy(bundle.manifest), list(bundle.artifacts)
    if fault == 'role':
        manifest['output_spec']['roles'] = ['NUMBERS']
    elif fault == 'encoding':
        manifest['output_spec']['serialization']['encoding'] = 'utf-8'
    else:
        path = tmp_path / 'bad.zip'
        with ZipFile(path, 'w') as archive:
            if fault == 'zip_extra':
                archive.writestr(artifacts[0].download_filename, b'MSISDN\r\n79000001900\r\n')
                archive.writestr('extra.csv', b'bad')
        digest, size = file_digest(path)
        key = storage.publish(StagedObject(path, digest, size))
        artifacts[-1] = replace(artifacts[-1], sha256=digest, size_bytes=size, storage_key=key)
        manifest['zip'].update(sha256=digest, size_bytes=size)
    digest = canonical_digest(manifest)
    path = tmp_path / 'bad-manifest.json'
    path.write_bytes(canonical_manifest_bytes(manifest))
    key = storage.publish(StagedObject(path, digest, path.stat().st_size))
    invalid = replace(bundle, manifest=manifest, manifest_hash=digest, manifest_key=key, artifacts=tuple(artifacts))
    with pytest.raises(StorageFailure):
        verify_bundle(invalid, storage)


def test_oversized_msisdn_is_rejected_without_truncating_source_evidence(tmp_path):
    value = '7' + '9' * (1024 * 1024 + 31)
    dataset = dataset_for(tmp_path, [value])
    assert dataset.summary['blocking']
    assert dataset.summary['counts']['DELETE'] == 0
    assert dataset.page('records')['items'][0]['raw_cells'] == [value]
    assert dataset.summary['issue_counts']['msisdn_format'] == 1
