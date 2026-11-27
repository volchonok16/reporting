"""STATUS returns use real persisted intake, immutable exports and DISCOVER workers."""
import csv
import io
from uuid import UUID, uuid4

import pytest

from sqlalchemy import select

from app.admin.publish_rules import publish_rules
from app.domain.rules import seed_config
from app.models import User
from processing_helpers import runtime
from test_automatic_intake import DATA, drive, receive
from test_change_stages import prepared
from test_external_evidence import attempt, drain


def status_rules(backend):
    with backend.app.state.sessions() as db:
        user = db.scalar(select(User).where(User.username == 'operator'))
        user.permissions = [*user.permissions, 'rules.publish']
        config = seed_config()
        config['version'] = 'synthetic-status-v1'
        config['statuses'] = [{'value': 'TEST_OK', 'classification': 'success'},
                              {'value': 'TEST_NO', 'classification': 'failure'}]
        config['examples'] = [{'kind': 'status', **r} for r in config['statuses']]
        publish_rules(db, user, config, reason='Synthetic STATUS fixtures only')
        db.commit()


def returned(client, submission, statuses):
    rows = client.get(f"/api/artifacts/{submission['artifact_id']}/export-rows").json()['items']
    stream = io.StringIO()
    fields = list(rows[0]['values'])
    writer = csv.writer(stream, delimiter=';')
    writer.writerow([*fields, 'STATUS', 'SERVICE_NOTE'])
    for row, status in zip(reversed(rows), statuses, strict=True):
        writer.writerow([*[row['values'][f] for f in fields], status, 'raw service evidence'])
    return ('\ufeff' + stream.getvalue()).encode(), rows


def correlate(client, intake_id, submission, reason='Operator confirmed exact submitted file'):
    state = client.get(f'/api/intakes/{intake_id}').json()
    body = {'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'],
            'decisions': {'operation': 'STATUS', 'return_attempt_id': submission['id'], 'reason': reason}}
    response = client.post(f'/api/intakes/{intake_id}/decisions', json=body)
    assert response.status_code == 200, response.text
    assert client.post(f'/api/intakes/{intake_id}/decisions', json=body).json() == response.json()
    return response


@pytest.mark.parametrize('role', ['CLIENTS', 'DOGTAGS', 'NUMBERS', 'DELETE'])
def test_status_reordered_exact_rows_publish_pinned_evidence(backend, tmp_path, role):
    status_rules(backend)
    client = backend.client()
    two = DATA + DATA.splitlines(keepends=True)[1].replace(b'79000000000', b'79000000001').replace(b'7707083893', b'1234567894')
    if role == 'DELETE':
        two = b'MSISDN\r\n79000000000\r\n79000000001\r\n'
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(client, backend, settings, two)
        drain(client)
        submission = attempt(client, bundle, role)
        data, rows = returned(client, submission, ['TEST_OK', 'TEST_NO'])
        intake_id = receive(client, data=data, partner=None).json()['result']['intake']['id']
        correlate(client, intake_id, submission)
        drive(backend, settings, intake_id)
    page = client.get(f'/api/returns/{intake_id}').json()
    assert page['assessment']['attempt_id'] == submission['id']
    assert page['assessment']['counts'] == {'APPLIED': 1, 'REJECTED': 1}
    matches = client.get(f'/api/returns/{intake_id}/rows').json()['items']
    assert [r['export_row_id'] for r in matches] == [r['id'] for r in reversed(rows)]
    assert [r['raw_status'] for r in matches] == ['TEST_OK', 'TEST_NO']
    assert all(r['rule_version'] == 'synthetic-status-v1' for r in matches)
    assert len(client.get(f"/api/external-attempts/{submission['id']}/evidence").json()['items']) == 2
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['revision'] is None and state['intake']['state'] == 'RECONCILED'
    assert not state['assessment']['questions']
    assert all('raw service evidence' in r['raw_cells'] for r in matches)
    assert client.get(f'/api/returns/{intake_id}/rows?limit=1').json()['next_cursor'] == 1
    assert backend.client('other').get(f'/api/returns/{intake_id}').status_code == 404


def rewrite_return(data, transform):
    reader = list(csv.reader(io.StringIO(data.decode('utf-8-sig')), delimiter=';'))
    stream = io.StringIO()
    writer = csv.writer(stream, delimiter=';')
    writer.writerows([reader[0], *transform(reader[0], reader[1:])])
    return ('\ufeff' + stream.getvalue()).encode()


@pytest.mark.parametrize('problem', ['unknown_missing_unmatched', 'contradictory_repeats', 'uncertain_cell'])
def test_uncertain_returns_never_assert_success(backend, tmp_path, problem):
    status_rules(backend)
    client = backend.client()
    two = DATA + DATA.splitlines(keepends=True)[1].replace(b'79000000000', b'79000000001')
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(client, backend, settings, two)
        drain(client)
        submission = attempt(client, bundle)
        data, _ = returned(client, submission, ['unknown partner phrase', 'TEST_OK'])
        if problem == 'unknown_missing_unmatched':
            def transform(header, rows):
                wrong = list(rows[1])
                wrong[header.index('MSISDN')] = '79999999999'
                return [rows[0], wrong]
            expected = {'UNKNOWN': 1, 'UNMATCHED': 1, 'MISSING': 1}
        elif problem == 'contradictory_repeats':
            def transform(header, rows):
                bad = list(rows[1])
                bad[header.index('STATUS')] = 'TEST_NO'
                return [rows[1], bad]
            expected = {'CONFLICT': 2, 'MISSING': 1}
        else:
            def transform(header, rows):
                return [rows[1][:-1]]  # A missing headed cell remains a structural error.
            expected = {'INVALID': 1, 'MISSING': 2}
        data = rewrite_return(data, transform)
        intake_id = receive(client, data=data, partner=None).json()['result']['intake']['id']
        correlate(client, intake_id, submission)
        drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['intake']['state'] == 'NEEDS_DECISION' and state['revision'] is None
    assert client.get(f'/api/returns/{intake_id}').json()['assessment']['counts'] == expected
    assert client.get(f"/api/external-attempts/{submission['id']}/evidence").json()['items'] == []
    rows = client.get(f'/api/returns/{intake_id}/rows').json()['items']
    assert all(r['attempt_state'] == 'UNKNOWN' for r in rows)


def test_empty_status_rules_and_unlinked_return_ask_one_specific_selection(backend, tmp_path):
    from test_automatic_intake import seed
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(client, backend, settings, DATA)
        drain(client)
        submission = attempt(client, bundle, 'CLIENTS')
        data, _ = returned(client, submission, ['TEST_OK'])
        intake_id = receive(client, data=data, partner=None).json()['result']['intake']['id']
        drive(backend, settings, intake_id)
        state = client.get(f'/api/intakes/{intake_id}').json()
        assert [q['code'] for q in state['assessment']['questions']] == ['return_correlation_required']
        correlate(client, intake_id, submission)
        drive(backend, settings, intake_id)
    assert client.get(f'/api/returns/{intake_id}').json()['assessment']['counts'] == {'UNKNOWN': 1}
    assert client.get(f"/api/external-attempts/{submission['id']}/evidence").json()['items'] == []


def test_reassessment_retracts_old_correlation_without_rewriting_history(backend, tmp_path):
    from test_external_evidence import evidence
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, first = prepared(client, backend, settings, DATA)
        _, _, second = prepared(client, backend, settings, DATA)
        drain(client)
        old, new = attempt(client, first, 'CLIENTS'), attempt(client, second, 'CLIENTS')
        data, _ = returned(client, old, ['TEST_OK'])
        intake_id = receive(client, data=data, partner=None).json()['result']['intake']['id']
        correlate(client, intake_id, old)
        drive(backend, settings, intake_id)
        initial = client.get(f'/api/returns/{intake_id}').json()['assessment']
        old_event = client.get(f"/api/external-attempts/{old['id']}/evidence").json()['items'][0]
        current = client.get(f'/api/intakes/{intake_id}').json()
        assert client.post(f'/api/intakes/{intake_id}/decisions', json={
            'operation_id': str(uuid4()), 'expected_version_id': current['version']['id'],
            'decisions': {'return_attempt_id': new['id']}}).status_code == 422
        evidence(client, new, 'REJECTED')
        correlate(client, intake_id, new, reason='Audit found the originally selected file was wrong')
        drive(backend, settings, intake_id)
    changed = client.get(f'/api/returns/{intake_id}').json()
    history = client.get(f'/api/returns/{intake_id}/assessments?limit=1').json()
    remaining = client.get(f"/api/returns/{intake_id}/assessments?after={history['next_cursor']}").json()
    assert {r['id'] for r in history['items'] + remaining['items']} == {initial['id'], changed['assessment']['id']}
    assert changed['assessment']['id'] != initial['id']
    assert changed['resolution']['previous_id'] == initial['id']
    assert changed['resolution']['replacement_id'] == changed['assessment']['id']
    assert client.get(f"/api/returns/{intake_id}?assessment_id={initial['id']}").json()['superseded_by'] == changed['resolution']
    assert client.get(f"/api/external-attempts/{old['id']}/evidence").json()['items'] == [old_event]
    assert client.get(f"/api/artifacts/{old['artifact_id']}/export-rows").json()['items'][0]['evidence_state'] == 'UNKNOWN'
    assert client.get(f'/api/returns/{intake_id}/rows').json()['items'][0]['attempt_state'] == 'CONFLICT'
    assert client.post('/api/registry/rebuild', json={'batch_size': 100}).status_code == 200
    assert client.get('/api/registry?kind=CLIENT').json()['items'][0]['external_state'] == 'CONFLICT'


def test_return_old_revision_never_moves_to_current_head_or_other_attempt(backend, tmp_path):
    from test_external_evidence import evidence
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        state, _, bundle = prepared(client, backend, settings, DATA)
        drain(client)
        old = attempt(client, bundle, 'CLIENTS')
        alternative = attempt(client, bundle, 'CLIENTS')
        evidence(client, alternative, 'REJECTED')
        data, _ = returned(client, old, ['unknown'])
        response = client.post(f"/api/intakes/{state['intake']['id']}/decisions", json={
            'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'],
            'decisions': {'partner': 'RTK ABC', 'reason': 'New requested export version'}})
        assert response.status_code == 200
        drive(backend, settings, state['intake']['id'])
        drive(backend, settings, state['intake']['id'])
        latest = client.get(f"/api/intakes/{state['intake']['id']}").json()
        assert latest['revision']['id'] != bundle['revision_id']
        intake_id = receive(client, data=data, partner=None).json()['result']['intake']['id']
        correlate(client, intake_id, old)
        drive(backend, settings, intake_id)
    result = client.get(f'/api/returns/{intake_id}').json()['assessment']
    assert result['artifact_id'] == old['artifact_id'] and result['attempt_id'] == old['id']
    row = client.get(f'/api/returns/{intake_id}/rows').json()['items'][0]
    assert row['classification'] == 'UNKNOWN' and row['attempt_state'] == 'UNKNOWN'


def test_attempt_switch_fences_delayed_discovery(backend, tmp_path):
    from app.processing.discovery import assess, finish_discovery
    from app.processing.leases import claim
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(client, backend, settings, DATA)
        drain(client)
        first, second = attempt(client, bundle, 'CLIENTS'), attempt(client, bundle, 'CLIENTS')
        data, _ = returned(client, first, ['TEST_OK'])
        intake_id = receive(client, data=data, partner=None).json()['result']['intake']['id']
        initial = correlate(client, intake_id, first).json()['result']
        lease = claim(backend.app.state.sessions, UUID(initial['job']['id']), settings)
        staged = assess(backend.app.state.sessions, lease, settings, backend.app.state.storage, tmp_path / 'delayed')
        correlate(client, intake_id, second)
        assert finish_discovery(backend.app.state.sessions, lease, staged, settings) is False
        drive(backend, settings, intake_id)
    assert client.get(f"/api/external-attempts/{first['id']}/evidence").json()['items'] == []
    events = client.get(f"/api/external-attempts/{second['id']}/evidence").json()['items']
    assert len(events) == 1
    assert client.get(f'/api/returns/{intake_id}').json()['assessment']['attempt_id'] == second['id']


@pytest.mark.parametrize('fence', ['expiry', 'generation', 'token'])
def test_expired_completion_rolls_back_return_rows_evidence_and_resolution(backend, tmp_path, monkeypatch, fence):
    from datetime import timedelta
    from app.domain import returns
    from app.models import ProcessingRun, ReturnAssessment, ReturnRow, EvidenceEvent, utcnow
    from app.processing.discovery import assess, finish_discovery
    from app.processing.leases import claim
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(client, backend, settings, DATA)
        drain(client)
        submission = attempt(client, bundle, 'CLIENTS')
        data, _ = returned(client, submission, ['TEST_OK'])
        intake_id = receive(client, data=data, partner=None).json()['result']['intake']['id']
        current = correlate(client, intake_id, submission).json()['result']
        run_id = UUID(current['job']['id'])
        lease = claim(backend.app.state.sessions, run_id, settings)
        staged = assess(backend.app.state.sessions, lease, settings, backend.app.state.storage, tmp_path / 'expiring')
        publish = returns.publish_return
        def expire_after_publication(db, *args):
            result = publish(db, *args)
            run = db.get(ProcessingRun, run_id)
            if fence == 'expiry':
                run.lease_expires_at = utcnow() - timedelta(seconds=1)
            elif fence == 'generation':
                run.generation += 1
            else:
                run.lease_token = uuid4()
            db.flush()
            return result
        monkeypatch.setattr(returns, 'publish_return', expire_after_publication)
        assert finish_discovery(backend.app.state.sessions, lease, staged, settings) is False
    with backend.app.state.sessions() as db:
        assert list(db.scalars(select(ReturnAssessment))) == []
        assert list(db.scalars(select(ReturnRow))) == []
        assert list(db.scalars(select(EvidenceEvent))) == []
    assert client.get(f'/api/returns/{intake_id}').json()['assessment'] is None


def test_long_publication_keeps_heartbeat_and_decision_cas_live(backend, tmp_path, monkeypatch):
    """Real DB lock probe: only the pause is injected, after all actual publication SQL."""
    from concurrent.futures import ThreadPoolExecutor
    from dataclasses import replace
    from threading import Event
    import time
    from app.domain import returns
    from app.models import EvidenceEvent, ProcessingRun, ReturnAssessment
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as base_settings:
        settings = replace(base_settings, lease_seconds=1, heartbeat_seconds=0.1)
        _, _, bundle = prepared(client, backend, settings, DATA)
        drain(client)
        first, second = attempt(client, bundle, 'CLIENTS'), attempt(client, bundle, 'CLIENTS')
        data, _ = returned(client, first, ['TEST_OK'])
        intake_id = receive(client, data=data, partner=None).json()['result']['intake']['id']
        initial = correlate(client, intake_id, first).json()['result']
        entered, release = Event(), Event()
        publish = returns.publish_return
        def paused(db, *args):
            result = publish(db, *args)
            entered.set()
            assert release.wait(10), 'Test publication barrier timed out'
            return result
        monkeypatch.setattr(returns, 'publish_return', paused)
        body = {'operation_id': str(uuid4()), 'expected_version_id': initial['version']['id'],
                'decisions': {'return_attempt_id': second['id'], 'reason': 'Selected while reconciliation publishes'}}
        with ThreadPoolExecutor(max_workers=2) as pool:
            publishing = pool.submit(drive, backend, settings, intake_id)
            try:
                assert entered.wait(5)
                with backend.app.state.sessions() as db:
                    before = db.get(ProcessingRun, UUID(initial['job']['id'])).lease_expires_at
                    assert list(db.scalars(select(ReturnAssessment))) == []
                    assert list(db.scalars(select(EvidenceEvent))) == []
                deciding = pool.submit(client.post, f'/api/intakes/{intake_id}/decisions', json=body)
                time.sleep(1.3)  # Beyond the initial lease, without releasing publication.
                with backend.app.state.sessions() as db:
                    after = db.get(ProcessingRun, UUID(initial['job']['id'])).lease_expires_at
                assert after > before, 'Publication blocked its own lease heartbeat'
                response = deciding.result(timeout=1)
                assert response.status_code == 200, response.text
            finally:
                release.set()
            publishing.result(timeout=5)
        # The obsolete transaction rolled back every tentative claim.
        assert client.get(f"/api/external-attempts/{first['id']}/evidence").json()['items'] == []
        monkeypatch.setattr(returns, 'publish_return', publish)
        drive(backend, settings, intake_id)
    assert client.get(f'/api/returns/{intake_id}').json()['assessment']['attempt_id'] == second['id']


def test_manual_resolution_of_unknown_status_is_visible_separately(backend, tmp_path):
    from test_external_evidence import evidence
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(client, backend, settings, DATA)
        drain(client)
        submission = attempt(client, bundle, 'CLIENTS')
        data, _ = returned(client, submission, ['needs human interpretation'])
        intake_id = receive(client, data=data, partner=None).json()['result']['intake']['id']
        correlate(client, intake_id, submission)
        drive(backend, settings, intake_id)
    original = client.get(f'/api/returns/{intake_id}/rows').json()
    row = original['items'][0]
    evidence(client, submission, coverage='ROWS', export_row_ids=[row['export_row_id']],
             reason='Operator checked exact row in the external database')
    current = client.get(f'/api/returns/{intake_id}/rows').json()
    assert current['items'][0]['classification'] == 'UNKNOWN'
    assert current['items'][0]['attempt_state'] == 'APPLIED'
    assert current['snapshot_version'] > original['snapshot_version']


def test_return_chain_constraints_and_foreign_selection(backend, tmp_path):
    from sqlalchemy.exc import DBAPIError
    from sqlalchemy import text
    from app.models import EvidenceEvent, ExportRow, ReturnAssessment, ReturnRow
    status_rules(backend)
    client, other = backend.client(), backend.client('other')
    with runtime(backend, tmp_path) as settings:
        two = DATA + DATA.splitlines(keepends=True)[1].replace(b'79000000000', b'79000000001').replace(b'7707083893', b'1234567894')
        _, _, bundle = prepared(client, backend, settings, two)
        _, _, foreign = prepared(other, backend, settings, DATA)
        drain(client)
        drain(other)
        submission = attempt(client, bundle, 'CLIENTS')
        foreign_attempt = attempt(other, foreign, 'CLIENTS')
        alternative = attempt(client, bundle, 'CLIENTS')
        data, _ = returned(client, submission, ['TEST_OK', 'TEST_NO'])
        intake_id = receive(client, data=data, partner=None).json()['result']['intake']['id']
        state = client.get(f'/api/intakes/{intake_id}').json()
        response = client.post(f'/api/intakes/{intake_id}/decisions', json={
            'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'],
            'decisions': {'return_attempt_id': foreign_attempt['id']}})
        assert response.status_code == 404
        correlate(client, intake_id, submission)
        drive(backend, settings, intake_id)
    result = client.get(f'/api/returns/{intake_id}').json()['assessment']
    assert other.get(f'/api/returns/{intake_id}/rows').status_code == 404
    assert other.get(f'/api/returns/{intake_id}/assessments').status_code == 404
    assert client.post(f"/api/external-attempts/{submission['id']}/evidence", json={
        'operation_id': str(uuid4()), 'coverage': 'FILE', 'outcome': 'APPLIED', 'reason': 'Fabrication',
        'origin': 'RETURN', 'source_asset_id': result['source_asset_id']}).status_code == 422
    with backend.app.state.sessions() as db:
        assessment = db.get(ReturnAssessment, UUID(result['id']))
        event = db.scalar(select(EvidenceEvent).where(EvidenceEvent.return_assessment_id == assessment.id,
                                                     EvidenceEvent.outcome == 'APPLIED'))
        original = {c.name: getattr(event, c.name) for c in event.__table__.columns}
        wrong = {**original, 'id': uuid4(), 'operation_id': uuid4(), 'attempt_id': UUID(alternative['id'])}
        with pytest.raises(DBAPIError):
            db.execute(EvidenceEvent.__table__.insert().values(**wrong))
        db.rollback()
        # Even an owned, correctly matched artifact cannot claim RETURN without assessment.
        with pytest.raises(DBAPIError):
            db.execute(EvidenceEvent.__table__.insert().values(**{**original, 'id': uuid4(),
                'operation_id': uuid4(), 'return_assessment_id': None}))
        db.rollback()
        matched = db.scalar(select(ReturnRow).where(ReturnRow.return_assessment_id == UUID(result['id']),
                                                   ReturnRow.classification == 'APPLIED'))
        rejected = db.scalar(select(ReturnRow).where(ReturnRow.return_assessment_id == UUID(result['id']),
                                                    ReturnRow.classification == 'REJECTED'))
        wrong_row_id = rejected.export_row_id
        forged_row = {c.name: getattr(matched, c.name) for c in matched.__table__.columns}
        with pytest.raises(DBAPIError):
            db.execute(ReturnRow.__table__.insert().values(**{**forged_row, 'id': uuid4(), 'ordinal': 99,
                'export_row_id': wrong_row_id}))
        db.rollback()
        with pytest.raises(DBAPIError):
            db.execute(text('INSERT INTO evidence_coverage (owner_id,artifact_id,event_id,export_row_id) '
                'VALUES (:owner,:artifact,:event,:row)'), {'owner': original['owner_id'],
                'artifact': original['artifact_id'], 'event': original['id'], 'row': wrong_row_id})
        db.rollback()
        # An unrelated foreign export cannot be attached to this assessment at all.
        foreign_row = db.scalar(select(ExportRow).where(ExportRow.artifact_id == UUID(foreign_attempt['artifact_id'])))
        with pytest.raises(DBAPIError):
            db.execute(ReturnRow.__table__.insert().values(**{**forged_row, 'id': uuid4(), 'ordinal': 100,
                'export_row_id': foreign_row.id}))
        db.rollback()
        for table in ('return_rows', 'return_assessments'):
            with pytest.raises(DBAPIError):
                db.execute(text(f'DELETE FROM {table}'))
            db.rollback()


def test_xlsx_status_uses_shared_reader_without_partner_or_add_mapping(backend, tmp_path):
    from dataclasses import replace
    from app.main import create_app
    import openpyxl
    status_rules(backend)
    backend.settings = replace(backend.settings, max_upload_bytes=100_000)
    backend.app = create_app(backend.settings, engine=backend.engine)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(client, backend, settings, b'MSISDN\r\n79000000000\r\n')
        drain(client)
        submission = attempt(client, bundle, 'DELETE')
        workbook = openpyxl.Workbook()
        workbook.active.append(['MSISDN', 'STATUS', 'SERVICE'])
        workbook.active.append(['79000000000', 'TEST_OK', 'preserve'])
        buffer = io.BytesIO()
        workbook.save(buffer)
        intake_id = receive(client, data=buffer.getvalue(), partner=None).json()['result']['intake']['id']
        correlate(client, intake_id, submission)
        drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['assessment']['reader_version'] == 'xlsx-table-v4'
    assert state['intake']['state'] == 'RECONCILED', state
    assert client.get(f'/api/returns/{intake_id}/rows').json()['items'][0]['raw_cells'][-1] == 'preserve'


def test_real_queue_completes_return_after_browser_closes(backend, tmp_path):
    from app.processing.dispatcher import dispatch_once
    from processing_helpers import wait_for, worker
    from app.models import Intake, ProcessingRun
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(client, backend, settings, DATA)
        drain(client)
        submission = attempt(client, bundle, 'CLIENTS')
        data, _ = returned(client, submission, ['TEST_OK'])
        intake_id = receive(client, data=data, partner=None).json()['result']['intake']['id']
        correlate(client, intake_id, submission)
        client.close()
        def completed():
            dispatch_once(backend.app.state.sessions, settings)
            with backend.app.state.sessions() as db:
                intake = db.get(Intake, UUID(intake_id))
                run = db.scalar(select(ProcessingRun).where(ProcessingRun.intake_version_id == intake.current_version_id))
                return run if run.state in ('COMPLETE', 'FAILED', 'BLOCKED') else None
        with worker(backend, settings, tmp_path / 'return-worker'):
            run = wait_for(completed)
        assert run.state == 'COMPLETE', run.error
    client = backend.client()
    assert client.get(f'/api/returns/{intake_id}').json()['assessment']['counts'] == {'APPLIED': 1}


def test_late_correlated_add_return_cannot_revive_causal_delete(backend, tmp_path):
    from test_external_evidence import assignments, evidence
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, added = prepared(client, backend, settings, DATA)
        _, _, deleted = prepared(client, backend, settings, b'MSISDN\r\n79000000000\r\n')
        drain(client)
        add = attempt(client, added)
        delete = attempt(client, deleted, 'DELETE', [add['id']])
        evidence(client, delete)
        data, _ = returned(client, add, ['TEST_OK'])
        intake_id = receive(client, data=data, partner=None).json()['result']['intake']['id']
        correlate(client, intake_id, add)
        drive(backend, settings, intake_id)
    assert client.get(f'/api/returns/{intake_id}/rows').json()['items'][0]['attempt_state'] == 'APPLIED'
    assert assignments(client)['items'][0]['external_state'] == 'DELETED'


def test_upgrade_preserves_legacy_u10_return_event(backend, tmp_path):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import MetaData, Table, text
    from app.models import ProcessingRevision
    from test_external_evidence import evidence
    status_rules(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, bundle = prepared(client, backend, settings, DATA)
        drain(client)
        submission = attempt(client, bundle, 'CLIENTS')
        manual = evidence(client, submission)
    with backend.app.state.sessions() as db:
        revision = db.get(ProcessingRevision, UUID(bundle['revision_id']))
        source_id, case_id = revision.source_asset_id, revision.case_id
    with backend.engine.begin() as connection:
        config = Config(str(Path(__file__).resolve().parents[2] / 'alembic.ini'))
        config.attributes['connection'] = connection
        command.downgrade(config, '0006')
        events = Table('evidence_events', MetaData(), autoload_with=connection)
        original = dict(connection.execute(select(events).where(events.c.id == UUID(manual['id']))).mappings().one())
        legacy = {**original, 'id': uuid4(), 'operation_id': uuid4(), 'origin': 'RETURN',
                  'source_asset_id': source_id, 'source_case_id': case_id}
        connection.execute(events.insert().values(**legacy))
        command.upgrade(config, 'head')
        restored = connection.execute(text('SELECT to_jsonb(e)-\'return_assessment_id\' FROM evidence_events e '
            'WHERE id=:id'), {'id': legacy['id']}).scalar_one()
        assert restored['id'] == str(legacy['id']) and restored['source_asset_id'] == str(source_id)
        assert restored['origin'] == 'RETURN' and restored['reason'] == legacy['reason']
        assert dict(connection.execute(select(events).where(events.c.id == legacy['id'])).mappings().one()) == legacy
        assert connection.execute(text('SELECT return_assessment_id FROM evidence_events WHERE id=:id'),
                                  {'id': legacy['id']}).scalar_one() is None
    response = client.get(f"/api/external-evidence/{legacy['id']}")
    assert response.status_code == 200 and response.json()['return_assessment_id'] is None
