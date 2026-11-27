"""Immutable administrative publication uses a privilege absent from operators."""
import copy

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from app.admin.publish_rules import active_snapshot, publish_rules
from app.domain.rules import profile_for, seed_config
from app.errors import ApiError
from app.models import RulePublication, SourceProfileVersion, User


def test_publication_permission_idempotence_and_old_snapshot(backend):
    with backend.app.state.sessions() as db:
        user = db.scalar(select(User).where(User.username == 'operator'))
        with pytest.raises(ApiError) as denied:
            publish_rules(db, user, seed_config(), reason='Supplied contracts')
        assert denied.value.status == 403
        user.permissions = [*user.permissions, 'rules.publish']
        first = publish_rules(db, user, seed_config(), reason='Supplied contracts')
        assert publish_rules(db, user, seed_config(), reason='Repeated command').id == first.id
        original = active_snapshot(db)
        changed = seed_config()
        changed['profiles']['RTK HUB']['INTERNAL_OPERATOR_NAME'] = 'changed'
        with pytest.raises(ValueError):
            publish_rules(db, user, changed, reason='Forbidden key reuse')
        changed['version'] = 'v' * 120
        publish_rules(db, user, changed, reason='Explicit new synthetic version')
        assert active_snapshot(db)['version'] == 'v' * 120
        assert profile_for(original, 'RTK HUB')['INTERNAL_OPERATOR_NAME'] == 'hubRTK'
        assert first.created_by == user.id and first.reason == 'Supplied contracts'
        assert len(db.scalars(select(SourceProfileVersion)).all()) >= 6
        db.commit()
    with backend.engine.begin() as connection:
        with pytest.raises(DBAPIError):
            with connection.begin_nested():
                connection.execute(text('UPDATE rule_publications SET reason = :reason'), {'reason': 'tamper'})
        with pytest.raises(DBAPIError):
            with connection.begin_nested():
                connection.execute(text('DELETE FROM rule_publications'))


def test_bad_examples_and_disabled_publisher_do_not_publish(backend):
    with backend.app.state.sessions() as db:
        user = db.scalar(select(User).where(User.username == 'operator'))
        user.permissions = [*user.permissions, 'rules.publish']
        invalid = copy.deepcopy(seed_config())
        invalid['statuses'] = [{'value': 'SYNTHETIC_OK', 'classification': 'success'}]
        with pytest.raises(ValueError):
            publish_rules(db, user, invalid, reason='Missing example')
        assert db.scalar(select(RulePublication)) is None
        user.active = False
        with pytest.raises(ApiError):
            publish_rules(db, user, seed_config(), reason='Inactive publisher')


def test_normalized_value_can_be_corrected_through_api_without_changing_rules(backend, tmp_path):
    from uuid import UUID, uuid4
    from app.admin.publish_rules import published_profile
    from app.domain.canonical import build_dataset, publish_dataset
    from app.domain.manifest import capture_filename_components
    from app.models import Case, ProcessingRevision, ProcessingRun, SourceAsset
    from conftest import new_case, upload

    client = backend.client()
    case_id = UUID(new_case(client))
    data = ('INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n'
            '7707083893;79000000000;Тeст;Test;0;1\n').encode()
    response = upload(client, case_id, data=data)
    assert response.status_code == 200
    original_id = UUID(response.json()['result']['revision']['id'])
    config = seed_config()
    config['version'] = 'synthetic-normalization-v1'
    config['normalizations'] = [{'id': 'synthetic-label', 'field': 'MAV_LABEL_NAME',
                                 'before': 'Тeст', 'after': 'Тест'}]
    config['examples'] = [{'kind': 'normalization', 'rule_id': 'synthetic-label',
                           'before': 'Тeст', 'after': 'Тест'}]
    with backend.app.state.sessions() as db:
        case = db.get(Case, case_id)
        user = db.get(User, case.owner_id)
        user.permissions = [*user.permissions, 'rules.publish']
        snapshot = publish_rules(db, user, config, reason='Synthetic correction test').snapshot
        profile = published_profile(db, snapshot, 'RTK ABC')
        original = db.get(ProcessingRevision, original_id)
        source = db.get(SourceAsset, original.source_asset_id)
        revision_id, source_id = uuid4(), source.id
        revision = ProcessingRevision(id=revision_id, case_id=case.id, source_asset_id=source.id,
            parent_revision_id=original.id, sequence=2, created_by=user.id, profile_version_id=profile.id,
            profile_snapshot=profile.snapshot, settings={'rules_snapshot': snapshot}, config_hash='b' * 64,
            rules_version='published-rules-v1', export_timezone='Europe/Moscow',
            filename_components=capture_filename_components(case.id, revision_id, 2, source.filename))
        db.add(revision)
        db.flush()
        case.head_revision_id = revision_id
        db.commit()
    url = f'/api/cases/{case_id}/revisions/{revision_id}'
    draft = client.get(url + '/records')
    assert draft.status_code == 200
    row = draft.json()['items'][0]
    detail_url = url + f"/records/{row['record_id']}?ordinal=1"
    assert client.get(detail_url).json()['normalizations'][0]['before'] == 'Тeст'
    assert row['effective']['MAV_LABEL_NAME'] == 'Тест'
    assert row['raw_cells'][2] == 'Тeст'
    storage = backend.app.state.storage
    dataset = build_dataset(storage.path_for_key(source.storage_key), source.encoding, source_id,
                            tmp_path / 'normalized-dataset', profile.snapshot, settings={'rules_snapshot': snapshot})
    with backend.app.state.sessions() as db:
        db.add(ProcessingRun(case_id=case_id, revision_id=revision_id, work_identity=uuid4().hex,
                             state='PREPARED', dataset_key=publish_dataset(dataset, storage), summary=dataset.summary))
        db.commit()
    assert client.get(url + '/records').json()['items'][0]['effective'] == row['effective']
    assert client.get(detail_url).json()['normalizations'][0]['after'] == 'Тест'
    response = client.post(f'/api/cases/{case_id}/revisions', json={
        'operation_id': str(uuid4()), 'expected_revision_id': str(revision_id), 'source_asset_id': str(source_id),
        'corrections': [{'record_id': row['record_id'], 'ordinal': 1, 'field': 'MAV_LABEL_NAME',
                         'before': 'Тест', 'after': 'Проверено', 'reason': 'Synthetic manual correction'}]})
    assert response.status_code == 200, response.text
    newer = response.json()['result']['revision']
    assert newer['settings']['rules_snapshot'] == snapshot
    updated = client.get(f"/api/cases/{case_id}/revisions/{newer['id']}/records").json()['items'][0]
    assert updated['effective']['MAV_LABEL_NAME'] == 'Проверено'
    with backend.app.state.sessions() as db:
        stored = db.get(ProcessingRevision, UUID(newer['id']))
        assert stored.filename_components['partner'] == 'RTK-ABC'
        assert len(db.scalars(select(RulePublication)).all()) == 1
