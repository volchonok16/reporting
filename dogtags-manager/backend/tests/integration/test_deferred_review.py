"""Session batches use draft saves and start exactly one real rebuild at confirmation."""
from uuid import UUID, uuid4

from sqlalchemy import func, select

from app.models import ProcessingRun
from processing_helpers import runtime
from test_archive_deletion import prepared
from test_automatic_intake import drive


def test_draft_batch_preserves_changes_and_final_command_builds_once(backend, tmp_path):
    data = ('INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n'
            '7707083893;79000000000;Тест;Test;0;1\n'
            '7707083893;79000000001;Тест;Test;0;1\n').encode()
    client, intake_id, state = prepared(backend, tmp_path, data=data)
    case, head, source = state['intake']['case_id'], state['revision']['id'], state['source']['id']
    rows = client.get(f'/api/cases/{case}/revisions/{head}/records').json()['items']

    def runs():
        with backend.app.state.sessions() as db:
            return db.scalar(select(func.count()).select_from(ProcessingRun)
                             .where(ProcessingRun.case_id == UUID(case)))

    before = runs()
    draft_body = {'operation_id': str(uuid4()), 'expected_revision_id': head,
                  'source_asset_id': source, 'corrections': [{
                      'record_id': rows[0]['record_id'], 'ordinal': 1, 'field': 'MAV_LABEL_NAME',
                      'before': 'Тест', 'after': 'Первый', 'reason': 'Session batch'}]}
    draft = client.post(f'/api/cases/{case}/revisions', json=draft_body)
    assert draft.status_code == 200, draft.text
    assert runs() == before
    draft_head = draft.json()['result']['revision']['id']
    receipt = client.get('/api/operations', params={'operation_id': draft_body['operation_id'],
                                                  'action': 'revision.save', 'case_id': case})
    assert receipt.status_code == 200, receipt.text
    assert receipt.json()['result']['revision']['id'] == draft_head
    final_body = {'operation_id': str(uuid4()), 'expected_revision_id': draft_head,
                  'source_asset_id': source, 'corrections': [{
                      'record_id': rows[1]['record_id'], 'ordinal': 2, 'field': 'MAV_LABEL_NAME',
                      'before': 'Тест', 'after': 'Второй', 'reason': 'Session batch'}],
                  'row_selections': [{'record_id': rows[0]['record_id'], 'ordinal': 1,
                                      'before': False, 'excluded': True}],
                  'overrides': [{'field': 'INTERNAL_OPERATOR_NAME', 'before': 'hubRTK',
                                 'after': '', 'reason': 'Confirmed empty operator'}]}
    path = f'/api/cases/{case}/processing/save-and-start'
    final = client.post(path, json=final_body)
    assert final.status_code == 200, final.text
    assert client.post(path, json=final_body).json()['id'] == final.json()['id']
    assert runs() == before + 1
    with runtime(backend, tmp_path / 'final') as settings:
        drive(backend, settings, intake_id)
    current = client.get(f'/api/intakes/{intake_id}').json()
    assert current['job']['state'] == 'PREPARED', current
    final_head = current['revision']['id']
    assert final_head == final.json()['result']['revision']['id']
    base = f'/api/cases/{case}/revisions/{final_head}'
    records = client.get(base + '/records').json()['items']
    assert [r['effective']['MAV_LABEL_NAME'] for r in records] == ['Первый', 'Второй']
    assert records[0]['disposition'] == 'excluded_manual'
    bundle = client.get(base + '/artifacts').json()
    numbers = next(a for a in bundle['artifacts'] if a['role'] == 'NUMBERS')
    preview = client.get(base + f"/artifacts/{numbers['id']}/preview").json()
    assert preview['items'] == [['7707083893', 'Второй', '79000000001', '0', '1', '0', '']]
    assert client.get(f'/api/cases/{case}/sources/{source}/raw').content == data
