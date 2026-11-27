"""Approval boundaries use real PostgreSQL and immutable synthetic bundles."""
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select

from app.models import Approval, AuditEvent, ProcessingRun, User
from conftest import new_case
from test_artifact_publication import link_for_read_proof, publish, setup


def prepared(backend, tmp_path):
    client, case, source, revision = setup(backend)
    bundle = publish(backend, source, revision, tmp_path / "bundle")
    set_id = link_for_read_proof(backend, revision, bundle)
    with backend.app.state.sessions() as db:
        run = db.scalar(select(ProcessingRun).where(ProcessingRun.revision_id == UUID(revision)))
        run.summary = json.loads((tmp_path / "bundle/dataset/summary.json").read_text())
        db.commit()
    return client, case, source, revision, set_id, bundle


def approval_body(revision, manifest_hash, operation_id=None):
    return {"operation_id": str(operation_id or uuid4()), "expected_revision_id": revision,
            "manifest_hash": manifest_hash}


def test_approval_persists_exact_decision_and_original_operation_receipt(backend, tmp_path):
    client, case, _, revision, set_id, bundle = prepared(backend, tmp_path)
    body = approval_body(revision, bundle.manifest_hash)
    path = f"/api/cases/{case}/approval"
    response = client.post(path, json=body)
    assert response.status_code == 200
    original = response.json()
    decision = original["result"]["approval"]
    assert decision["revision_id"] == revision
    assert decision["artifact_set_id"] == str(set_id)
    assert decision["manifest_hash"] == bundle.manifest_hash
    assert decision["author_id"] and decision["created_at"]
    assert client.post(path, json=body).json() == original
    recovered = client.get("/api/operations", params={"case_id": case, "action": "package.approve",
                                                    "operation_id": body["operation_id"]})
    assert recovered.json() == original
    read = client.get(f"/api/cases/{case}/revisions/{revision}/approval")
    assert read.status_code == 200 and read.json()["approval"] == decision
    assert read.json()["current"] and read.json()["approved"]
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(Approval)) == 1
        saved = db.get(Approval, UUID(decision["id"]))
        assert saved.revision_id == UUID(revision) and saved.artifact_set_id == set_id
        audit = db.scalars(select(AuditEvent).where(AuditEvent.action == "package.approve")).all()
        assert len(audit) == 1 and audit[0].details["manifest_hash"] == bundle.manifest_hash
    assert client.get(f"/api/cases/{case}").json()["external_state"] == "NOT_SUBMITTED"


def save_body(source, revision):
    return {"operation_id": str(uuid4()), "expected_revision_id": revision, "source_asset_id": source,
            "corrections": [], "overrides": [{"field": "SPREADING", "before": "0", "after": "1",
                                              "reason": "Synthetic current revision change"}]}


@pytest.mark.parametrize("same_key", [True, False])
def test_concurrent_same_or_different_keys_create_one_exact_set_decision(backend, tmp_path, same_key):
    _, case, _, revision, _, bundle = prepared(backend, tmp_path)
    clients = [backend.client(), backend.client()]
    first = approval_body(revision, bundle.manifest_hash)
    bodies = [first, first if same_key else approval_body(revision, bundle.manifest_hash)]
    barrier = Barrier(2)

    def call(index):
        barrier.wait(timeout=5)
        return clients[index].post(f"/api/cases/{case}/approval", json=bodies[index])

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(call, range(2)))
    assert [response.status_code for response in responses] == [200, 200]
    assert responses[0].json()["result"]["approval"] == responses[1].json()["result"]["approval"]
    if same_key:
        assert responses[0].json() == responses[1].json()
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(Approval)) == 1
        assert db.scalar(select(func.count()).select_from(AuditEvent).where(
            AuditEvent.action == "package.approve")) == 1


def test_original_receipt_replays_after_edit_without_approving_new_head(backend, tmp_path):
    client, case, source, revision, _, bundle = prepared(backend, tmp_path)
    body = approval_body(revision, bundle.manifest_hash)
    path = f"/api/cases/{case}/approval"
    original = client.post(path, json=body).json()
    changed = client.post(f"/api/cases/{case}/revisions", json=save_body(source, revision))
    assert changed.status_code == 200
    head = changed.json()["result"]["revision"]["id"]
    assert client.post(path, json=body).json() == original
    conflict = client.post(path, json={**body, "expected_revision_id": head})
    assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "operation_body_conflict"
    stale = client.post(path, json=approval_body(revision, bundle.manifest_hash))
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "revision_conflict"
    old = client.get(f"/api/cases/{case}/revisions/{revision}/approval").json()
    assert not old["current"] and not old["approved"] and old["approval"] == original["result"]["approval"]
    current = client.get(f"/api/cases/{case}/revisions/{head}/approval").json()
    assert current["current"] and not current["approved"] and current["approval"] is None
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(Approval)) == 1


def test_save_and_approval_race_serializes_to_one_valid_result(backend, tmp_path):
    _, case, source, revision, _, bundle = prepared(backend, tmp_path)
    approve_client, save_client = backend.client(), backend.client()
    barrier = Barrier(2)

    def approve_call():
        barrier.wait(timeout=5)
        return approve_client.post(f"/api/cases/{case}/approval", json=approval_body(revision, bundle.manifest_hash))

    def save_call():
        barrier.wait(timeout=5)
        return save_client.post(f"/api/cases/{case}/revisions", json=save_body(source, revision))

    with ThreadPoolExecutor(max_workers=2) as pool:
        approving, saving = pool.submit(approve_call), pool.submit(save_call)
        approved, saved = approving.result(timeout=10), saving.result(timeout=10)
    assert saved.status_code == 200
    assert approved.status_code in {200, 409}
    head = saved.json()["result"]["revision"]["id"]
    state = save_client.get(f"/api/cases/{case}/revisions/{head}/approval").json()
    assert state["current"] and not state["approved"] and state["approval"] is None
    with backend.app.state.sessions() as db:
        decisions = db.scalars(select(Approval)).all()
        assert len(decisions) == int(approved.status_code == 200)
        assert all(decision.revision_id == UUID(revision) for decision in decisions)
    if approved.status_code == 409:
        assert approved.json()["error"]["code"] == "revision_conflict"


def test_manifest_permission_and_scope_are_checked_on_server(backend, tmp_path):
    client, case, _, revision, _, bundle = prepared(backend, tmp_path)
    path = f"/api/cases/{case}/approval"
    wrong = client.post(path, json=approval_body(revision, "0" * 64))
    assert wrong.status_code == 409 and wrong.json()["error"]["code"] == "manifest_conflict"
    other = backend.client("other")
    assert other.post(path, json=approval_body(revision, bundle.manifest_hash)).status_code == 404
    own_other_case = new_case(client)
    assert client.post(f"/api/cases/{own_other_case}/approval", json=approval_body(
        revision, bundle.manifest_hash)).status_code == 404
    assert other.get(f"/api/cases/{case}/revisions/{revision}/approval").status_code == 404
    with backend.app.state.sessions() as db:
        operator = db.scalar(select(User).where(User.username == "operator"))
        operator.permissions = [value for value in operator.permissions if value != "package.approve"]
        db.commit()
    denied = client.post(path, json=approval_body(revision, bundle.manifest_hash))
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "permission_denied"
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(Approval)) == 0


@pytest.mark.parametrize("fault", ["state", "blockers", "coverage", "generation", "missing_csv"])
def test_ineligible_or_incomplete_set_never_gets_decision(backend, tmp_path, fault):
    client, case, _, revision, _, bundle = prepared(backend, tmp_path)
    with backend.app.state.sessions() as db:
        run = db.scalar(select(ProcessingRun).where(ProcessingRun.revision_id == UUID(revision)))
        if fault == "state":
            run.state = "PROCESSING"
        elif fault == "blockers":
            run.summary = {**run.summary, "blocking": True}
        elif fault == "coverage":
            run.summary = {**run.summary, "reconciliation": {"complete": False}}
        elif fault == "generation":
            run.generation += 1
        db.commit()
    if fault == "missing_csv":
        backend.app.state.storage.path_for_key(bundle.artifacts[1].storage_key).unlink()
    response = client.post(f"/api/cases/{case}/approval", json=approval_body(revision, bundle.manifest_hash))
    assert response.status_code == (503 if fault in {"coverage", "missing_csv"} else 409)
    with backend.app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(Approval)) == 0
