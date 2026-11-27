"""Progress is persisted at server milestones; terminal results remain observable."""
from dataclasses import replace
from uuid import UUID

import pytest

from app.models import SourceAsset
from processing_helpers import runtime
from test_automatic_intake import DATA, drive, receive, seed


@pytest.mark.parametrize('scenario,expected', [
    ('valid', 'PREPARED'), ('invalid_inn', 'PREPARED'),
    ('unknown_columns', 'NEEDS_DECISION'), ('missing_source', 'FAILED'),
])
def test_persisted_progress_and_terminal_results(backend, tmp_path, monkeypatch, scenario, expected):
    from app.processing.tasks import LeaseHeartbeat

    seed(backend)
    client = backend.client()
    data = DATA.replace(b'7707083893', b'123') if scenario == 'invalid_inn' else DATA
    if scenario == 'unknown_columns':
        data = b'unknown;other\nvalue;value\n'
    receipt = receive(client, data=data).json()['result']
    intake_id = receipt['intake']['id']
    observed = []
    original = LeaseHeartbeat.stage

    def record(self, name, percent):
        original(self, name, percent)
        job = client.get(f'/api/intakes/{intake_id}').json()['job']
        assert job['state'] == 'PROCESSING'
        assert job['progress'] == {'stage': name, 'percent': percent}
        assert 0 < percent < 100
        observed.append((job['id'], percent))

    monkeypatch.setattr(LeaseHeartbeat, 'stage', record)
    if scenario == 'missing_source':
        with backend.app.state.sessions() as db:
            source = db.get(SourceAsset, UUID(receipt['source']['id']))
            backend.app.state.storage.path_for_key(source.storage_key).unlink()
    with runtime(backend, tmp_path) as settings:
        settings = replace(settings, max_job_attempts=1)
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    result = client.get(f'/api/intakes/{intake_id}').json()
    assert observed
    for job_id in {value[0] for value in observed}:
        values = [value[1] for value in observed if value[0] == job_id]
        assert values == sorted(values)
    if expected == 'NEEDS_DECISION':
        assert result['intake']['state'] == expected
        assert result['assessment']['questions']
        assert result['job']['state'] == 'COMPLETE'
    else:
        assert result['job']['state'] == expected
    assert result['job']['progress']['percent'] == (0 if expected == 'FAILED' else 100)
    if expected == 'BLOCKED':
        assert result['job']['summary']['blocking']
    if expected == 'FAILED':
        assert result['job']['error']['code'] == 'storage_integrity_error'
    if scenario == 'invalid_inn':
        assert result['job']['summary']['counts'] == {'ERRORS': 1}
        assert result['job']['summary']['reconciliation']['complete']
        assert {output['role'] for output in result['output_files']} == {'ERRORS', 'ZIP'}
