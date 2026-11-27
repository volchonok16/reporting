"""Corrected retries are observable through the existing API/worker/release pipeline."""
from uuid import UUID, uuid4

import pytest

from processing_helpers import runtime
from test_automatic_intake import DATA, drive, receive
from test_change_stages import prepared, approval
from test_external_evidence import attempt, drain, evidence
from test_return_evidence import status_rules, returned, correlate
from app.processing.tasks import process_run


def test_mixed_return_retry_selects_rejected_and_fences_download(backend, tmp_path):
    status_rules(backend)
    client = backend.client()
    two = DATA + DATA.splitlines(keepends=True)[1].replace(b'79000000000', b'79000000001')
    with runtime(backend, tmp_path) as settings:
        state, _, bundle = prepared(client, backend, settings, two)
        drain(client)
        for role in ('CLIENTS', 'DOGTAGS'):
            evidence(client, attempt(client, bundle, role), 'APPLIED')
        submission = attempt(client, bundle)
        data, rows = returned(client, submission, ['TEST_OK', 'TEST_NO'])
        intake = receive(client, data=data, partner=None).json()['result']['intake']['id']
        correlate(client, intake, submission)
        drive(backend, settings, intake)
        returned_state = client.get(f'/api/returns/{intake}').json()
        body = {'operation_id': str(uuid4()), 'assessment_id': returned_state['assessment']['id'],
                'expected_revision_id': state['revision']['id'],
                'expected_snapshot_version': returned_state['snapshot_version'], 'reason': 'Repeat rejected rows'}
        response = client.post(f'/api/returns/{intake}/retries', json=body)
        assert response.status_code == 200, response.text
        assert client.post(f'/api/returns/{intake}/retries', json=body).json() == response.json()
        result = response.json()['result']
        process_run(backend.app.state.sessions, UUID(result['job']['id']), settings)
        revision, case = result['revision']['id'], state['intake']['case_id']
        base = f'/api/cases/{case}/revisions/{revision}'
        retry = client.get(base + '/artifacts').json()
        job = client.get(f"/api/cases/{case}/processing/{result['job']['id']}").json()
        assert [a['role'] for a in retry['artifacts']] == ['NUMBERS', 'ZIP'], (retry, job)
        approval(client, case, revision, retry)
        download = base + f"/artifacts/{retry['artifacts'][0]['id']}/download"
        params = {'expected_revision_id': revision, 'manifest_hash': retry['manifest_hash']}
        csv = client.get(download, params=params)
        assert csv.status_code == 200, csv.text
        assert b'79000000000' in csv.content and b'79000000001' not in csv.content
        assert b'STATUS' not in csv.content and b'SERVICE_NOTE' not in csv.content
        evidence(client, submission, 'APPLIED', coverage='ROWS', export_row_ids=[rows[0]['id']])
        stale = client.get(download, params=params)
        assert stale.status_code == 409 and stale.json()['error']['code'] == 'evidence_snapshot_changed', stale.text


def setup_return(backend, settings, client, *, statuses=('TEST_NO',), data=DATA, indexed=True, role='NUMBERS'):
    from test_external_evidence import backfill
    state, base, bundle = prepared(client, backend, settings, data)
    if indexed:
        drain(client)
    submission = attempt(client, bundle, role)
    if not indexed:
        backfill(client, artifact_id=submission['artifact_id'])
    data, rows = returned(client, submission, statuses)
    intake = receive(client, data=data, partner=None).json()['result']['intake']['id']
    correlate(client, intake, submission)
    drive(backend, settings, intake)
    return state, base, bundle, submission, intake, rows


def launch_retry(client, intake, expected, **changes):
    result = client.get(f'/api/returns/{intake}').json()
    body = {'operation_id': str(uuid4()), 'assessment_id': result['assessment']['id'],
            'expected_revision_id': expected, 'expected_snapshot_version': result['snapshot_version'],
            'reason': 'Corrected external rejection', **changes}
    response = client.post(f'/api/returns/{intake}/retries', json=body)
    assert response.status_code == 200, response.text
    return response.json()['result']


def run_retry(backend, settings, client, result):
    process_run(backend.app.state.sessions, UUID(result['job']['id']), settings)
    case, revision = result['revision']['case_id'], result['revision']['id']
    base = f'/api/cases/{case}/revisions/{revision}'
    job = client.get(f"/api/cases/{case}/processing/{result['job']['id']}").json()
    return base, client.get(base + '/artifacts').json(), job


def correction(client, base, field, before, after, ordinal=1):
    row = client.get(base + f'/records?after={ordinal-1}&limit=1').json()['items'][0]
    return {'record_id': row['record_id'], 'ordinal': ordinal, 'field': field,
            'before': before, 'after': after, 'reason': 'Partner verified corrected value'}


def test_retry_own_backfill_does_not_invalidate_evidence_snapshot(backend, tmp_path):
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        state, _, _, _, intake, _ = setup_return(backend, settings, client, indexed=False)
        result = launch_retry(client, intake, state['revision']['id'])
        _, bundle, job = run_retry(backend, settings, client, result)
        assert job['state'] == 'PREPARED', job
        assert [a['role'] for a in bundle['artifacts']] == ['NUMBERS', 'ZIP']
        detail = client.get(f"/api/returns/{intake}/retries/{result['revision']['id']}").json()
        assert not detail['stale']
        assert detail['snapshot_version'] > detail['retry']['snapshot_version']
        approval(client, state['intake']['case_id'], result['revision']['id'], bundle)


@pytest.mark.parametrize('field,before,after,roles', [
    ('INN', '7707083893', '1234567894', ['CLIENTS', 'DOGTAGS', 'NUMBERS', 'ZIP']),
    ('MAV_LABEL_NAME', 'Тест', 'Новое', ['DOGTAGS', 'NUMBERS', 'ZIP']),
    ('MAV_LABEL_LATIN', 'Test', 'New', ['DOGTAGS', 'NUMBERS', 'ZIP']),
])
def test_corrected_dependency_versions_are_reissued(backend, tmp_path, field, before, after, roles):
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        state, base, _, _, intake, _ = setup_return(backend, settings, client)
        change = correction(client, base, field, before, after)
        result = launch_retry(client, intake, state['revision']['id'], corrections=[change])
        base, bundle, job = run_retry(backend, settings, client, result)
        assert job['state'] == 'PREPARED', job
        assert [a['role'] for a in bundle['artifacts']] == roles, bundle
        previews = {a['role']: client.get(base + f"/artifacts/{a['id']}/preview").json()['items']
                    for a in bundle['artifacts'] if a['role'] != 'ZIP'}
        assert after in previews['DOGTAGS'][0]
        assert bundle['manifest']['retry']['source_revision_id'] == state['revision']['id']
        approval(client, state['intake']['case_id'], result['revision']['id'], bundle)


@pytest.mark.parametrize('status', ['not a published status', 'TEST_OK'])
def test_unknown_excluded_success_needs_separate_reason_then_recompute(backend, tmp_path, status):
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        state, _, _, submission, intake, rows = setup_return(backend, settings, client, statuses=(status,))
        result = launch_retry(client, intake, state['revision']['id'])
        _, bundle, job = run_retry(backend, settings, client, result)
        assert job['state'] == 'BLOCKED' and not bundle['available'], job
        detail = client.get(f"/api/returns/{intake}/retries/{result['revision']['id']}").json()
        assert detail['items'][0]['selected'] is False
        extra = {}
        if status == 'TEST_OK':
            extra['success_reasons'] = {rows[0]['id']: 'External operator explicitly requested reimport'}
        else:
            evidence(client, submission, 'REJECTED')
        recomputed = launch_retry(client, intake, result['revision']['id'],
                                  retry_revision_id=result['revision']['id'], **extra)
        _, bundle, job = run_retry(backend, settings, client, recomputed)
        assert job['state'] == 'PREPARED', job
        assert [a['role'] for a in bundle['artifacts']] == ['NUMBERS', 'ZIP']


def test_successful_number_correction_requires_explicit_change(backend, tmp_path):
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        state, base, _, _, intake, rows = setup_return(backend, settings, client, statuses=('TEST_OK',))
        result = launch_retry(client, intake, state['revision']['id'],
            success_reasons={rows[0]['id']: 'Partner requested another submission'},
            corrections=[correction(client, base, 'INN', '7707083893', '1234567894')])
        _, bundle, job = run_retry(backend, settings, client, result)
        assert job['state'] == 'BLOCKED' and not bundle['available'], job
        assert 'retry_requires_change' in {d['code'] for d in job['summary']['retry_diagnostics']}


def test_new_evidence_before_publication_or_approval_fences_old_retry(backend, tmp_path, monkeypatch):
    import app.processing.tasks as tasks
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        state, _, _, submission, intake, _ = setup_return(backend, settings, client)
        result = launch_retry(client, intake, state['revision']['id'])
        original_finalize = tasks.finalize
        def publish_after_evidence(*args, **kwargs):
            evidence(client, submission, 'APPLIED')
            return original_finalize(*args, **kwargs)
        monkeypatch.setattr(tasks, 'finalize', publish_after_evidence)
        _, bundle, job = run_retry(backend, settings, client, result)
        assert job['state'] == 'BLOCKED' and job['error']['code'] == 'evidence_snapshot_changed', job
        assert not bundle['available']
        monkeypatch.setattr(tasks, 'finalize', original_finalize)
        # A separate unchanged rejection produces a second prepared retry for approval admission.
        state, _, _, submission, intake, _ = setup_return(backend, settings, client,
            data=DATA.replace(b'79000000000', b'79000000002'))
        result = launch_retry(client, intake, state['revision']['id'])
        _, bundle, job = run_retry(backend, settings, client, result)
        assert job['state'] == 'PREPARED', job
        evidence(client, submission, 'APPLIED')
        response = client.post(f"/api/cases/{state['intake']['case_id']}/approval", json={
            'operation_id': str(uuid4()), 'expected_revision_id': result['revision']['id'],
            'manifest_hash': bundle['manifest_hash']})
        assert response.status_code == 409 and response.json()['error']['code'] == 'evidence_snapshot_changed'


def test_historical_retry_preserves_pinned_overlay_not_new_head(backend, tmp_path):
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        state, base, original, _, intake, _ = setup_return(backend, settings, client)
        changed = client.post(f"/api/cases/{state['intake']['case_id']}/revisions", json={
            'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
            'source_asset_id': state['revision']['source']['id'],
            'corrections': [correction(client, base, 'MSISDN', '79000000000', '79000000009')]})
        assert changed.status_code == 200, changed.text
        head = changed.json()['result']['revision']['id']
        result = launch_retry(client, intake, head)
        base, bundle, job = run_retry(backend, settings, client, result)
        assert job['state'] == 'PREPARED', job
        numbers = next(a for a in bundle['artifacts'] if a['role'] == 'NUMBERS')
        preview = client.get(base + f"/artifacts/{numbers['id']}/preview").json()['items']
        assert preview[0][2] == '79000000000'
        assert result['revision']['parent_revision_id'] == state['revision']['id']
        assert bundle['manifest']['source'] == original['manifest']['source']
        assert backend.client('other').post(f'/api/returns/{intake}/retries', json={
            'operation_id': str(uuid4()), 'assessment_id': client.get(f'/api/returns/{intake}').json()['assessment']['id'],
            'expected_revision_id': result['revision']['id'], 'expected_snapshot_version': 0,
            'reason': 'foreign attempt'}).status_code == 404


@pytest.mark.parametrize('action', ['approval', 'download'])
def test_retry_release_waits_for_owner_before_case_without_deadlock(backend, tmp_path, action):
    from concurrent.futures import ThreadPoolExecutor
    import time
    from sqlalchemy import select, text
    from app.domain.registry import owner_lock
    from app.models import Case
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        state, _, _, _, intake, _ = setup_return(backend, settings, client)
        result = launch_retry(client, intake, state['revision']['id'])
        base, bundle, job = run_retry(backend, settings, client, result)
        assert job['state'] == 'PREPARED', job
        case, revision = result['revision']['case_id'], result['revision']['id']
        if action == 'download':
            approval(client, case, revision, bundle)
        with ThreadPoolExecutor(max_workers=1) as pool, backend.app.state.sessions() as writer:
            owner = writer.get(Case, UUID(case)).owner_id
            owner_lock(writer, owner)
            pid = writer.scalar(text('SELECT pg_backend_pid()'))
            if action == 'approval':
                future = pool.submit(client.post, f'/api/cases/{case}/approval', json={
                    'operation_id': str(uuid4()), 'expected_revision_id': revision,
                    'manifest_hash': bundle['manifest_hash']})
            else:
                future = pool.submit(client.get, base + f"/artifacts/{bundle['artifacts'][0]['id']}/download",
                    params={'expected_revision_id': revision, 'manifest_hash': bundle['manifest_hash']})
            deadline = time.monotonic() + 5
            with backend.app.state.sessions() as observer:
                while not observer.scalar(text('SELECT EXISTS (SELECT 1 FROM pg_stat_activity '
                    'WHERE :pid=ANY(pg_blocking_pids(pid)))'), {'pid': pid}):
                    assert time.monotonic() < deadline, 'Release did not wait for the evidence writer'
                    time.sleep(0.01)
            # This is U11's final owner -> Case fence. If release held Case before owner this fails NOWAIT.
            writer.execute(select(Case.id).where(Case.id == UUID(case)).with_for_update(nowait=True, key_share=True))
            writer.commit()
            response = future.result(timeout=5)
            assert response.status_code == 200, response.text


def test_retry_retains_conflicts_without_blind_repeat(backend, tmp_path):
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        state, _, _, submission, intake, _ = setup_return(backend, settings, client)
        evidence(client, submission, 'APPLIED')
        result = launch_retry(client, intake, state['revision']['id'])
        _, bundle, job = run_retry(backend, settings, client, result)
        assert job['state'] == 'BLOCKED' and not bundle['available'], job
        ledger = client.get(f"/api/returns/{intake}/retries/{result['revision']['id']}").json()['items']
        assert ledger[0]['state'] == 'CONFLICT' and ledger[0]['selected'] is False


@pytest.mark.parametrize('role', ['CLIENTS', 'DOGTAGS', 'DELETE'])
def test_retry_supports_single_returned_role(backend, tmp_path, role):
    status_rules(backend)
    client = backend.client()
    data = b'MSISDN\r\n79000000000\r\n79000000000\r\n' if role == 'DELETE' else DATA
    with runtime(backend, tmp_path) as settings:
        state, _, _, _, intake, _ = setup_return(backend, settings, client, data=data, role=role)
        result = launch_retry(client, intake, state['revision']['id'])
        _, bundle, job = run_retry(backend, settings, client, result)
        assert job['state'] == 'PREPARED', job
        assert [a['role'] for a in bundle['artifacts']] == [role, 'ZIP'], bundle
        approval(client, state['intake']['case_id'], result['revision']['id'], bundle)


def test_retry_excludes_deletion_proved_successful_by_another_attempt(backend, tmp_path):
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        state, _, bundle, _, intake, rows = setup_return(backend, settings, client,
            data=b'MSISDN\r\n79000000000\r\n', role='DELETE')
        evidence(client, attempt(client, bundle, 'DELETE'), 'APPLIED')
        result = launch_retry(client, intake, state['revision']['id'])
        _, blocked, job = run_retry(backend, settings, client, result)
        assert job['state'] == 'BLOCKED' and not blocked['available'], job
        ledger = client.get(f"/api/returns/{intake}/retries/{result['revision']['id']}").json()['items']
        assert ledger[0]['state'] == 'APPLIED' and not ledger[0]['selected']
        repeated = launch_retry(client, intake, result['revision']['id'],
            retry_revision_id=result['revision']['id'],
            success_reasons={rows[0]['id']: 'Operator explicitly requested repeating the deletion'})
        base, released, job = run_retry(backend, settings, client, repeated)
        assert job['state'] == 'PREPARED', job
        artifact = next(a for a in released['artifacts'] if a['role'] == 'DELETE')
        assert client.get(base + f"/artifacts/{artifact['id']}/preview").json()['items'] == [['79000000000']]


def test_correcting_rejection_does_not_revalidate_excluded_success_as_input(backend, tmp_path):
    status_rules(backend)
    client = backend.client()
    two = DATA + DATA.splitlines(keepends=True)[1].replace(b'79000000000', b'79000000001')
    with runtime(backend, tmp_path) as settings:
        state, base, _, _, intake, _ = setup_return(backend, settings, client,
            data=two, statuses=('TEST_OK', 'TEST_NO'))
        result = launch_retry(client, intake, state['revision']['id'],
            corrections=[correction(client, base, 'MAV_LABEL_NAME', 'Тест', 'Новое')])
        base, bundle, job = run_retry(backend, settings, client, result)
        assert job['state'] == 'PREPARED', job
        assert [a['role'] for a in bundle['artifacts']] == ['DOGTAGS', 'NUMBERS', 'ZIP']
        records = client.get(base + '/records').json()['items']
        assert [r['disposition'] for r in records] == ['included', 'agreed_skip']
        detail = client.get(f"/api/returns/{intake}/retries/{result['revision']['id']}").json()
        assert detail['items'][0]['source_record_id'] == records[0]['record_id']
        history = client.get(f'/api/returns/{intake}/retries?limit=1').json()
        assert history['items'][0]['revision_id'] == result['revision']['id']
        target = client.get(f'/api/returns/{intake}').json()['retry_target']
        assert target['case_id'] == state['intake']['case_id']
        assert target['expected_revision_id'] == result['revision']['id']


def test_change_delete_retry_uses_old_stage_not_replacement_numbers(backend, tmp_path):
    from test_change_stages import change
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, old = prepared(client, backend, settings, b'MSISDN\r\n79000000005\r\n')
        state, _, _ = prepared(client, backend, settings, DATA)
        revision = change(client, state, old)
        drive(backend, settings, state['intake']['id'])
        base = f"/api/cases/{state['intake']['case_id']}/revisions/{revision}"
        bundle = client.get(base + '/artifacts').json()
        drain(client)
        submission = attempt(client, bundle, 'DELETE')
        data, rows = returned(client, submission, ['TEST_NO'])
        intake = receive(client, data=data, partner=None).json()['result']['intake']['id']
        correlate(client, intake, submission)
        drive(backend, settings, intake)
        result = launch_retry(client, intake, revision, corrections=[{
            'record_id': rows[0]['id'], 'ordinal': 1, 'field': 'MSISDN', 'before': '79000000005',
            'after': '79000000006', 'reason': 'Confirmed corrected deletion target'}])
        base, retry, job = run_retry(backend, settings, client, result)
        assert job['state'] == 'PREPARED', job
        assert [a['role'] for a in retry['artifacts']] == ['DELETE', 'ZIP']
        preview = client.get(base + f"/artifacts/{retry['artifacts'][0]['id']}/preview").json()['items']
        assert preview == [['79000000006']]
        detail = client.get(f"/api/returns/{intake}/retries/{result['revision']['id']}").json()
        assert detail['correction_scope'] == 'stage_export_rows'
        assert detail['items'][0]['source_record_id'] == rows[0]['id']
        approval(client, state['intake']['case_id'], result['revision']['id'], retry)
        repeated = attempt(client, retry, 'DELETE')
        assert submission['id'] in repeated['predecessor_ids']
        drain(client)
        returned_again, retry_rows = returned(client, repeated, ['TEST_NO'])
        next_intake = receive(client, data=returned_again, partner=None).json()['result']['intake']['id']
        correlate(client, next_intake, repeated)
        drive(backend, settings, next_intake)
        target = client.get(f'/api/returns/{next_intake}').json()['retry_target']
        assert target['correction_scope'] == 'stage_export_rows'
        next_result = launch_retry(client, next_intake, result['revision']['id'], corrections=[{
            'record_id': retry_rows[0]['id'], 'ordinal': 1, 'field': 'MSISDN', 'before': '79000000006',
            'after': '79000000007', 'reason': 'Partner corrected the returned deletion again'}])
        next_base, next_bundle, next_job = run_retry(backend, settings, client, next_result)
        assert next_job['state'] == 'PREPARED', next_job
        assert client.get(next_base + f"/artifacts/{next_bundle['artifacts'][0]['id']}/preview").json()['items'] == [['79000000007']]
        detail = client.get(f"/api/returns/{next_intake}/retries/{next_result['revision']['id']}").json()
        assert len(detail['retry']['stage_corrections']) == 1
        assert detail['items'][0]['source_record_id'] == retry_rows[0]['id']


@pytest.mark.parametrize('action', ['lookup', 'command'])
def test_retry_during_source_rediscovery_has_no_current_head(backend, tmp_path, action):
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        state, _, _, _, intake, _ = setup_return(backend, settings, client)
        return_state = client.get(f'/api/returns/{intake}').json()
        changed = client.post(f"/api/intakes/{state['intake']['id']}/decisions", json={
            'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'],
            'decisions': {'partner': 'RTK ABC', 'reason': 'Confirmed partner correction'}})
        assert changed.status_code == 200, changed.text
        assert client.get(f"/api/intakes/{state['intake']['id']}").json()['revision'] is None
        if action == 'lookup':
            response = client.get(f'/api/returns/{intake}')
            assert response.status_code == 200, response.text
            assert response.json()['retry_target']['expected_revision_id'] is None
        else:
            response = client.post(f'/api/returns/{intake}/retries', json={
                'operation_id': str(uuid4()), 'assessment_id': return_state['assessment']['id'],
                'expected_revision_id': state['revision']['id'],
                'expected_snapshot_version': return_state['snapshot_version'], 'reason': 'Retry while rediscovering'})
            assert response.status_code == 409, response.text
            assert response.json()['error']['code'] == 'revision_conflict'


@pytest.mark.parametrize('tamper', ['wanted_and_output', 'decision'])
def test_retry_verifier_rejects_missing_selection_lineage(backend, tmp_path, monkeypatch, tamper):
    import pyarrow.parquet as pq
    import app.processing.tasks as tasks
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        state, base, _, _, intake, _ = setup_return(backend, settings, client)
        result = launch_retry(client, intake, state['revision']['id'],
            corrections=[correction(client, base, 'INN', '7707083893', '1234567894')])
        original = tasks.publish_artifact_bundle
        def corrupt_selection(dataset, *args, **kwargs):
            names = ['retry_wanted_dogtags', 'dogtags'] if tamper == 'wanted_and_output' else ['retry_decisions']
            for name in names:
                path = dataset.directory / f'{name}.parquet'
                table = pq.read_table(path).slice(0, 0)
                pq.write_table(table, path)
            if tamper == 'wanted_and_output':
                dataset.summary['counts']['DOGTAGS'] = 0
            return original(dataset, *args, **kwargs)
        monkeypatch.setattr(tasks, 'publish_artifact_bundle', corrupt_selection)
        _, bundle, job = run_retry(backend, settings, client, result)
        assert job['state'] == 'BLOCKED' and not bundle['available'], job
        diagnostics = job['summary']['output_diagnostics']
        assert diagnostics[0]['code'] == 'projection_coverage'
        assert diagnostics[0]['reconciliation']['retry_lineage_errors'] > 0
