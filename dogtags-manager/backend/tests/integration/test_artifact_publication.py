"""Real CSV/ZIP/filesystem/PG boundaries; U6 alone will provide fenced worker publication."""
import errno
import hashlib
import os
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select

from app.domain.canonical import build_dataset
from app.models import Artifact, ArtifactSet, ProcessingRevision, ProcessingRun, SourceAsset
from app.storage.local import StagedObject, StorageFailure
from conftest import new_case, upload

SOURCE = ("INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\r\n"
          "1234567894;001900;Тест;Test;1;1\r\n1234567894;002900;Тест;Test;0;0\r\n").encode()


def test_cross_volume_publication_copies_verified_bytes_before_atomic_link(backend, tmp_path, monkeypatch):
    path = tmp_path / "separate-scratch-volume.csv"
    payload = b"independent immutable synthetic bytes\r\n"
    path.write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    staged = StagedObject(path, digest, len(payload))
    actual_link = os.link

    def separate_volume_link(source, destination):
        if source == path:
            raise OSError(errno.EXDEV, "Synthetic separate volume boundary")
        return actual_link(source, destination)

    monkeypatch.setattr(os, "link", separate_volume_link)
    storage = backend.app.state.storage
    key = storage.publish(staged)
    assert storage.verify(key, digest, len(payload)).read_bytes() == payload
    assert storage.publish(staged) == key
    assert path.read_bytes() == payload
    assert not list((storage.root / ".staging").glob("*/publish"))
    corrupt = tmp_path / "corrupt-scratch.csv"
    corrupt.write_bytes(b"not declared bytes")
    monkeypatch.setattr(os, "link", lambda source, destination: (_ for _ in ()).throw(
        OSError(errno.EXDEV, "Synthetic separate volume boundary")) if source == corrupt else actual_link(source, destination))
    with pytest.raises(StorageFailure):
        storage.publish(StagedObject(corrupt, "a" * 64, len(payload)))
    assert not storage.path_for_key(storage.key_for_hash("a" * 64)).exists()


def setup(backend, *, legacy=False, data=SOURCE):
    client = backend.client()
    case = new_case(client)
    if legacy:
        from sqlalchemy import event
        from app.domain.operations import canonical_digest
        def historical_configuration(mapper, connection, revision):
            revision.settings = {}
            revision.config_hash = canonical_digest({'profile': revision.profile_snapshot,
                'settings': {}, 'correction_overlay': []})
        event.listen(ProcessingRevision, 'before_insert', historical_configuration)
        try:
            result = upload(client, case, data=data).json()['result']
        finally:
            event.remove(ProcessingRevision, 'before_insert', historical_configuration)
    else:
        result = upload(client, case, data=data).json()["result"]
    return client, case, result["source"]["id"], result["revision"]["id"]


def publish(backend, source_id, revision_id, directory):
    from app.storage.artifact_sets import publish_artifact_bundle

    with backend.app.state.sessions() as db:
        revision = db.get(ProcessingRevision, UUID(revision_id))
        source = db.get(SourceAsset, UUID(source_id))
        dataset = build_dataset(backend.app.state.storage.verify(source.storage_key, source.sha256, source.size_bytes),
                                source.encoding, source.id, directory / "dataset", revision.profile_snapshot,
                                settings=revision.settings, correction_overlay=revision.correction_overlay, chunk_rows=1)
        return publish_artifact_bundle(dataset, revision, source, backend.app.state.storage, directory / "export")


def link_for_read_proof(backend, revision_id, bundle):
    from app.storage.artifact_sets import link_artifact_bundle

    with backend.app.state.sessions() as db:
        revision = db.get(ProcessingRevision, UUID(revision_id))
        run = ProcessingRun(case_id=revision.case_id, revision_id=revision.id, work_identity=uuid4().hex,
                            state="RUNNING", generation=1)
        db.add(run)
        db.flush()
        result = link_artifact_bundle(db, revision, run, bundle, backend.app.state.storage)
        db.flush()
        assert run.state == "RUNNING"  # Helper cannot declare worker success.
        run.state = "PREPARED"  # Synthetic read fixture only, not U6 fencing/worker proof.
        db.commit()
        return result.id


def test_two_independent_attempts_have_same_names_bytes_manifest_and_no_db_success(backend, tmp_path):
    client, case, source, revision = setup(backend)
    first = publish(backend, source, revision, tmp_path / "attempt-a")
    second = publish(backend, source, revision, tmp_path / "attempt-b")
    assert first.manifest == second.manifest and first.manifest_hash == second.manifest_hash
    assert first.manifest["counts"] == {"CLIENTS": 1, "DOGTAGS": 1, "NUMBERS": 2}
    assert [obj.role for obj in first.artifacts] == ["CLIENTS", "DOGTAGS", "NUMBERS", "ZIP"]
    assert [(obj.download_filename, obj.sha256, obj.size_bytes) for obj in first.artifacts] == [
        (obj.download_filename, obj.sha256, obj.size_bytes) for obj in second.artifacts]
    assert all(backend.app.state.storage.path_for_key(left.storage_key).read_bytes() ==
               backend.app.state.storage.path_for_key(right.storage_key).read_bytes()
               for left, right in zip(first.artifacts, second.artifacts, strict=True))
    assert not any(key in str(first.manifest) for key in ("storage_key", "attempt_id", "run_id", "manifest_hash"))
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(ArtifactSet)) == 0
        assert db.scalar(select(func.count()).select_from(Artifact)) == 0
        assert db.scalar(select(func.count()).select_from(ProcessingRun)) == 0
    response = client.get(f"/api/cases/{case}/revisions/{revision}/artifacts")
    assert response.status_code == 200 and response.json()["available"] is False


def test_complete_bundle_links_immutably_reuses_set_and_scoped_paged_preview(backend, tmp_path):
    from app.storage.artifact_sets import link_artifact_bundle

    client, case, source, revision = setup(backend)
    bundle = publish(backend, source, revision, tmp_path / "attempt")
    set_id = link_for_read_proof(backend, revision, bundle)
    with backend.app.state.sessions() as db:
        saved_revision = db.get(ProcessingRevision, UUID(revision))
        saved_run = db.scalar(select(ProcessingRun).where(ProcessingRun.revision_id == saved_revision.id))
        assert link_artifact_bundle(db, saved_revision, saved_run, bundle, backend.app.state.storage).id == set_id
        db.commit()
        assert db.scalar(select(func.count()).select_from(ArtifactSet)) == 1
        assert db.scalar(select(func.count()).select_from(Artifact)) == 4
    path = f"/api/cases/{case}/revisions/{revision}/artifacts"
    response = client.get(path)
    assert response.status_code == 200
    result = response.json()
    assert result["manifest"] == bundle.manifest and result["manifest_hash"] == bundle.manifest_hash
    assert [obj["role"] for obj in result["artifacts"]] == ["CLIENTS", "DOGTAGS", "NUMBERS", "ZIP"]
    assert "storage_key" not in response.text
    numbers_id = result["artifacts"][2]["id"]
    preview_path = path + f"/{numbers_id}/preview"
    page = client.get(preview_path, params={"limit": 1}).json()
    assert page["columns"] == ["INN", "MAV_LABEL_NAME", "MSISDN", "IS_MAV", "IS_KSS", "SPREADING", "INTERNAL_OPERATOR_NAME"]
    assert page["items"] == [["1234567894", "Тест", "001900", "1", "1", "0", "hubRTK"]]
    assert page["next_cursor"] == 1
    assert client.get(preview_path, params={"after": 1, "limit": 1}).json()["items"][0][2] == "002900"
    assert client.get(preview_path, params={"limit": 501}).status_code == 422
    other = backend.client("other")
    for endpoint in (path, preview_path):
        denied = other.get(endpoint)
        assert denied.status_code == 404 and "001900" not in denied.text
    own_other_case = new_case(client)
    assert client.get(f"/api/cases/{own_other_case}/revisions/{revision}/artifacts").status_code == 404
    assert client.get(path + f"/{uuid4()}/preview").status_code == 404


def test_one_file_encoding_failure_keeps_complete_set_unavailable(backend, tmp_path):
    from app.domain.serialization import SerializationFailure

    client, case, source, revision = setup(backend)
    payload = {"operation_id": str(uuid4()), "expected_revision_id": revision, "source_asset_id": source,
               "corrections": [], "overrides": [{"field": "INTERNAL_OPERATOR_NAME", "before": "hubRTK",
                                                   "after": "operator🙂", "reason": "Synthetic override"}]}
    changed = client.post(f"/api/cases/{case}/revisions", json=payload)
    assert changed.status_code == 200
    head = changed.json()["result"]["revision"]["id"]
    with pytest.raises(SerializationFailure) as error:
        publish(backend, source, head, tmp_path / "bad-attempt")
    assert error.value.diagnostics[0]["field"] == "INTERNAL_OPERATOR_NAME"
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(ArtifactSet)) == 0
        assert db.scalar(select(func.count()).select_from(Artifact)) == 0
        assert db.scalar(select(func.count()).select_from(ProcessingRun)) == 0
    assert client.get(f"/api/cases/{case}/revisions/{head}/artifacts").json()["available"] is False


@pytest.mark.parametrize("fault", ["missing", "mismatch"])
def test_existing_blob_integrity_failure_is_not_silently_repaired(backend, tmp_path, fault):
    from app.storage.artifact_sets import verify_artifact_set

    client, case, source, revision = setup(backend)
    bundle = publish(backend, source, revision, tmp_path / "first")
    set_id = link_for_read_proof(backend, revision, bundle)
    obj = bundle.artifacts[0]
    path = backend.app.state.storage.path_for_key(obj.storage_key)
    if fault == "missing":
        path.unlink()
    else:
        path.write_bytes(b"wrong immutable bytes")
    with backend.app.state.sessions() as db:
        with pytest.raises(StorageFailure):
            verify_artifact_set(db, db.get(ArtifactSet, set_id), backend.app.state.storage)
    response = client.get(f"/api/cases/{case}/revisions/{revision}/artifacts")
    assert response.status_code == 503 and response.json()["error"]["code"] == "artifact_integrity_error"
    if fault == "mismatch":
        with pytest.raises(StorageFailure):
            publish(backend, source, revision, tmp_path / "late")
        assert path.read_bytes() == b"wrong immutable bytes"


def test_both_revision_creation_paths_capture_new_stable_export_components(backend):
    client, case, source, first = setup(backend)
    initial = client.get(f"/api/cases/{case}/revisions/{first}").json()
    components = initial["filename_components"]
    assert components == {"source_filename": "synthetic.csv", "partner": "RTK-HUB", "operation": "MARKING",
                          "request": case, "revision": f"r1-{first}", "stage": "PREPARED"}
    changed = client.post(f"/api/cases/{case}/revisions", json={"operation_id": str(uuid4()),
                          "expected_revision_id": first, "source_asset_id": source, "corrections": [], "overrides": []})
    assert changed.status_code == 200
    second = changed.json()["result"]["revision"]
    assert second["filename_components"]["revision"] == f"r2-{second['id']}"
    replacement = upload(client, case, data=SOURCE, expected=second["id"]).json()["result"]["revision"]
    assert replacement["filename_components"]["revision"] == f"r3-{replacement['id']}"
    assert client.get(f"/api/cases/{case}/revisions/{first}").json() == initial
