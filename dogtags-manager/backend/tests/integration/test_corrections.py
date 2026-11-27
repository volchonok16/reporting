"""Real PostgreSQL, immutable raw files and domain output; no worker success is simulated."""
from uuid import UUID, uuid4

from sqlalchemy import func, select

from app.domain.canonical import build_dataset, publish_dataset
from app.models import ProcessingRevision, ProcessingRun, SourceAsset, User
from conftest import new_case, upload

HEADER = "INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\n"
ROW = "1234567894;89000000000;Тест;Test;1;1\n"
SOURCE = (HEADER + ROW + ROW).encode()


def setup_source(backend):
    client = backend.client()
    case = new_case(client)
    uploaded = upload(client, case, data=SOURCE).json()["result"]
    return client, case, uploaded["source"]["id"], uploaded["revision"]["id"]


def page(client, case, revision, **params):
    return client.get(f"/api/cases/{case}/revisions/{revision}/records", params=params)


def body(source, head, record, field="MSISDN", before="89000000000", after="900"):
    return {"operation_id": str(uuid4()), "expected_revision_id": head, "source_asset_id": source,
            "corrections": [{"record_id": record["record_id"], "ordinal": record["ordinal"],
                             "field": field, "before": before, "after": after,
                             "reason": "Synthetic operator-confirmed value"}], "overrides": []}


def save(client, case, payload):
    return client.post(f"/api/cases/{case}/revisions", json=payload)


def test_second_correction_preserves_first_and_identity_raw_and_history(backend, tmp_path):
    client, case, source, first = setup_source(backend)
    original = page(client, case, first)
    assert original.status_code == 200
    record = original.json()["items"][0]
    first_body = body(source, first, record, "INN", "1234567894", "123456789047")
    changed = save(client, case, first_body)
    assert changed.status_code == 200
    second = changed.json()["result"]["revision"]["id"]
    assert save(client, case, first_body).json() == changed.json()
    new_record = page(client, case, second).json()["items"][0]
    assert new_record["record_id"] == record["record_id"]
    assert new_record["effective"]["INN"] == "123456789047"
    third = save(client, case, body(source, second, new_record))
    assert third.status_code == 200
    snapshot = third.json()["result"]["revision"]
    assert [change["field"] for change in snapshot["correction_overlay"]] == ["INN", "MSISDN"]
    assert all(change["author_id"] and change["created_at"].endswith("+00:00")
               and change["reason"] for change in snapshot["correction_overlay"])
    current = page(client, case, snapshot["id"]).json()["items"]
    assert current[0]["effective"]["INN"] == "123456789047"
    assert current[0]["effective"]["MSISDN"] == "900"
    assert current[1]["effective"]["MSISDN"] == "89000000000"
    assert current[0]["record_id"] == record["record_id"]
    assert client.get(f"/api/cases/{case}/sources/{source}/raw").content == SOURCE
    old = client.get(f"/api/cases/{case}/revisions/{first}").json()
    assert old["correction_overlay"] == []
    with backend.app.state.sessions() as db:
        revision = db.get(ProcessingRevision, UUID(snapshot["id"]))
        asset = db.get(SourceAsset, UUID(source))
        result = build_dataset(backend.app.state.storage.path_for_key(asset.storage_key), asset.encoding,
                               asset.id, tmp_path / "recomputed", revision.profile_snapshot,
                               settings=revision.settings, correction_overlay=revision.correction_overlay,
                               chunk_rows=1)
        assert result.summary["blocking"] is False
        assert result.summary["counts"]["NUMBERS"] == 2
        assert db.scalar(select(func.count()).select_from(ProcessingRevision)) == 3


def test_stale_head_before_value_and_changed_operation_body_conflict(backend):
    client, case, source, head = setup_source(backend)
    record = page(client, case, head).json()["items"][0]
    payload = body(source, head, record)
    response = save(client, case, payload)
    assert response.status_code == 200
    current = response.json()["result"]["revision"]["id"]
    assert save(client, case, body(source, head, record, after="901")).status_code == 409
    assert save(client, case, body(source, current, record, before="89000000000", after="901")).status_code == 409
    assert save(client, case, {**payload, "corrections": [{**payload["corrections"][0], "after": "902"}]}).status_code == 409
    assert client.get(f"/api/cases/{case}").json()["head_revision_id"] == current
    assert client.get(f"/api/cases/{case}/sources/{source}/raw").content == SOURCE


def test_foreign_case_source_record_ids_never_return_values(backend):
    client, case, source, head = setup_source(backend)
    other = backend.client("other")
    foreign_case = new_case(other)
    foreign = upload(other, foreign_case, data=SOURCE).json()["result"]
    record = page(client, case, head).json()["items"][0]
    foreign_record = page(other, foreign_case, foreign["revision"]["id"]).json()["items"][0]
    paths = [f"/api/cases/{case}/revisions/{head}/records", f"/api/cases/{case}/revisions/{head}/issues",
             f"/api/cases/{case}/revisions/{head}/review",
             f"/api/cases/{case}/revisions/{head}/records/{record['record_id']}?ordinal=1"]
    for path in paths:
        response = other.get(path)
        assert response.status_code == 404
        assert "89000000000" not in response.text and "Тест" not in response.text
    wrong_source = save(client, case, body(foreign["source"]["id"], head, record))
    assert wrong_source.status_code == 404
    wrong_record = save(client, case, body(source, head, foreign_record))
    assert wrong_record.status_code == 404
    assert "89000000000" not in wrong_record.text
    assert client.get(f"/api/cases/{case}/revisions/{head}/records/{foreign_record['record_id']}",
                      params={"ordinal": 1}).status_code == 404


def test_profile_override_is_scoped_permissioned_reasoned_and_immutable(backend):
    client, case, source, head = setup_source(backend)
    original_settings = client.get(f'/api/cases/{case}/revisions/{head}').json()['settings']
    payload = {"operation_id": str(uuid4()), "expected_revision_id": head, "source_asset_id": source,
               "corrections": [], "overrides": [{"field": "SPREADING", "before": "0", "after": "1",
                                                   "reason": "Synthetic accepted spreading"}]}
    with backend.app.state.sessions() as db:
        user = db.scalar(select(User).where(User.username == "operator"))
        user.permissions = ["case.read", "case.edit"]
        db.commit()
    assert save(client, case, payload).status_code == 403
    with backend.app.state.sessions() as db:
        user = db.scalar(select(User).where(User.username == "operator"))
        user.permissions = ["case.read", "case.edit", "profile.override"]
        db.commit()
    assert save(client, case, {**payload, "overrides": [{**payload["overrides"][0], "reason": "  "}]}).status_code == 422
    assert save(client, case, {**payload, "overrides": [{**payload["overrides"][0], "after": "2"}]}).status_code == 422
    assert save(client, case, {**payload, "overrides": [{**payload["overrides"][0], "after": 1}]}).status_code == 422
    response = save(client, case, payload)
    assert response.status_code == 200
    revision = response.json()["result"]["revision"]
    override = revision["settings"]["profile_overrides"]["SPREADING"]
    assert override["before"] == "0" and override["after"] == "1" and override["reason"]
    assert override["scope"] == "revision" and override["profile_value"] == "0"
    assert revision["profile_snapshot"]["SPREADING"] == "0"
    record = page(client, case, revision["id"]).json()["items"][0]
    next_response = save(client, case, body(source, revision["id"], record))
    assert next_response.status_code == 200
    assert next_response.json()["result"]["revision"]["settings"] == revision["settings"]
    assert client.get(f"/api/cases/{case}/revisions/{head}").json()["settings"] == original_settings
    assert 'profile_overrides' not in original_settings


def test_bounded_draft_and_completed_record_issue_pages(backend, tmp_path):
    client, case, source, head = setup_source(backend)
    first = page(client, case, head, limit=1)
    assert first.status_code == 200 and len(first.json()["items"]) == 1
    assert first.json()["next_cursor"] == 1
    second = page(client, case, head, after=1, limit=1).json()
    assert second["items"][0]["ordinal"] == 2 and second["next_cursor"] is None
    assert page(client, case, head, limit=501).status_code == 422
    issues = client.get(f"/api/cases/{case}/revisions/{head}/issues").json()
    assert issues["available"] is False and issues["items"] == []
    with backend.app.state.sessions() as db:
        revision = db.get(ProcessingRevision, UUID(head))
        asset = db.get(SourceAsset, UUID(source))
        result = build_dataset(backend.app.state.storage.path_for_key(asset.storage_key), asset.encoding,
                               asset.id, tmp_path / "dataset", revision.profile_snapshot, chunk_rows=1)
        key = publish_dataset(result, backend.app.state.storage)
        # U4 read endpoint proof: published real domain data, never PREPARED/artifact/approval.
        db.add(ProcessingRun(case_id=UUID(case), revision_id=UUID(head), work_identity=uuid4().hex,
                             state="NEEDS_REVIEW", dataset_key=key, summary=result.summary))
        db.commit()
    review = client.get(f"/api/cases/{case}/revisions/{head}/review").json()
    assert review["dataset_available"] is True and review["summary"]["counts"]["NUMBERS"] == 1
    records = page(client, case, head).json()
    assert [row["disposition"] for row in records["items"]] == ["included", "exact_duplicate"]
    item = records["items"][1]
    detail = client.get(f"/api/cases/{case}/revisions/{head}/records/{item['record_id']}",
                        params={"ordinal": 2})
    assert detail.status_code == 200 and detail.json()["record"]["representative_id"] == records["items"][0]["record_id"]


def test_completed_issues_are_paged_and_link_to_the_original_field(backend, tmp_path):
    client = backend.client()
    case = new_case(client)
    data = (HEADER + "7,84201E+11;900;Тест;Test;;1\n" + ROW).encode()
    uploaded = upload(client, case, data=data).json()["result"]
    head, source = uploaded["revision"]["id"], uploaded["source"]["id"]
    with backend.app.state.sessions() as db:
        revision = db.get(ProcessingRevision, UUID(head))
        asset = db.get(SourceAsset, UUID(source))
        result = build_dataset(backend.app.state.storage.path_for_key(asset.storage_key), asset.encoding,
                               asset.id, tmp_path / "blocked", revision.profile_snapshot, chunk_rows=1)
        db.add(ProcessingRun(case_id=UUID(case), revision_id=UUID(head), work_identity=uuid4().hex,
                             state="BLOCKED", dataset_key=publish_dataset(result, backend.app.state.storage),
                             summary=result.summary))
        db.commit()
    path = f"/api/cases/{case}/revisions/{head}/issues"
    first = client.get(path, params={"limit": 1}).json()
    assert first["available"] is True and len(first["items"]) == 1
    second = client.get(path, params={"after": first["next_cursor"], "limit": 1}).json()
    issues = first["items"] + second["items"]
    assert {issue["code"] for issue in issues} == {"inn_scientific", "flag_value"}
    assert second["next_cursor"] is None
    assert client.get(path, params={"limit": 501}).status_code == 422
    issue = next(issue for issue in issues if issue["field"] == "INN")
    detail = client.get(f"/api/cases/{case}/revisions/{head}/records/{issue['record_id']}",
                        params={"ordinal": issue["ordinal"]}).json()
    assert detail["record"]["effective"]["INN"] == "7,84201E+11"
    assert detail["record"]["disposition"] == "excluded_scientific_inn"
    assert len(detail["issues"]) == 2


def test_correction_saves_without_reason_and_preserves_value_and_audit(backend):
    client, case, source, head = setup_source(backend)
    record = page(client, case, head).json()['items'][0]
    payload = body(source, head, record)
    payload['corrections'][0].pop('reason')
    response = save(client, case, payload)
    assert response.status_code == 200, response.text
    revision = response.json()['result']['revision']
    correction = revision['correction_overlay'][0]
    assert correction['reason'] == '' and correction['author_id'] and correction['created_at']
    assert page(client, case, revision['id']).json()['items'][0]['effective']['MSISDN'] == '900'
    record = page(client, case, revision['id']).json()['items'][0]
    payload = body(source, revision['id'], record, before='900', after='901')
    payload['corrections'][0]['reason'] = ''
    response = save(client, case, payload)
    assert response.status_code == 200, response.text
    assert page(client, case, response.json()['result']['revision']['id']).json()['items'][0]['effective']['MSISDN'] == '901'
