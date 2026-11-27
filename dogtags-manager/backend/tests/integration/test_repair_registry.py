"""Auxiliary repair imports constrain only the business rows they recover."""
import pytest

from test_external_evidence import attempt, backfill, drain, evidence
from test_status_repair import prepare


def returned_row(role, inn, status='', phone='79000000000'):
    if role == 'DOGTAGS':
        return [inn, 'Тест', 'Test', '1', status]
    return [inn, 'Тест', phone, '1', '0', '0', 'original', status]


def returned_columns(role):
    if role == 'DOGTAGS':
        return ['INN', 'MAV_LABEL', 'MAV_LABEL_LATIN', 'IS_ACTIVE', 'STATUS']
    return ['INN', 'MAV_LABEL_NAME', 'MSISDN', 'IS_MAV', 'IS_KSS',
            'SPREADING', 'INTERNAL_OPERATOR_NAME', 'STATUS']


def states_by_inn(client, role):
    kind = 'LABEL' if role == 'DOGTAGS' else 'ASSIGNMENT'
    page = client.get('/api/registry', params={'kind': kind})
    assert page.status_code == 200, page.text
    states = {}
    for entry in page.json()['items']:
        sources = client.get(f"/api/registry/{entry['id']}/sources")
        assert sources.status_code == 200, sources.text
        source = next((row for row in sources.json()['items'] if 'INN' in row['values']), None)
        if source:
            states[source['values']['INN']] = entry['external_state']
    return states


@pytest.mark.parametrize('role', ['DOGTAGS', 'NUMBERS'])
def test_unrelated_repair_clients_do_not_block_applied_main_import(backend, tmp_path, role):
    rows = [returned_row(role, '7707083893', 'ИНН отсутствует в таблице MAV клиентов'),
            returned_row(role, '1234567894', phone='79000000001')]
    client, _, _, _, bundle = prepare(backend, tmp_path, returned_columns(role), rows)
    assert bundle['manifest']['counts'] == {'CLIENTS': 1, role: 1}
    drain(client)
    clients = attempt(client, bundle, 'CLIENTS', ordered=False)
    evidence(client, clients)
    main = attempt(client, bundle, role, [clients['id']], ordered=False)
    evidence(client, main)
    assert states_by_inn(client, role) == {'1234567894': 'APPLIED'}


@pytest.mark.parametrize('role', ['DOGTAGS', 'NUMBERS'])
def test_related_client_still_requires_applied_causal_evidence(backend, tmp_path, role):
    rows = [returned_row(role, '7707083893', 'ИНН отсутствует в таблице MAV клиентов'),
            returned_row(role, '7707083893', phone='79000000001'),
            returned_row(role, '1234567894', phone='79000000002')]
    client, _, _, _, bundle = prepare(backend, tmp_path, returned_columns(role), rows)
    assert bundle['manifest']['counts'] == {'CLIENTS': 1, role: 2}
    drain(client)
    clients = attempt(client, bundle, 'CLIENTS', ordered=False)
    main = attempt(client, bundle, role, [clients['id']], ordered=False)
    evidence(client, main)
    assert states_by_inn(client, role) == {'7707083893': 'CONFLICT', '1234567894': 'APPLIED'}
    evidence(client, clients)
    assert states_by_inn(client, role) == {'7707083893': 'APPLIED', '1234567894': 'APPLIED'}


def test_repair_delete_stage_remains_a_whole_file_prerequisite(backend, tmp_path):
    rows = [returned_row('NUMBERS', '7707083893', 'Номер телефона уже есть в таблице MAV номеров'),
            returned_row('NUMBERS', '1234567894', phone='79000000001')]
    client, _, _, _, bundle = prepare(backend, tmp_path, [*returned_columns('NUMBERS'), 'MAV_OPERATOR_NAME'],
                                     [[*row, 'mTELE2'] for row in rows])
    assert bundle['manifest']['counts'] == {'NUMBERS': 1, 'DELETE': 1}
    drain(client)
    deletion = attempt(client, bundle, 'DELETE', ordered=False)
    main = attempt(client, bundle, 'NUMBERS', [deletion['id']], ordered=False)
    evidence(client, main)
    assert states_by_inn(client, 'NUMBERS') == {'1234567894': 'CONFLICT'}
    evidence(client, deletion)
    assert states_by_inn(client, 'NUMBERS') == {'1234567894': 'APPLIED'}


@pytest.mark.parametrize('main_inn', ['7707083893', '1234567894'])
def test_unfinished_auxiliary_index_does_not_hide_a_repair_dependency(backend, tmp_path, main_inn):
    rows = [returned_row('NUMBERS', '7707083893', 'ИНН отсутствует в таблице MAV клиентов'),
            returned_row('NUMBERS', main_inn, phone='79000000001')]
    client, _, _, _, bundle = prepare(backend, tmp_path, returned_columns('NUMBERS'), rows)
    main = attempt(client, bundle, 'NUMBERS', ordered=False)
    backfill(client, artifact_id=main['artifact_id'])
    evidence(client, main)
    # The unfinished CLIENTS index cannot yet establish whether this INN is related.
    assert states_by_inn(client, 'NUMBERS') == {main_inn: 'CONFLICT'}
    clients = next(row for row in bundle['artifacts'] if row['role'] == 'CLIENTS')
    backfill(client, artifact_id=clients['id'])
    expected = 'CONFLICT' if main_inn == '7707083893' else 'APPLIED'
    assert states_by_inn(client, 'NUMBERS') == {main_inn: expected}
