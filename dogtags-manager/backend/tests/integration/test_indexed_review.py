"""Real API corrections and page integrity over the same raw index used by processing."""
import hashlib
from uuid import UUID, uuid4

from app.domain.canonical import build_dataset, publish_dataset, read_dataset_index
from app.domain.readers.base import MappedSource, publish_raw_index
from app.domain.readers.csv_reader import CSVTable
from app.domain.readers.mapping import map_columns
from app.domain.manifest import capture_filename_components
from app.models import (Case, Intake, IntakeAssessment, IntakeVersion, ProcessingRevision,
                        ProcessingRun, SourceAsset)
from app.storage.local import StagedObject
from conftest import new_case


def setup_indexed(backend, tmp_path):
    client = backend.client()
    case_id, source_id, revision_id = UUID(new_case(client)), uuid4(), uuid4()
    data = ('MSISDN;MAV_LABEL_LATIN;INN;IS_KSS;MAV_LABEL_NAME;IS_MAV;EXTRA\n'
            '001900;Test;1234567894;0;Тест;1;keep\n').encode()
    path = tmp_path / 'source.csv'
    path.write_bytes(data)
    storage = backend.app.state.storage
    digest = hashlib.sha256(data).hexdigest()
    raw_key = storage.publish(StagedObject(path, digest, len(data)))
    index_key = publish_raw_index(CSVTable(path, source_id, encoding='utf-8', delimiter=';'),
                                  storage, tmp_path / 'index')
    mapping = map_columns(data.decode().splitlines()[0].split(';'))['mapping']
    with backend.app.state.sessions() as db:
        case = db.get(Case, case_id)
        source = SourceAsset(id=source_id, case_id=case_id, created_by=case.owner_id, filename='source.csv',
                             metadata_version=2, encoding=None, sha256=digest, size_bytes=len(data),
                             storage_key=raw_key, inspection={})
        db.add(source)
        db.flush()
        intake = Intake(case_id=case_id, source_asset_id=source_id)
        db.add(intake)
        db.flush()
        version = IntakeVersion(case_id=case_id, intake_id=intake.id, source_asset_id=source_id,
                                sequence=1, created_by=case.owner_id, decisions={})
        db.add(version)
        db.flush()
        assessment = IntakeAssessment(case_id=case_id, intake_id=intake.id, source_asset_id=source_id,
                                      intake_version_id=version.id, reader_version='csv-table-v2',
                                      result={'raw_index_key': index_key, 'mapping': mapping}, questions=[])
        db.add(assessment)
        db.flush()
        revision = ProcessingRevision(id=revision_id, case_id=case_id, source_asset_id=source_id,
            assessment_id=assessment.id, sequence=1, created_by=case.owner_id,
            profile_version_id='11111111-1111-4111-8111-111111111111',
            profile_snapshot={'id': 'hub-v1', 'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': 'hubRTK'},
            config_hash='a' * 64, export_timezone='Europe/Moscow',
            filename_components=capture_filename_components(case_id, revision_id, 1, 'source.csv'))
        db.add(revision)
        db.flush()
        case.head_revision_id = revision.id
        db.commit()
    return client, case_id, source_id, revision_id, index_key, mapping


def test_indexed_draft_correction_preserves_original_order_extras_and_mapping(backend, tmp_path):
    client, case, source, revision, key, mapping = setup_indexed(backend, tmp_path)
    url = f'/api/cases/{case}/revisions/{revision}'
    response = client.get(url + '/records')
    assert response.status_code == 200
    original = response.json()['items'][0]
    assert original['effective']['INN'] == '1234567894'
    assert original['raw_cells'][6] == 'keep'
    body = {'operation_id': str(uuid4()), 'expected_revision_id': str(revision),
            'source_asset_id': str(source), 'corrections': [{'record_id': original['record_id'],
            'ordinal': 1, 'field': 'MSISDN', 'before': '001900', 'after': '002900', 'reason': 'Synthetic correction'}]}
    saved = client.post(f'/api/cases/{case}/revisions', json=body)
    assert saved.status_code == 200
    newer = saved.json()['result']['revision']
    assert newer['assessment_id'] is not None
    changed = client.get(f"/api/cases/{case}/revisions/{newer['id']}/records").json()['items'][0]
    assert changed['raw_cells'] == original['raw_cells']
    assert changed['effective']['MSISDN'] == '002900'
    assert changed['record_id'] == original['record_id']
    parsed = MappedSource(backend.app.state.storage, key, source, mapping)
    result = build_dataset(tmp_path / 'source.csv', None, source, tmp_path / 'dataset',
                           {'id': 'hub-v1', 'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': 'hubRTK'},
                           parsed_source=parsed, correction_overlay=newer['correction_overlay'])
    assert result.summary['counts']['NUMBERS'] == 1
    assert result.page('NUMBERS')['items'][0]['MSISDN'] == '002900'
    assert result.page('records')['items'][0]['raw_cells'][0] == '001900'
    # Same ordinal with a different coordinate is not a valid row identity.
    wrong = client.get(url + f'/records/{uuid4()}?ordinal=1')
    assert wrong.status_code == 404


def test_completed_preview_reads_verified_fragments_and_rejects_corruption(backend, tmp_path, monkeypatch):
    client, case, source, revision, key, mapping = setup_indexed(backend, tmp_path)
    storage = backend.app.state.storage
    result = build_dataset(tmp_path / 'source.csv', None, source, tmp_path / 'dataset',
                           {'id': 'hub-v1', 'SPREADING': '0', 'INTERNAL_OPERATOR_NAME': 'hubRTK'},
                           parsed_source=MappedSource(storage, key, source, mapping))
    dataset_key = publish_dataset(result, storage)
    with backend.app.state.sessions() as db:
        db.add(ProcessingRun(case_id=case, revision_id=revision, work_identity=uuid4().hex,
                             state='BLOCKED', dataset_key=dataset_key, summary=result.summary))
        db.commit()
    index = read_dataset_index(storage, dataset_key)
    original_verify = storage.verify
    def verify(key, digest, size):
        assert key != index['objects']['records']['key'], 'Preview scanned full Parquet'
        return original_verify(key, digest, size)
    monkeypatch.setattr(storage, 'verify', verify)
    url = f'/api/cases/{case}/revisions/{revision}/records'
    response = client.get(url)
    assert response.status_code == 200 and response.json()['items'][0]['raw_cells'][-1] == 'keep'
    storage.path_for_key(index['pages']['records']['key']).write_bytes(b'{}')
    assert client.get(url).status_code == 503


def test_worker_builds_exact_outputs_from_the_saved_mapping(backend, tmp_path):
    from app.processing.dispatcher import dispatch_once
    from processing_helpers import read_run, runtime, wait_for, worker
    client, case, _, revision, _, _ = setup_indexed(backend, tmp_path)
    response = client.post(f'/api/cases/{case}/processing/start', json={
        'operation_id': str(uuid4()), 'expected_revision_id': str(revision)})
    assert response.status_code == 200
    job_id = UUID(response.json()['result']['job']['id'])
    with runtime(backend, tmp_path) as settings, worker(backend, settings, tmp_path / 'worker'):
        dispatch_once(backend.app.state.sessions, settings)
        run = wait_for(lambda: (r if (r := read_run(backend, job_id)).state in ('PREPARED', 'FAILED', 'BLOCKED') else None))
        assert run.state == 'PREPARED', run.error
    response = client.get(f'/api/cases/{case}/revisions/{revision}/artifacts')
    assert response.status_code == 200
    assert {a['role'] for a in response.json()['artifacts']} == {'CLIENTS', 'DOGTAGS', 'NUMBERS', 'ZIP'}
    records = client.get(f'/api/cases/{case}/revisions/{revision}/records').json()['items']
    assert records[0]['effective']['MSISDN'] == '001900' and records[0]['raw_cells'][-1] == 'keep'
