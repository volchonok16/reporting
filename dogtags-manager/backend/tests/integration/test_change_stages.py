"""CHANGE keeps explicit old numbers separate from corrected replacements."""
from uuid import uuid4

from processing_helpers import runtime
from test_automatic_intake import DATA, drive, receive, seed


def prepared(client, backend, settings, data):
    intake_id = receive(client, data=data).json()['result']['intake']['id']
    drive(backend, settings, intake_id)
    drive(backend, settings, intake_id)
    state = client.get(f'/api/intakes/{intake_id}').json()
    assert state['job']['state'] == 'PREPARED', state
    base = f"/api/cases/{state['intake']['case_id']}/revisions/{state['revision']['id']}"
    return state, base, client.get(base + '/artifacts').json()


def test_change_uses_explicit_old_scope_and_independent_replacement(backend, tmp_path):
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, old = prepared(client, backend, settings, b'MSISDN\r\n79000000001\r\n')
        state, _, _ = prepared(client, backend, settings, DATA)
        body = {'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
                'delete_scope': {'artifact_id': old['artifacts'][0]['id'],
                                 'manifest_hash': old['manifest_hash'], 'confirmed': True}}
        response = client.post(f"/api/cases/{state['intake']['case_id']}/change", json=body)
        assert response.status_code == 200, response.text
        revision = response.json()['result']['revision']['id']
        drive(backend, settings, state['intake']['id'])
    base = f"/api/cases/{state['intake']['case_id']}/revisions/{revision}"
    result = client.get(base + '/artifacts').json()
    assert [a['role'] for a in result['artifacts']] == ['DELETE', 'CLIENTS', 'DOGTAGS', 'NUMBERS', 'ZIP']
    assert result['output_spec']['stages'] == [
        {'id': 'DELETE', 'roles': ['DELETE'], 'depends_on': []},
        {'id': 'ADD', 'roles': ['CLIENTS', 'DOGTAGS', 'NUMBERS'], 'depends_on': ['DELETE']}]
    previews = {a['role']: client.get(base + f"/artifacts/{a['id']}/preview").json()['items']
                for a in result['artifacts'] if a['role'] != 'ZIP'}
    assert previews['DELETE'] == [['79000000001']]
    assert previews['NUMBERS'][0][2] == '79000000000'
    stages = client.get(base + '/change').json()
    assert stages['delete_scope']['artifact_id'] == old['artifacts'][0]['id']
    assert stages['stages'][1]['depends_on_id'] == stages['stages'][0]['id']


def test_change_intake_waits_for_scope_and_rejects_foreign_or_unconfirmed_source(backend, tmp_path):
    seed(backend)
    client, other = backend.client(), backend.client('other')
    with runtime(backend, tmp_path) as settings:
        _, _, foreign = prepared(other, backend, settings, b'MSISDN\r\n79000000001\r\n')
        _, _, old = prepared(client, backend, settings, b'MSISDN\r\n79000000001\r\n')
        received = client.post('/api/intakes', params={'partner': 'RTK HUB', 'operation': 'CHANGE'},
            headers={'X-Operation-ID': str(uuid4())}, files={'file': ('change.csv', DATA, 'text/csv')})
        intake = received.json()['result']['intake']['id']
        drive(backend, settings, intake)
        state = client.get(f'/api/intakes/{intake}').json()
        assert state['revision'] is None and state['intake']['state'] == 'NEEDS_DECISION'
        assert 'delete_scope_required' in {q['code'] for q in state['assessment']['questions']}
        body = {'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'], 'decisions': {
            'delete_scope': {'artifact_id': foreign['artifacts'][0]['id'],
                             'manifest_hash': foreign['manifest_hash'], 'confirmed': True}}}
        assert client.post(f'/api/intakes/{intake}/decisions', json=body).status_code == 404
        body['decisions']['delete_scope'] = {'artifact_id': old['artifacts'][0]['id'],
                                           'manifest_hash': old['manifest_hash'], 'confirmed': False}
        assert client.post(f'/api/intakes/{intake}/decisions', json=body).status_code == 422
        body['decisions']['delete_scope']['confirmed'] = True
        response = client.post(f'/api/intakes/{intake}/decisions', json=body)
        assert response.status_code == 200, response.text
        drive(backend, settings, intake)
        drive(backend, settings, intake)
    state = client.get(f'/api/intakes/{intake}').json()
    assert state['job']['state'] == 'PREPARED', state
    assert state['revision']['settings']['operation'] == 'CHANGE'


def approval(client, case, revision, result):
    response = client.post(f'/api/cases/{case}/approval', json={'operation_id': str(uuid4()),
        'expected_revision_id': revision, 'manifest_hash': result['manifest_hash']})
    assert response.status_code == 200, response.text


def change(client, state, source):
    obj = next(a for a in source['artifacts'] if a['role'] in ('DELETE', 'NUMBERS'))
    body = {'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
            'delete_scope': {'artifact_id': obj['id'], 'manifest_hash': source['manifest_hash'], 'confirmed': True}}
    url = f"/api/cases/{state['intake']['case_id']}/change"
    response = client.post(url, json=body)
    assert response.status_code == 200, response.text
    assert client.post(url, json=body).json()['id'] == response.json()['id']
    assert client.post(url, json={**body, 'operation_id': str(uuid4())}).status_code == 409
    return response.json()['result']['revision']['id']


def test_scope_change_and_corrections_require_new_approval_and_preserve_old_bytes(backend, tmp_path):
    from uuid import UUID
    from app.models import Artifact
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, old = prepared(client, backend, settings, b'MSISDN\r\n79000000001\r\n')
        _, _, second_scope = prepared(client, backend, settings, b'MSISDN\r\n79000000002\r\n')
        state, original_base, _ = prepared(client, backend, settings, DATA)
        case, intake = state['intake']['case_id'], state['intake']['id']
        record = client.get(original_base + '/records').json()['items'][0]
        corrected = client.post(f'/api/cases/{case}/revisions', json={
            'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
            'source_asset_id': state['revision']['source']['id'], 'corrections': [{
                'record_id': record['record_id'], 'ordinal': 1, 'field': 'MSISDN',
                'before': '79000000000', 'after': '79000000003', 'reason': 'Replacement corrected'}]})
        assert corrected.status_code == 200, corrected.text
        state['revision'] = corrected.json()['result']['revision']
        revision = change(client, state, old)
        drive(backend, settings, intake)
        base = f'/api/cases/{case}/revisions/{revision}'
        result = client.get(base + '/artifacts').json()
        assert result['manifest']['reconciliation']['complete'] is True
        approval(client, case, revision, result)
        old_bytes = {}
        for obj in result['artifacts']:
            response = client.get(base + f"/artifacts/{obj['id']}/download", params={
                'expected_revision_id': revision, 'manifest_hash': result['manifest_hash']})
            assert response.status_code == 200
            old_bytes[obj['id']] = response.content
        assert b'79000000003' in old_bytes[result['artifacts'][3]['id']]
        state['revision'] = client.get(f'/api/intakes/{intake}').json()['revision']
        revised = change(client, state, second_scope)
        drive(backend, settings, intake)
        new_base = f'/api/cases/{case}/revisions/{revised}'
        updated = client.get(new_base + '/artifacts').json()
        assert updated['manifest_hash'] != result['manifest_hash']
        assert client.get(new_base + '/approval').json()['approved'] is False
        for obj in updated['artifacts']:
            assert client.get(new_base + f"/artifacts/{obj['id']}/download", params={
                'expected_revision_id': revised, 'manifest_hash': updated['manifest_hash']}).status_code == 409
        assert client.get(base + '/approval').json()['approved'] is False
        approval(client, case, revised, updated)
        assert client.get(new_base + f"/artifacts/{updated['artifacts'][0]['id']}/preview").json()['items'] == [['79000000002']]
        assert client.get(new_base + f"/artifacts/{updated['artifacts'][3]['id']}/preview").json()['items'][0][2] == '79000000003'
        # Corrections appended after scope selection propagate without changing old DELETE scope.
        saved = client.post(f'/api/cases/{case}/processing/save-and-start', json={
            'operation_id': str(uuid4()), 'expected_revision_id': revised,
            'source_asset_id': state['revision']['source']['id'], 'corrections': [{
                'record_id': record['record_id'], 'ordinal': 1, 'field': 'MSISDN',
                'before': '79000000003', 'after': '79000000004', 'reason': 'Final replacement'}]})
        assert saved.status_code == 200, saved.text
        drive(backend, settings, intake)
        final = client.get(f'/api/intakes/{intake}').json()
        final_base = f"/api/cases/{case}/revisions/{final['revision']['id']}"
        final_result = client.get(final_base + '/artifacts').json()
        assert client.get(final_base + f"/artifacts/{final_result['artifacts'][0]['id']}/preview").json()['items'] == [['79000000002']]
        assert client.get(final_base + f"/artifacts/{final_result['artifacts'][3]['id']}/preview").json()['items'][0][2] == '79000000004'
    with backend.app.state.sessions() as db:
        for artifact_id, expected in old_bytes.items():
            artifact = db.get(Artifact, UUID(artifact_id))
            assert backend.app.state.storage.path_for_key(artifact.storage_key).read_bytes() == expected


def test_historical_numbers_scope_and_source_selection_are_owner_scoped(backend, tmp_path):
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        history, _, old = prepared(client, backend, settings, DATA.replace(b'79000000000', b'79000000001'))
        state, _, _ = prepared(client, backend, settings, DATA)
        saved = client.post(f"/api/cases/{history['intake']['case_id']}/revisions", json={
            'operation_id': str(uuid4()), 'expected_revision_id': history['revision']['id'],
            'source_asset_id': history['revision']['source']['id']})
        assert saved.status_code == 200
        candidates = client.get('/api/change-sources?limit=1').json()
        assert len(candidates['items']) == 1 and candidates['next_cursor']
        rest = client.get('/api/change-sources', params={'after': candidates['next_cursor']}).json()
        assert len(rest['items']) == 1
        assert backend.client('other').get('/api/change-sources').json()['items'] == []
        revision = change(client, state, old)
        drive(backend, settings, state['intake']['id'])
    base = f"/api/cases/{state['intake']['case_id']}/revisions/{revision}"
    result = client.get(base + '/artifacts').json()
    assert client.get(base + f"/artifacts/{result['artifacts'][0]['id']}/preview").json()['items'] == [['79000000001']]
    assert backend.client('other').get(base + '/change').status_code == 404


def test_intake_scope_reselection_keeps_corrections_and_blocks_incompatible_mapping(backend, tmp_path):
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, old = prepared(client, backend, settings, b'MSISDN\r\n79000000001\r\n')
        state, base, _ = prepared(client, backend, settings, DATA)
        case, intake = state['intake']['case_id'], state['intake']['id']
        record = client.get(base + '/records').json()['items'][0]
        response = client.post(f'/api/cases/{case}/revisions', json={
            'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
            'source_asset_id': state['revision']['source']['id'], 'corrections': [{
                'record_id': record['record_id'], 'ordinal': 1, 'field': 'MSISDN',
                'before': '79000000000', 'after': '79000000003', 'reason': 'Correct replacement'}],
            'overrides': [{'field': 'SPREADING', 'before': '0', 'after': '1', 'reason': 'Confirmed scope'}]})
        assert response.status_code == 200
        selection = {'artifact_id': old['artifacts'][0]['id'], 'manifest_hash': old['manifest_hash'], 'confirmed': True}
        body = {'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'],
                'decisions': {'operation': 'CHANGE', 'delete_scope': selection}}
        assert client.post(f'/api/intakes/{intake}/decisions', json=body).status_code == 200
        drive(backend, settings, intake)
        drive(backend, settings, intake)
        state = client.get(f'/api/intakes/{intake}').json()
        assert state['job']['state'] == 'PREPARED', state
        base = f"/api/cases/{case}/revisions/{state['revision']['id']}"
        result = client.get(base + '/artifacts').json()
        assert client.get(base + f"/artifacts/{result['artifacts'][3]['id']}/preview").json()['items'][0][2] == '79000000003'
        assert state['revision']['correction_overlay'][0]['after'] == '79000000003'
        assert state['revision']['settings']['profile_overrides']['SPREADING']['after'] == '1'
        assert len(state['revision']['settings']['profile_override_history']) == 1
        assert client.get(base + f"/artifacts/{result['artifacts'][3]['id']}/preview").json()['items'][0][5] == '1'
        mapping = state['assessment']['result']['mapping']
        mapping['INN'], mapping['MSISDN'] = mapping['MSISDN'], mapping['INN']
        response = client.post(f'/api/intakes/{intake}/decisions', json={
            'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'], 'decisions': {'mapping': mapping}})
        assert response.status_code == 200
        drive(backend, settings, intake)
    blocked = client.get(f'/api/intakes/{intake}').json()
    assert blocked['revision'] is None
    assert 'saved_corrections_mapping_conflict' in {q['code'] for q in blocked['assessment']['questions']}


def test_change_scope_and_stage_relations_are_immutable_and_reject_cross_set_links(backend, tmp_path):
    from uuid import UUID
    import pytest
    from sqlalchemy import select, text
    from sqlalchemy.exc import SQLAlchemyError
    from app.models import ChangeScope, StageArtifact
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, old = prepared(client, backend, settings, b'MSISDN\r\n79000000001\r\n')
        state, _, _ = prepared(client, backend, settings, DATA)
        revision = change(client, state, old)
        drive(backend, settings, state['intake']['id'])
    base = f"/api/cases/{state['intake']['case_id']}/revisions/{revision}"
    linked = client.get(base + '/change').json()
    with backend.app.state.sessions() as db:
        scope = db.scalar(select(ChangeScope).where(ChangeScope.revision_id == UUID(revision)))
        assert scope.snapshot['artifact_id'] == old['artifacts'][0]['id']
        for table in ('change_scopes', 'output_stages', 'stage_artifacts'):
            with pytest.raises(SQLAlchemyError), db.begin_nested():
                db.execute(text(f'UPDATE {table} SET created_at = now()'))
        with pytest.raises(SQLAlchemyError), db.begin_nested():
            db.add(StageArtifact(artifact_set_id=UUID(linked['stages'][0]['artifact_set_id']),
                stage_id=UUID(linked['stages'][0]['id']), artifact_id=UUID(old['artifacts'][0]['id'])))
            db.flush()
    assert client.get(base + '/artifacts').status_code == 200


def test_scope_requires_exact_manifest_and_number_artifact_and_blocks_corruption(backend, tmp_path):
    from uuid import UUID
    from app.models import Artifact
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, old = prepared(client, backend, settings, DATA)
        state, _, _ = prepared(client, backend, settings, DATA)
    url = f"/api/cases/{state['intake']['case_id']}/change"
    body = {'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'], 'delete_scope': {
        'artifact_id': old['artifacts'][0]['id'], 'manifest_hash': old['manifest_hash'], 'confirmed': True}}
    assert client.post(url, json=body).status_code == 422  # CLIENTS is not an old-number source.
    body['delete_scope']['artifact_id'] = old['artifacts'][2]['id']
    body['delete_scope']['manifest_hash'] = '0' * 64
    assert client.post(url, json=body).status_code == 409
    body['delete_scope']['manifest_hash'] = old['manifest_hash']
    with backend.app.state.sessions() as db:
        artifact = db.get(Artifact, UUID(old['artifacts'][2]['id']))
        backend.app.state.storage.path_for_key(artifact.storage_key).write_bytes(b'corrupted')
    assert client.post(url, json=body).status_code == 503


def test_other_intake_decisions_preserve_change_selected_on_revision(backend, tmp_path):
    seed(backend)
    client = backend.client()
    with runtime(backend, tmp_path) as settings:
        _, _, old = prepared(client, backend, settings, b'MSISDN\r\n79000000001\r\n')
        state, _, _ = prepared(client, backend, settings, DATA)
        change(client, state, old)
        drive(backend, settings, state['intake']['id'])
        response = client.post(f"/api/intakes/{state['intake']['id']}/decisions", json={
            'operation_id': str(uuid4()), 'expected_version_id': state['version']['id'], 'decisions': {}})
        assert response.status_code == 200
        drive(backend, settings, state['intake']['id'])
        drive(backend, settings, state['intake']['id'])
    final = client.get(f"/api/intakes/{state['intake']['id']}").json()
    assert final['job']['state'] == 'PREPARED', final
    assert final['revision']['settings']['operation'] == 'CHANGE'
    assert final['revision']['settings']['delete_scope']['artifact_id'] == old['artifacts'][0]['id']
