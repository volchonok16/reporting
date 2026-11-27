"""Binary Excel intake and audited bulk labels on a synthetic workbook."""
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

from app.main import create_app
from processing_helpers import runtime
from test_automatic_intake import drive, seed


def test_xlsb_without_label_columns_accepts_bulk_then_individual_labels(backend, tmp_path):
    backend.settings = replace(backend.settings, max_upload_bytes=1024 * 1024)
    backend.app = create_app(backend.settings, engine=backend.engine)
    seed(backend)
    client = backend.client()
    workbook = Path(__file__).resolve().parents[1] / 'fixtures' / 'marking-no-labels.xlsb'
    received = client.post('/api/intakes', params={'partner': 'RTK HUB', 'operation': 'ADD'},
        headers={'X-Operation-ID': str(uuid4())},
        files={'file': (workbook.name, workbook.read_bytes(), 'application/vnd.ms-excel.sheet.binary.macroenabled.12')})
    assert received.status_code == 200, received.text
    intake_id = received.json()['result']['intake']['id']
    intake_url = f'/api/intakes/{intake_id}'
    with runtime(backend, tmp_path) as configuration:
        drive(backend, configuration, intake_id)
        drive(backend, configuration, intake_id)
        state = client.get(intake_url).json()
        assert state['assessment']['reader_version'] == 'xlsb-table-v1'
        case = state['intake']['case_id']
        revision = state['revision']
        old_url = f"/api/cases/{case}/revisions/{revision['id']}"
        rows = client.get(old_url + '/records').json()['items']
        assert [row['line_start'] for row in rows] == [4, 5]
        assert [row['effective']['MAV_LABEL_NAME'] for row in rows] == ['', '']
        action = f'/api/cases/{case}/processing/save-and-start'
        body = {'operation_id': str(uuid4()), 'expected_revision_id': revision['id'],
                'source_asset_id': state['source']['id'],
                'bulk_labels': {'MAV_LABEL_NAME': 'Новая этикетка', 'MAV_LABEL_LATIN': 'New Label'}}
        response = client.post(action, json=body)
        assert response.status_code == 200, response.text
        assert client.post(action, json=body).json() == response.json()
        drive(backend, configuration, intake_id)
        current = client.get(intake_url).json()
        new_revision = current['revision']
        base = f"/api/cases/{case}/revisions/{new_revision['id']}"
        new_rows = client.get(base + '/records').json()['items']
        assert [row['effective']['MAV_LABEL_LATIN'] for row in new_rows] == ['New Label', 'New Label']
        assert client.get(old_url + '/records').json()['items'] == rows
        individual = client.post(action, json={
            'operation_id': str(uuid4()), 'expected_revision_id': new_revision['id'],
            'source_asset_id': state['source']['id'],
            'corrections': [{'record_id': new_rows[0]['record_id'], 'ordinal': 1,
                             'field': 'MAV_LABEL_LATIN', 'before': 'New Label', 'after': 'Individual'}]})
        assert individual.status_code == 200, individual.text
        drive(backend, configuration, intake_id)
    current = client.get(intake_url).json()
    assert current['job']['state'] == 'PREPARED', current
    final = f"/api/cases/{case}/revisions/{current['revision']['id']}"
    rows = client.get(final + '/records').json()['items']
    assert [row['effective']['MAV_LABEL_LATIN'] for row in rows] == ['Individual', 'New Label']
    artifacts = client.get(final + '/artifacts').json()
    assert artifacts['manifest']['counts'] == {'CLIENTS': 1, 'DOGTAGS': 2, 'NUMBERS': 2}
