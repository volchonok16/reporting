from app.linked_errors import parent_zni_id_from_error_payload


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
