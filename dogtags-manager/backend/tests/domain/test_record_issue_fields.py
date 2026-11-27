import pytest

from app.storage.local import LocalStorage, StorageFailure
from app.storage.pages import publish_pages, read_issue_fields


def test_row_fields_use_only_verified_chunks_covering_the_visible_records(tmp_path, monkeypatch):
    storage = LocalStorage(tmp_path / 'store')
    descriptor = publish_pages([
        {'page_index': i, 'ordinal': (i + 1) // 2, 'record_id': str((i + 1) // 2),
         'field': 'MAV_LABEL' if i % 2 else 'MAV_LABEL_LATIN'}
        for i in range(1, 1003)], tmp_path, storage, role='issues', chunk_rows=500)
    import json
    index = json.loads(storage.path_for_key(descriptor['key']).read_bytes())
    original_verify = storage.verify
    def verify(key, digest, size):
        assert key not in {chunk['key'] for chunk in index['chunks'][:2]}
        return original_verify(key, digest, size)
    monkeypatch.setattr(storage, 'verify', verify)
    assert read_issue_fields(storage, descriptor, [{'ordinal': 501, 'record_id': '501'}]) == {
        '501': ['MAV_LABEL', 'MAV_LABEL_LATIN']}
    assert read_issue_fields(storage, descriptor, [{'ordinal': 501, 'record_id': 'wrong'}]) == {'wrong': []}
    storage.path_for_key(index['chunks'][-1]['key']).write_bytes(b'[]')
    with pytest.raises(StorageFailure):
        read_issue_fields(storage, descriptor, [{'ordinal': 501, 'record_id': '501'}])
