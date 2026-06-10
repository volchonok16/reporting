from app.linked_errors import parent_zni_id_from_error_fields, parent_zni_id_from_error_payload


def test_parent_zni_id_from_error_fields_reads_system_parent() -> None:
    assert parent_zni_id_from_error_fields({"System.Parent": 847358}) == 847358
    assert parent_zni_id_from_error_fields({"System.Parent": "847358"}) == 847358
    assert parent_zni_id_from_error_fields({}) is None


def test_parent_zni_id_from_error_payload_reads_hierarchy_reverse() -> None:
    payload = {
        "id": 99,
        "relations": [
            {
                "rel": "System.LinkTypes.Hierarchy-Reverse",
                "url": "https://tfs.example/tfs/DefaultCollection/Project/_apis/wit/workItems/12345",
            }
        ],
    }
    assert parent_zni_id_from_error_payload(payload) == 12345


def test_parent_zni_id_from_error_payload_prefers_system_parent() -> None:
    payload = {
        "id": 938245,
        "fields": {"System.Parent": 847358},
        "relations": [
            {
                "rel": "System.LinkTypes.Hierarchy-Reverse",
                "url": "https://tfs.example/tfs/Main/_apis/wit/workItems/99999",
            }
        ],
    }
    assert parent_zni_id_from_error_payload(payload) == 847358
