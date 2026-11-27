from datetime import datetime, timedelta
from uuid import UUID

from app.models import AuditEvent, Case
from test_archive_deletion import command, prepared
from test_automatic_intake import receive, seed


def test_every_upload_has_a_persisted_date_in_detail_and_archive(backend):
    seed(backend)
    client = backend.client()
    received = receive(client).json()['result']
    intake_id = received['intake']['id']
    initial = datetime.fromisoformat(received['intake']['worked_at'])
    assert initial.tzinfo and initial >= datetime.fromisoformat(received['source']['created_at'])
    first = client.get(f'/api/intakes/{intake_id}').json()['intake']['worked_at']
    assert client.get('/api/intakes').json()['items'][0]['intake']['worked_at'] == first
    assert client.get(f'/api/intakes/{intake_id}').json()['intake']['worked_at'] == first


def test_latest_work_date_is_scoped_and_unchanged_by_read_and_delete(backend, tmp_path):
    client, intake_id, state = prepared(backend, tmp_path)
    case_id = UUID(state['intake']['case_id'])
    moment = datetime.fromisoformat(state['intake']['worked_at']) + timedelta(minutes=2)
    other = backend.client('other')
    foreign = receive(other).json()['result']
    with backend.app.state.sessions() as db:
        owner_id = db.get(Case, case_id).owner_id
        foreign_id = UUID(foreign['intake']['case_id'])
        db.add(AuditEvent(case_id=case_id, actor_id=owner_id, action='revision.save', created_at=moment, details={'test': True}))
        db.add(AuditEvent(case_id=case_id, actor_id=owner_id, action='intake.restored', created_at=moment + timedelta(days=1), details={'test': True}))
        db.add(AuditEvent(case_id=foreign_id, actor_id=db.get(Case, foreign_id).owner_id, action='revision.save',
                          created_at=moment + timedelta(days=2), details={'test': True}))
        db.commit()
    path = f'/api/intakes/{intake_id}'
    value = client.get(path).json()
    assert datetime.fromisoformat(value['intake']['worked_at']) == moment
    assert datetime.fromisoformat(client.get('/api/intakes').json()['items'][0]['intake']['worked_at']) == moment
    deleted = client.post(path + '/archive', json=command(value))
    assert deleted.status_code == 200
    assert datetime.fromisoformat(deleted.json()['result']['intake']['worked_at']) == moment
    assert client.get('/api/intakes').json()['items'] == []
