"""Error sorting covers the whole immutable source, preserving source ordinals."""
from test_source_error_review import prepared
from uuid import uuid4


def test_errors_beyond_first_page_sort_first_and_original_order_remains_available(backend, tmp_path):
    rows = [['7805406976  ', f'{i:08}', 'Тест', 'Test', '1', '0'] for i in range(1001)]
    rows[750][3] = 'Тест'
    rows[1000][3] = 'A' * 35
    client, _, _, base, _ = prepared(backend, tmp_path, rows)
    first = client.get(base + '/records?sort=errors_first&limit=500')
    assert first.status_code == 200, first.text
    page = first.json()
    assert [r['ordinal'] for r in page['items'][:3]] == [751, 1001, 1]
    assert len(page['items']) == 500 and page['next_cursor'] == 500
    assert all(r['effective']['INN'] == '7805406976' for r in page['items'])
    assert not any(i['field'] == 'INN' for r in page['items'] for i in r['issues'])
    remaining = client.get(base + '/records?sort=errors_first&after=500&limit=500').json()
    last = client.get(base + '/records?sort=errors_first&after=1000&limit=500').json()
    ordered = page['items'] + remaining['items'] + last['items']
    assert len({r['record_id'] for r in ordered}) == len(ordered) == 1001
    original = client.get(base + '/records?sort=source&limit=500').json()
    assert [r['ordinal'] for r in original['items']] == list(range(1, 501))
    detail = client.get(base + f"/records/{page['items'][0]['record_id']}?ordinal=751").json()
    assert detail['record']['ordinal'] == 751
    assert detail['normalizations'][0]['before'] == '7805406976  '
    assert client.get(base + '/records?sort=unknown').status_code == 422


def test_saved_legacy_inn_with_boundary_spaces_can_be_manually_corrected(backend, tmp_path, monkeypatch):
    from app.domain.rules import Normalizer
    original = Normalizer.apply
    def historical(self, values):
        effective, changes = original(self, values)
        if 'INN' in values:
            effective['INN'] = values['INN']
        return effective, [change for change in changes if change['field'] != 'INN']
    with monkeypatch.context() as context:
        context.setattr(Normalizer, 'apply', historical)
        client, _, state, base, _ = prepared(backend, tmp_path, [
            ['7805406976', '001', 'Тест', 'Test', '1', '0'],
            ['7805406976  ', '002', 'Тест', 'Test', '1', '0']])
    row = client.get(base + '/records').json()['items'][1]
    assert row['effective']['INN'] == '7805406976  '
    response = client.post(f"/api/cases/{state['intake']['case_id']}/processing/save-and-start", json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
        'source_asset_id': state['source']['id'], 'corrections': [{
            'record_id': row['record_id'], 'ordinal': 2, 'field': 'INN',
            'before': row['effective']['INN'], 'after': '7805406976', 'reason': 'Boundary spaces'}]})
    assert response.status_code == 200, response.text
    new_revision = response.json()['result']['revision']
    correction = new_revision['correction_overlay'][0]
    assert correction['before'] == '7805406976'
    assert correction['submitted_before'] == '7805406976  '
    newer = client.get(f"/api/cases/{state['intake']['case_id']}/revisions/{new_revision['id']}/records").json()
    assert newer['items'][1]['effective']['INN'] == '7805406976'


def test_historical_multiline_label_can_be_corrected_without_before_conflict(backend, tmp_path, monkeypatch):
    import app.domain.rules as rules
    import app.domain.corrections as corrections
    with monkeypatch.context() as context:
        context.setattr(rules, 'label_linebreaks', lambda field, value: value)
        context.setattr(corrections, 'label_linebreaks', lambda field, value: value)
        client, _, state, base, _ = prepared(backend, tmp_path, [
            ['7805406976', '79000000000', 'Тест', 'Test\nTaxi', '1', '0']])
    row = client.get(base + '/records').json()['items'][0]
    assert row['effective']['MAV_LABEL_LATIN'] == 'Test\nTaxi'
    response = client.post(f"/api/cases/{state['intake']['case_id']}/processing/save-and-start", json={
        'operation_id': str(uuid4()), 'expected_revision_id': state['revision']['id'],
        'source_asset_id': state['source']['id'], 'corrections': [{
            'record_id': row['record_id'], 'ordinal': 1, 'field': 'MAV_LABEL_LATIN',
            'before': 'Test\nTaxi', 'after': 'New\nTaxi', 'reason': 'Line break normalization'}]})
    assert response.status_code == 200, response.text
    correction = response.json()['result']['revision']['correction_overlay'][0]
    assert correction['before'] == 'Test Taxi' and correction['submitted_before'] == 'Test\nTaxi'
    assert correction['after'] == 'New Taxi' and correction['submitted_after'] == 'New\nTaxi'
    assert client.get(base + '/records').json()['items'][0]['effective']['MAV_LABEL_LATIN'] == 'Test\nTaxi'
