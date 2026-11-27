import json

import pytest

from app.storage.local import LocalStorage, StorageFailure
from app.storage.pages import publish_pages


def test_deep_row_has_all_messages_deduplicated_and_identity_checked(tmp_path, monkeypatch):
    from app.storage.pages import read_record_issues
    storage = LocalStorage(tmp_path / 'store')
    rows = [{'page_index': i, 'ordinal': (i + 1) // 2, 'record_id': str((i + 1) // 2),
             'field': 'INN' if i % 2 else 'MAV_LABEL_LATIN', 'scope': 'cell',
             'code': 'invalid', 'message': 'Ошибка ИНН' if i % 2 else 'Ошибка этикетки'}
            for i in range(1, 1003)]
    rows.append({**rows[-1], 'page_index': 1003})
    descriptor = publish_pages(rows, tmp_path, storage, role='issues', chunk_rows=500)
    index = json.loads(storage.path_for_key(descriptor['key']).read_bytes())
    verify = storage.verify
    def bounded(key, digest, size):
        assert key not in {chunk['key'] for chunk in index['chunks'][:2]}
        return verify(key, digest, size)
    monkeypatch.setattr(storage, 'verify', bounded)
    expected = [{'field': 'INN', 'scope': 'cell', 'code': 'invalid', 'message': 'Ошибка ИНН'},
                {'field': 'MAV_LABEL_LATIN', 'scope': 'cell', 'code': 'invalid', 'message': 'Ошибка этикетки'}]
    assert read_record_issues(storage, descriptor, [{'ordinal': 501, 'record_id': '501'}]) == {'501': expected}
    assert read_record_issues(storage, descriptor, [{'ordinal': 501, 'record_id': 'other'}]) == {'other': []}
    storage.path_for_key(index['chunks'][-1]['key']).write_bytes(b'[]')
    with pytest.raises(StorageFailure):
        read_record_issues(storage, descriptor, [{'ordinal': 501, 'record_id': '501'}])


def test_legacy_parquet_review_attaches_full_row_owned_messages_and_fails_closed(tmp_path):
    from types import SimpleNamespace
    from app.api.review import owned_record_issues
    from app.domain.canonical import publish_dataset, read_dataset_index
    from test_projections import make_dataset
    dataset = make_dataset(tmp_path / 'source', [['bad', '001900', 'Latin', 'Кириллица', 'wrong', '0']])
    storage = LocalStorage(tmp_path / 'store')
    key = publish_dataset(dataset, storage)
    index = read_dataset_index(storage, key)
    assert 'pages' not in index
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(storage=storage,
        settings=SimpleNamespace(dataset_memory_limit='128MiB', dataset_threads=1))))
    records = dataset.page('records')['items']
    issues = owned_record_issues(request, index, records)[records[0]['record_id']]
    assert {issue['field'] for issue in issues} == {'INN', 'MAV_LABEL_NAME', 'MAV_LABEL_LATIN', 'IS_MAV'}
    assert all(issue['message'] for issue in issues)
    assert owned_record_issues(request, index, [{**records[0], 'record_id': 'other'}]) == {'other': []}
    storage.path_for_key(index['objects']['issues']['key']).write_bytes(b'corrupt')
    with pytest.raises(StorageFailure):
        owned_record_issues(request, index, records)
