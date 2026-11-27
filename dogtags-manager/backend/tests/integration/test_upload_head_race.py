"""The second upload lock must observe a head committed during raw publication."""
import hashlib
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import uuid4

from sqlalchemy import func, select

from app.models import ProcessingRevision, SourceAsset
from conftest import CSV_BYTES, new_case, upload


def test_competing_upload_after_pending_commit_returns_conflict_and_failed_receipt(backend, monkeypatch):
    first, second = backend.client(), backend.client()
    case, key = new_case(first), uuid4()
    publication_started, release = Event(), Event()
    storage = backend.app.state.storage
    publish = storage.publish
    first_hash = hashlib.sha256(CSV_BYTES).hexdigest()

    def held_publish(staged):
        if staged.sha256 == first_hash:
            publication_started.set()
            assert release.wait(10), "competing upload did not release publication"
        return publish(staged)

    monkeypatch.setattr(storage, "publish", held_publish)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(upload, first, case, operation_id=key)
        try:
            assert publication_started.wait(10)
            receipt = second.get("/api/operations", params={"operation_id": str(key),
                "action": "source.upload", "case_id": case})
            assert receipt.status_code == 200 and receipt.json()["status"] == "RUNNING"
            competing = upload(second, case, data=CSV_BYTES.replace(b"Test", b"Competing"))
            assert competing.status_code == 200
        finally:
            release.set()
        response = pending.result(timeout=10)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "revision_conflict"
    receipt = first.get("/api/operations", params={"operation_id": str(key),
        "action": "source.upload", "case_id": case})
    assert receipt.status_code == 200 and receipt.json()["status"] == "FAILED"
    assert receipt.json()["error"]["code"] == "revision_conflict"
    assert first.get(f"/api/cases/{case}").json()["head_revision_id"] == competing.json()["result"]["revision"]["id"]
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(ProcessingRevision)) == 1
        assert db.scalar(select(func.count()).select_from(SourceAsset)) == 1
