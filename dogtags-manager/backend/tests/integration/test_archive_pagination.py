"""Actual processing outputs and lossless, bounded 500-row API pages."""
from dataclasses import replace

from app.main import create_app
from processing_helpers import runtime
from test_automatic_intake import drive, receive, seed


def test_archive_newest_first_across_pages_with_equal_dates(backend):
    from datetime import datetime, timedelta, timezone
    from uuid import UUID
    from app.models import Intake
    seed(backend)
    client = backend.client()
    ids = sorted(UUID(receive(client).json()['result']['intake']['id']) for _ in range(4))
    base = datetime(2026, 10, 1, tzinfo=timezone.utc)
    with backend.app.state.sessions() as db:
        for identity, days in zip(ids, [2, 3, 3, 0]):
            db.get(Intake, identity).created_at = base + timedelta(days=days)
        db.commit()
    first = client.get('/api/intakes', params={'limit': 2}).json()
    second = client.get('/api/intakes', params={'limit': 2, 'after': first['next_cursor']}).json()
    assert [row['intake']['id'] for row in first['items'] + second['items']] == [
        str(ids[i]) for i in [2, 1, 0, 3]]
    assert second['next_cursor'] is None
    assert backend.client('other').get('/api/intakes', params={'after': first['next_cursor']}).status_code == 404


def source_rows(count, *, invalid=False):
    weights = [2, 4, 10, 3, 5, 9, 4, 6, 8]
    rows = ['INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS']
    for index in range(count):
        prefix = str(770000000 + index)
        check = sum(int(digit) * weight for digit, weight in zip(prefix, weights)) % 11 % 10
        inn = '123' if invalid else prefix + str(check)
        rows.append(f'{inn};{79000000000 + index};Тест;Test;0;1')
    return ('\n'.join(rows) + '\n').encode()


def pages(client, path):
    after, collected, lengths = None, [], []
    while True:
        response = client.get(path, params={'limit': 500, **({'after': after} if after is not None else {})})
        assert response.status_code == 200, response.text
        page = response.json()
        collected.extend(page['items'])
        lengths.append(len(page['items']))
        after = page['next_cursor']
        if after is None:
            break
    assert client.get(path, params={'limit': 501}).status_code == 422
    return collected, lengths


def process(backend, tmp_path, data):
    seed(backend)
    backend.settings = replace(backend.settings, max_upload_bytes=200_000)
    backend.app = create_app(backend.settings, engine=backend.engine)
    client = backend.client()
    response = receive(client, data=data)
    assert response.status_code == 200, response.text
    intake_id = response.json()['result']['intake']['id']
    assert response.json()['result']['output_files'] == []
    with runtime(backend, tmp_path) as settings:
        drive(backend, settings, intake_id)
        drive(backend, settings, intake_id)
    return client, intake_id, client.get(f'/api/intakes/{intake_id}').json()


def test_all_csv_outputs_and_source_pages_preserve_every_row(backend, tmp_path):
    client, intake_id, detail = process(backend, tmp_path, source_rows(1021))
    assert detail['job']['state'] == 'PREPARED', detail
    base = f"/api/cases/{detail['intake']['case_id']}/revisions/{detail['revision']['id']}"
    records, sizes = pages(client, base + '/records')
    assert sizes == [500, 500, 21]
    assert [row['ordinal'] for row in records] == list(range(1, 1022))
    assert len({row['record_id'] for row in records}) == 1021
    assert len(client.get(base + '/records').json()['items']) == 500
    artifacts = client.get(base + '/artifacts').json()['artifacts']
    assert detail['output_files'] == [{key: row[key] for key in ('id', 'role', 'download_filename', 'row_count', 'database_status')}
                                     for row in artifacts]
    for artifact in artifacts:
        if artifact['role'] == 'ZIP':
            continue
        rows, sizes = pages(client, base + f"/artifacts/{artifact['id']}/preview")
        assert sizes == [500, 500, 21]
        assert len({tuple(row) for row in rows}) == 1021
        assert len(client.get(base + f"/artifacts/{artifact['id']}/preview").json()['items']) == 500
    assert client.get('/api/intakes').json()['items'][0] == detail
    # Repeated filenames remain independent dated processing records.
    again = receive(client).json()['result']
    entries = client.get('/api/intakes').json()['items']
    assert {item['intake']['id'] for item in entries} == {intake_id, again['intake']['id']}
    assert all(item['source']['filename'] == 'source.csv' and item['intake']['worked_at'] for item in entries)
    assert backend.client('other').get('/api/intakes').json()['items'] == []
    assert backend.client('other').get(f'/api/intakes/{intake_id}').status_code == 404


def test_invalid_source_has_paged_errors_and_only_a_truthful_diagnostic_output(backend, tmp_path):
    client, _, detail = process(backend, tmp_path, source_rows(1021, invalid=True))
    assert detail['job']['state'] == 'PREPARED', detail
    assert {output['role'] for output in detail['output_files']} == {'ERRORS', 'ZIP'}
    assert detail['job']['summary']['counts'] == {'ERRORS': 1021}
    base = f"/api/cases/{detail['intake']['case_id']}/revisions/{detail['revision']['id']}"
    errors, sizes = pages(client, base + '/issues')
    assert sizes == [500, 500, 21]
    assert len(errors) == 1021
    records, sizes = pages(client, base + '/records')
    assert sizes == [500, 500, 21]
    assert len({row['record_id'] for row in records}) == 1021
    assert {output['role'] for output in client.get('/api/intakes').json()['items'][0]['output_files']} == {'ERRORS', 'ZIP'}
