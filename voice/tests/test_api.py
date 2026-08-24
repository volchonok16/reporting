from __future__ import annotations

import csv
import io
import os
import time
import uuid
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient as FastAPITestClient

from backend.config import settings
from backend.main import app, master_service
from backend.models import HEADER


class TestClient(FastAPITestClient):
    def __enter__(self):
        client = super().__enter__()
        from backend.main import auth_service

        payload = auth_service.login_with_reporting_sso(
            email=settings.auth_bootstrap_email,
            is_admin=True,
        )
        self.headers.update(
            {"Authorization": f"Bearer {payload['token']}"}
        )
        return client


def session(prefix: str = "api") -> str:
    return f"{prefix}-{uuid.uuid4()}"


def wait_for_job(
    client: TestClient, job_id: str, session_id: str, timeout: float = 10
) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(
            f"/api/jobs/{job_id}",
            headers={"X-Session-ID": session_id},
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        if payload["status"] in {"completed", "failed", "cancelled"}:
            return payload
        time.sleep(0.02)
    pytest.fail(f"job {job_id} did not finish within {timeout}s")


def upload(
    client: TestClient,
    session_id: str,
    name: str,
    content: bytes,
    content_type: str = "application/octet-stream",
):
    return client.post(
        "/api/uploads",
        headers={"X-Session-ID": session_id},
        files={"file": (name, content, content_type)},
    )


def test_health_and_session_validation() -> None:
    with TestClient(app) as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        response = upload(client, "", "input.csv", b"A,B\n1,2\n", "text/csv")
        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "MISSING_SESSION_ID"


def test_authentication_roles_and_master_permission() -> None:
    from backend.main import auth_service

    with FastAPITestClient(app) as anonymous:
        denied = anonymous.post(
            "/api/uploads",
            headers={"X-Session-ID": session("anonymous")},
            files={"file": ("input.csv", b"A,B\n1,2\n", "text/csv")},
        )
        assert denied.status_code == 401

    email = f"standard-{uuid.uuid4().hex}@example.test"
    login = auth_service.login_with_reporting_sso(email=email, is_admin=False)
    with FastAPITestClient(app) as standard:
        standard.headers.update(
            {"Authorization": f"Bearer {login['token']}"}
        )
        records = standard.get(
            "/api/master/records",
            headers={"X-Session-ID": session("standard")},
        )
        assert records.status_code == 200, records.text


def test_master_lock_blocks_other_users_and_protected_actions() -> None:
    from backend.main import auth_service
    from backend.pg_db import configure, connect

    configure(settings.database_url)
    with connect() as connection:
        connection.execute("DELETE FROM master_edit_lock WHERE id = 1")

    email = f"master-editor-{uuid.uuid4().hex}@example.test"
    owner_session = session("master-lock-owner")
    other_session = session("master-lock-other")
    other_login = auth_service.login_with_reporting_sso(
        email=email,
        is_admin=False,
    )

    with TestClient(app) as owner:
        acquired = owner.post(
            "/api/master/lock",
            headers={"X-Session-ID": owner_session},
        )
        assert acquired.status_code == 200, acquired.text
        assert acquired.json()["ownedByCurrentUser"] is True

        with FastAPITestClient(app) as other:
            other.headers.update(
                {"Authorization": f"Bearer {other_login['token']}"}
            )

            status = other.get(
                "/api/master/lock",
                headers={"X-Session-ID": other_session},
            )
            assert status.status_code == 200, status.text
            assert status.json()["locked"] is True
            assert status.json()["ownedByCurrentUser"] is False
            assert (
                status.json()["owner"]["email"]
                == settings.auth_bootstrap_email
            )

            records = other.get(
                "/api/master/records",
                headers={"X-Session-ID": other_session},
            )
            assert records.status_code == 200, records.text

            blocked_create = other.post(
                "/api/master/records",
                headers={"X-Session-ID": other_session},
                json={
                    "aNumber": "79999999991",
                    "bNumbers": [],
                },
            )
            assert blocked_create.status_code == 423
            assert blocked_create.json()["detail"]["code"] == "MASTER_LOCKED"

            blocked_export = other.get(
                "/api/master/export",
                headers={"X-Session-ID": other_session},
            )
            assert blocked_export.status_code == 423
            assert blocked_export.json()["detail"]["code"] == "MASTER_LOCKED"

            denied_release = other.delete(
                "/api/master/lock",
                headers={"X-Session-ID": other_session},
            )
            assert denied_release.status_code == 423

            logged_out = owner.post(
                "/api/auth/logout",
            )
            assert logged_out.status_code == 200, logged_out.text

            released = other.get(
                "/api/master/lock",
                headers={"X-Session-ID": other_session},
            )
            assert released.status_code == 200, released.text
            assert released.json()["locked"] is False

            acquired_by_other = other.post(
                "/api/master/lock",
                headers={"X-Session-ID": other_session},
            )
            assert acquired_by_other.status_code == 200
            assert acquired_by_other.json()["ownedByCurrentUser"] is True
            other.delete(
                "/api/master/lock",
                headers={"X-Session-ID": other_session},
            )


def test_master_clear_is_voice_admin_only_and_requires_lock(monkeypatch) -> None:
    from backend.main import auth_service
    from backend.pg_db import configure, connect

    configure(settings.database_url)
    with connect() as connection:
        connection.execute("DELETE FROM master_edit_lock WHERE id = 1")

    email = f"master-clear-{uuid.uuid4().hex}@example.test"
    standard_session = session("master-clear-standard")
    voice_admin_session = session("master-clear-voice-admin")
    standard_login = auth_service.login_with_reporting_sso(
        email=email,
        is_admin=True,
        voice_admin=False,
    )
    voice_admin_login = auth_service.login_with_reporting_sso(
        email=f"voice-admin-{uuid.uuid4().hex}@example.test",
        is_admin=False,
        voice_admin=True,
    )

    with FastAPITestClient(app) as standard:
        standard.headers.update(
            {"Authorization": f"Bearer {standard_login['token']}"}
        )
        denied = standard.delete(
            "/api/master/records",
            headers={"X-Session-ID": standard_session},
        )
        assert denied.status_code == 403, denied.text
        assert denied.json()["detail"]["code"] == "VOICE_ADMIN_REQUIRED"
        denied_history = standard.delete(
            "/api/master/history",
            headers={"X-Session-ID": standard_session},
        )
        assert denied_history.status_code == 403, denied_history.text
        assert denied_history.json()["detail"]["code"] == "VOICE_ADMIN_REQUIRED"

    with FastAPITestClient(app) as voice_admin:
        voice_admin.headers.update(
            {"Authorization": f"Bearer {voice_admin_login['token']}"}
        )
        missing_lock = voice_admin.delete(
            "/api/master/records",
            headers={"X-Session-ID": voice_admin_session},
        )
        assert missing_lock.status_code == 423, missing_lock.text
        assert (
            missing_lock.json()["detail"]["code"]
            == "MASTER_LOCK_REQUIRED"
        )
        missing_history_lock = voice_admin.delete(
            "/api/master/history",
            headers={"X-Session-ID": voice_admin_session},
        )
        assert missing_history_lock.status_code == 423, missing_history_lock.text

        acquired = voice_admin.post(
            "/api/master/lock",
            headers={"X-Session-ID": voice_admin_session},
        )
        assert acquired.status_code == 200, acquired.text

        calls: list[str] = []

        def fake_clear(session_id: str, *, actor: str = "") -> dict[str, int]:
            calls.append(session_id)
            return {"revision": 27, "deleted": 14}

        monkeypatch.setattr(master_service, "clear_records", fake_clear)
        cleared = voice_admin.delete(
            "/api/master/records",
            headers={"X-Session-ID": voice_admin_session},
        )
        assert cleared.status_code == 200, cleared.text
        assert cleared.json() == {"revision": 27, "deleted": 14}
        assert calls == [voice_admin_session]

        reset_calls: list[str] = []

        def fake_reset_history(session_id: str) -> dict[str, int]:
            reset_calls.append(session_id)
            return {
                "revision": 0,
                "clearedChanges": 12,
                "clearedImports": 2,
                "activeRecords": 14,
                "discardedDeletedRecords": 3,
            }

        monkeypatch.setattr(
            master_service,
            "clear_history_and_reset_version",
            fake_reset_history,
        )
        reset_history = voice_admin.delete(
            "/api/master/history",
            headers={"X-Session-ID": voice_admin_session},
        )
        assert reset_history.status_code == 200, reset_history.text
        assert reset_history.json()["revision"] == 0
        assert reset_calls == [voice_admin_session]

        released = voice_admin.delete(
            "/api/master/lock",
            headers={"X-Session-ID": voice_admin_session},
        )
        assert released.status_code == 200, released.text


def test_csv_upload_inspect_convert_download_and_preview() -> None:
    session_id = session()
    source = (
        "A номер,B номер\r\n"
        "79299994464,79152671935\r\n"
        "79990000000,79991111111\r\n"
        "79299994464,79104627540\r\n"
        "79990000000,79991111111\r\n"
        "78880000000,\r\n"
    ).encode()
    with TestClient(app) as client:
        uploaded = upload(client, session_id, "input.csv", source, "text/csv")
        assert uploaded.status_code == 201, uploaded.text
        assert uploaded.json()["format"] == "csv"
        upload_id = uploaded.json()["id"]

        inspected = client.post(
            f"/api/uploads/{upload_id}/inspect",
            headers={"X-Session-ID": session_id},
            json={"sheet": None, "mode": "auto", "previewRows": 20},
        )
        assert inspected.status_code == 200, inspected.text
        inspection = inspected.json()
        assert inspection["sheet"] == "CSV"
        assert inspection["mode"] == "raw"
        assert inspection["suggestedAColumn"] == 0
        assert inspection["suggestedBColumn"] == 1
        assert inspection["statistics"]["duplicateA"] == 0
        assert inspection["statistics"]["duplicateB"] == 1
        assert inspection["duplicates"] == [
            {
                "kind": "b",
                "aNumber": "79990000000",
                "bNumber": "79991111111",
                "firstSourceRow": 3,
                "sourceRow": 5,
            }
        ]

        created = client.post(
            "/api/jobs/convert",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": upload_id,
                "mode": "raw",
                "sheet": "CSV",
                "aColumn": 0,
                "bColumn": 1,
                "keepDuplicateB": False,
                "csv": {},
                "template": {},
            },
        )
        assert created.status_code == 202, created.text
        job_id = created.json()["jobId"]
        status = wait_for_job(client, job_id, session_id)
        assert status["status"] == "completed", status
        assert status["summary"]["resultRows"] == 3
        assert status["summary"]["duplicateBRemoved"] == 1
        assert status["summary"]["emptyBReplaced"] == 1

        preview = client.get(
            f"/api/jobs/{job_id}/preview?limit=2",
            headers={"X-Session-ID": session_id},
        )
        assert preview.status_code == 200
        assert preview.json()["header"] == HEADER
        assert len(preview.json()["rows"]) == 2
        assert preview.json()["truncated"] is True

        full_preview = client.get(
            f"/api/jobs/{job_id}/preview",
            headers={"X-Session-ID": session_id},
        )
        assert full_preview.status_code == 200
        assert len(full_preview.json()["rows"]) == 3
        assert full_preview.json()["truncated"] is False

        downloaded = client.get(
            f"/api/jobs/{job_id}/download",
            headers={"X-Session-ID": session_id},
        )
        assert downloaded.status_code == 200
        rows = list(csv.reader(io.StringIO(downloaded.text)))
        assert rows[0] == [HEADER]
        assert len(rows) == 4
        assert all(len(row) == 1 for row in rows)
        assert rows[1] == [
            "null/$ & null/$ & null/$ &79299994464=4:4,1,79152671935;"
            "4,1,79104627540"
        ]

        report = client.get(
            f"/api/jobs/{job_id}/report",
            headers={"X-Session-ID": session_id},
        )
        assert report.status_code == 200
        assert "79299994464" not in report.text


def test_inspection_returns_every_duplicate_for_navigation() -> None:
    session_id = session("duplicate-navigation")
    source = (
        "A номер,B номер\r\n"
        + "79000000001,79100000001\r\n"
        + ("79000000001,79100000001\r\n" * 250)
    ).encode()
    with TestClient(app) as client:
        uploaded = upload(
            client,
            session_id,
            "duplicates.csv",
            source,
            "text/csv",
        )
        inspected = client.post(
            f"/api/uploads/{uploaded.json()['id']}/inspect",
            headers={"X-Session-ID": session_id},
            json={"sheet": None, "mode": "raw", "previewRows": None},
        )
        assert inspected.status_code == 200, inspected.text
        inspection = inspected.json()
        assert inspection["statistics"]["duplicateA"] == 0
        assert inspection["statistics"]["duplicateB"] == 250
        assert len(inspection["duplicates"]) == 250
        assert all(item["kind"] == "b" for item in inspection["duplicates"])


def test_convert_allows_all_number_warnings() -> None:
    session_id = session("aon-warning-only")
    source = (
        "A,B\r\n"
        "89000 000093,8 91\r\n"
        "89000 000093,712345678901\r\n"
    ).encode()
    with TestClient(app) as client:
        uploaded = upload(
            client,
            session_id,
            "aon-warning-only.csv",
            source,
            "text/csv",
        )
        assert uploaded.status_code == 201, uploaded.text
        created = client.post(
            "/api/jobs/convert",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": uploaded.json()["id"],
                "mode": "raw",
                "sheet": "CSV",
                "aColumn": 0,
                "bColumn": 1,
                "csv": {},
                "template": {},
            },
        )
        assert created.status_code == 202, created.text
        job_id = created.json()["jobId"]
        status = wait_for_job(client, job_id, session_id)
        assert status["status"] == "completed", status

        downloaded = client.get(
            f"/api/jobs/{job_id}/download",
            headers={"X-Session-ID": session_id},
        )
        assert downloaded.status_code == 200, downloaded.text
        rows = list(csv.reader(io.StringIO(downloaded.text)))
        assert rows[1] == [
            "null/$ & null/$ & null/$ &89000 000093=4:4,1,8 91;"
            "4,1,712345678901"
        ]


def test_formatted_inspection_reports_duplicate_a_and_b_targets() -> None:
    session_id = session("formatted-duplicates")
    source = (
        f"{HEADER}\r\n"
        '"null/$ & null/$ & null/$ &79000000001=4:4,1,79100000001"\r\n'
        '"null/$ & null/$ & null/$ &79000000001=4:4,1,79100000001;'
        '4,1,79100000002"\r\n'
    ).encode()
    with TestClient(app) as client:
        uploaded = upload(
            client,
            session_id,
            "formatted-duplicates.csv",
            source,
            "text/csv",
        )
        inspected = client.post(
            f"/api/uploads/{uploaded.json()['id']}/inspect",
            headers={"X-Session-ID": session_id},
            json={"sheet": None, "mode": "formatted", "previewRows": None},
        )
        assert inspected.status_code == 200, inspected.text
        inspection = inspected.json()
        assert inspection["statistics"]["duplicateA"] == 1
        assert inspection["statistics"]["duplicateB"] == 1
        assert [item["kind"] for item in inspection["duplicates"]] == ["a", "b"]
        assert inspection["duplicates"][1]["bNumber"] == "79100000001"


def test_convert_combines_add_format_and_multiple_deletions() -> None:
    session_id = session("unified-editor")
    source = (
        "A,B\r\n"
        "79000000001,79100000001\r\n"
        "79000000001,79100000002\r\n"
        "79000000002,79200000001\r\n"
    ).encode()
    with TestClient(app) as client:
        upload_id = upload(
            client, session_id, "source.csv", source, "text/csv"
        ).json()["id"]
        created = client.post(
            "/api/jobs/convert",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": upload_id,
                "mode": "raw",
                "aColumn": 0,
                "bColumn": 1,
                "additions": [
                    {
                        "aNumber": "79000000003",
                        "bNumbers": ["79300000001", "79300000002"],
                    }
                ],
                "deleteANumbers": ["79000000002"],
                "deleteBCommands": [
                    {
                        "aNumber": "79000000001",
                        "bNumbers": ["79100000002"],
                    },
                    {
                        "aNumber": "79000000003",
                        "bNumbers": ["79300000002"],
                    },
                ],
                "mappingFormats": [
                    {
                        "aNumber": "79000000003",
                        "prefix": "null/$ & null&D77$&",
                    }
                ],
                "csv": {},
                "template": {},
            },
        )
        assert created.status_code == 202, created.text
        status = wait_for_job(client, created.json()["jobId"], session_id)
        assert status["status"] == "completed", status
        assert status["summary"]["deletedRows"] == 1
        assert status["summary"]["deletedB"] == 2
        assert status["summary"]["customFormatsApplied"] == 1

        result = client.get(
            f"/api/jobs/{created.json()['jobId']}/download",
            headers={
                "X-Session-ID": session_id,
                "Origin": "http://localhost:3000",
            },
        )
        assert result.status_code == 200
        assert (
            f"result-{created.json()['jobId'][:8]}.csv"
            in result.headers["content-disposition"]
        )
        assert result.headers["cache-control"] == "no-store"
        assert (
            result.headers["access-control-expose-headers"]
            == "Content-Disposition"
        )
        rows = list(csv.reader(io.StringIO(result.text)))
        assert rows == [
            [HEADER],
            ["null/$ & null/$ & null/$ &79000000001=4:4,1,79100000001"],
            ["null/$ & null&D77$&79000000003=4:4,1,79300000001"],
        ]


def test_convert_deletes_all_but_one_of_1900_selected_a_numbers() -> None:
    session_id = session("delete-1900")
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(["A", "B"])
    a_numbers = [str(79_000_000_000 + index) for index in range(1_900)]
    for index, a_number in enumerate(a_numbers):
        writer.writerow([a_number, str(78_000_000_000 + index)])

    with TestClient(app) as client:
        upload_id = upload(
            client,
            session_id,
            "delete-1900.csv",
            buffer.getvalue().encode(),
            "text/csv",
        ).json()["id"]
        created = client.post(
            "/api/jobs/convert",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": upload_id,
                "mode": "raw",
                "aColumn": 0,
                "bColumn": 1,
                "deleteANumbers": a_numbers[:-1],
                "csv": {},
                "template": {},
            },
        )
        assert created.status_code == 202, created.text
        status = wait_for_job(client, created.json()["jobId"], session_id)
        assert status["status"] == "completed", status
        assert status["summary"]["requestedA"] == 1_899
        assert status["summary"]["deletedRows"] == 1_899
        assert status["summary"]["notFoundA"] == 0
        assert status["summary"]["resultRows"] == 1

        downloaded = client.get(
            f"/api/jobs/{created.json()['jobId']}/download",
            headers={"X-Session-ID": session_id},
        )
        rows = list(csv.reader(io.StringIO(downloaded.text)))
        assert rows == [
            [HEADER],
            [
                "null/$ & null/$ & null/$ &79000001899="
                "4:4,1,78000001899"
            ],
        ]


def test_convert_can_correct_an_uploaded_a_number() -> None:
    session_id = session("rename-uploaded-a")
    source = "A,B\r\n89000000001,89000000001\r\n".encode()
    with TestClient(app) as client:
        upload_id = upload(
            client, session_id, "wrong-a.csv", source, "text/csv"
        ).json()["id"]
        created = client.post(
            "/api/jobs/convert",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": upload_id,
                "mode": "raw",
                "aColumn": 0,
                "bColumn": 1,
                "renameANumbers": [
                    {
                        "fromANumber": "89000000001",
                        "toANumber": "79000000001",
                    }
                ],
                "csv": {},
                "template": {},
            },
        )
        assert created.status_code == 202, created.text
        status = wait_for_job(client, created.json()["jobId"], session_id)
        assert status["status"] == "completed", status
        assert status["summary"]["renamedA"] == 1
        result = client.get(
            f"/api/jobs/{created.json()['jobId']}/download",
            headers={"X-Session-ID": session_id},
        )
        assert result.status_code == 200
        assert "79000000001=4:4,1,79000000001" in result.text
        assert "89000000001" not in result.text


def test_whitespace_numbers_are_located_but_do_not_block_processing() -> None:
    session_id = session("whitespace-numbers")
    source = (
        'A,B\r\n" 79000000001","79000 000002"\r\n'
    ).encode()
    with TestClient(app) as client:
        upload_id = upload(
            client, session_id, "whitespace.csv", source, "text/csv"
        ).json()["id"]
        inspected = client.post(
            f"/api/uploads/{upload_id}/inspect",
            headers={"X-Session-ID": session_id},
            json={"mode": "raw"},
        )
        assert inspected.status_code == 200, inspected.text
        inspection = inspected.json()
        assert inspection["statistics"]["whitespaceNumbers"] == 2
        assert inspection["whitespaceFindings"] == [
            {
                "kind": "a",
                "aNumber": " 79000000001",
                "bNumber": None,
                "sourceRow": 2,
            },
            {
                "kind": "b",
                "aNumber": " 79000000001",
                "bNumber": "79000 000002",
                "sourceRow": 2,
            },
        ]

        uncorrected = client.post(
            "/api/jobs/convert",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": upload_id,
                "mode": "raw",
                "aColumn": 0,
                "bColumn": 1,
            },
        )
        uncorrected_status = wait_for_job(
            client, uncorrected.json()["jobId"], session_id
        )
        assert uncorrected_status["status"] == "completed", uncorrected_status
        uncorrected_result = client.get(
            f"/api/jobs/{uncorrected.json()['jobId']}/download",
            headers={"X-Session-ID": session_id},
        )
        assert " 79000000001=4:4,1,79000 000002" in uncorrected_result.text

        corrected = client.post(
            "/api/jobs/convert",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": upload_id,
                "mode": "raw",
                "aColumn": 0,
                "bColumn": 1,
                "renameANumbers": [
                    {
                        "fromANumber": " 79000000001",
                        "toANumber": "79000000001",
                    }
                ],
                "additions": [
                    {
                        "aNumber": "79000000001",
                        "bNumbers": ["79000000002"],
                    }
                ],
                "deleteBCommands": [
                    {
                        "aNumber": "79000000001",
                        "bNumbers": ["79000 000002"],
                    }
                ],
            },
        )
        corrected_status = wait_for_job(
            client, corrected.json()["jobId"], session_id
        )
        assert corrected_status["status"] == "completed", corrected_status
        result = client.get(
            f"/api/jobs/{corrected.json()['jobId']}/download",
            headers={"X-Session-ID": session_id},
        )
        assert "79000000001=4:4,1,79000000002" in result.text
        assert "79000 000002" not in result.text


def test_formatted_delete_a_and_delete_b_end_to_end() -> None:
    session_id = session("delete")
    source = (
        f"{HEADER}\r\n"
        '"null/$ & null&D29$&79299994464=4:4,1,79152671935;'
        '4,1,79104627540"\r\n'
        '"null/$ & null&D29$&79990000000=4:4,1,79990000000"\r\n'
    ).encode()
    with TestClient(app) as client:
        upload_id = upload(
            client, session_id, "formatted.csv", source, "text/csv"
        ).json()["id"]

        mappings = client.post(
            f"/api/uploads/{upload_id}/mappings",
            headers={"X-Session-ID": session_id},
            json={"mode": "formatted", "limit": 1},
        )
        assert mappings.status_code == 200, mappings.text
        assert mappings.json() == {
            "items": [
                    {
                        "aNumber": "79299994464",
                        "bNumbers": ["79152671935", "79104627540"],
                        "sourcePrefix": "null/$ & null&D29$&",
                    }
            ],
            "total": 2,
            "offset": 0,
            "limit": 1,
            "mode": "formatted",
            "sheet": "CSV",
        }
        searched = client.post(
            f"/api/uploads/{upload_id}/mappings",
            headers={"X-Session-ID": session_id},
            json={"mode": "formatted", "query": "7999"},
        )
        assert searched.status_code == 200, searched.text
        assert searched.json()["total"] == 1
        assert searched.json()["items"][0]["aNumber"] == "79990000000"

        delete_b = client.post(
            "/api/jobs/delete-b",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": upload_id,
                "commands": [
                    {
                        "aNumber": "79299994464",
                        "bNumbers": ["79104627540", "70000000000"],
                    }
                ],
                "csv": {},
            },
        )
        assert delete_b.status_code == 202, delete_b.text
        delete_b_status = wait_for_job(
            client, delete_b.json()["jobId"], session_id
        )
        assert delete_b_status["status"] == "completed", delete_b_status
        assert delete_b_status["summary"]["deletedB"] == 1
        assert delete_b_status["summary"]["notFoundB"] == 1

        delete_a = client.post(
            "/api/jobs/delete-a",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": upload_id,
                "aNumbers": ["7929", "79990000000", "79990000000"],
                "csv": {},
            },
        )
        assert delete_a.status_code == 202, delete_a.text
        delete_a_status = wait_for_job(
            client, delete_a.json()["jobId"], session_id
        )
        assert delete_a_status["status"] == "completed", delete_a_status
        assert delete_a_status["summary"]["requestedA"] == 2
        assert delete_a_status["summary"]["deletedRows"] == 1
        assert delete_a_status["summary"]["notFoundA"] == 1


def test_raw_mapping_picker_and_delete_b_end_to_end() -> None:
    session_id = session("raw-delete-b")
    source = (
        "A номер,B номер\r\n"
        "79299994464,79152671935\r\n"
        "79299994464,79104627540\r\n"
        "79990000000,79991111111\r\n"
    ).encode()
    with TestClient(app) as client:
        upload_id = upload(
            client,
            session_id,
            "raw.csv",
            source,
            "text/csv",
        ).json()["id"]

        mappings = client.post(
            f"/api/uploads/{upload_id}/mappings",
            headers={"X-Session-ID": session_id},
            json={
                "sheet": "CSV",
                "mode": "raw",
                "aColumn": 0,
                "bColumn": 1,
            },
        )
        assert mappings.status_code == 200, mappings.text
        assert mappings.json()["mode"] == "raw"
        assert mappings.json()["items"] == [
            {
                "aNumber": "79299994464",
                "bNumbers": ["79152671935", "79104627540"],
            },
            {
                "aNumber": "79990000000",
                "bNumbers": ["79991111111"],
            },
        ]
        searched_by_b = client.post(
            f"/api/uploads/{upload_id}/mappings",
            headers={"X-Session-ID": session_id},
            json={
                "sheet": "CSV",
                "mode": "raw",
                "aColumn": 0,
                "bColumn": 1,
                "query": "79104627540",
            },
        )
        assert searched_by_b.status_code == 200, searched_by_b.text
        assert searched_by_b.json()["items"] == [
            {
                "aNumber": "79299994464",
                "bNumbers": ["79104627540"],
                "bTotal": 2,
                "bTruncated": True,
            }
        ]

        created = client.post(
            "/api/jobs/delete-b",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": upload_id,
                "mode": "raw",
                "sheet": "CSV",
                "aColumn": 0,
                "bColumn": 1,
                "commands": [
                    {
                        "aNumber": "79299994464",
                        "bNumbers": ["79104627540"],
                    }
                ],
                "csv": {},
            },
        )
        assert created.status_code == 202, created.text
        status = wait_for_job(client, created.json()["jobId"], session_id)
        assert status["status"] == "completed", status
        assert status["summary"]["deletedB"] == 1

        downloaded = client.get(
            f"/api/jobs/{created.json()['jobId']}/download",
            headers={"X-Session-ID": session_id},
        )
        assert downloaded.status_code == 200
        rows = list(csv.reader(io.StringIO(downloaded.text)))
        assert rows[1] == [
            "null/$ & null/$ & null/$ &79299994464=4:4,1,79152671935"
        ]
        assert rows[2] == [
            "null/$ & null/$ & null/$ &79990000000=4:4,1,79991111111"
        ]

        delete_a = client.post(
            "/api/jobs/delete-a",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": upload_id,
                "mode": "raw",
                "sheet": "CSV",
                "aColumn": 0,
                "bColumn": 1,
                "aNumbers": ["79299994464"],
                "csv": {},
            },
        )
        assert delete_a.status_code == 202, delete_a.text
        delete_a_status = wait_for_job(
            client, delete_a.json()["jobId"], session_id
        )
        assert delete_a_status["status"] == "completed", delete_a_status
        assert delete_a_status["summary"]["requestedA"] == 1
        assert delete_a_status["summary"]["deletedRows"] == 1


def test_a_only_file_warning_contract_and_manual_additions() -> None:
    session_id = session("a-only-additions")
    source = (
        "A номер\r\n"
        "79990000000\r\n"
        "79991111111\r\n"
    ).encode()
    with TestClient(app) as client:
        upload_id = upload(
            client,
            session_id,
            "a-only.csv",
            source,
            "text/csv",
        ).json()["id"]

        inspected = client.post(
            f"/api/uploads/{upload_id}/inspect",
            headers={"X-Session-ID": session_id},
            json={"mode": "auto", "previewRows": 20},
        )
        assert inspected.status_code == 200, inspected.text
        inspection = inspected.json()
        assert inspection["mode"] == "raw"
        assert inspection["sourceHasOnlyA"] is True
        assert inspection["suggestedAColumn"] == 0
        assert inspection["suggestedBColumn"] is None
        assert inspection["statistics"]["emptyB"] == 2
        mappings = client.post(
            f"/api/uploads/{upload_id}/mappings",
            headers={"X-Session-ID": session_id},
            json={
                "mode": "raw",
                "aColumn": 0,
                "bColumn": 1,
                "limit": 500,
            },
        )
        assert mappings.status_code == 200, mappings.text
        assert mappings.json()["items"] == [
            {
                "aNumber": "79990000000",
                "bNumbers": [],
            },
            {
                "aNumber": "79991111111",
                "bNumbers": [],
            },
        ]

        created = client.post(
            "/api/jobs/convert",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": upload_id,
                "mode": "raw",
                "sheet": "CSV",
                "aColumn": 0,
                "bColumn": 1,
                "additions": [
                    {
                        "aNumber": "79772773649",
                        "bNumbers": [
                            "79017094611",
                            "79017091445",
                            "79017064018",
                            "79017096642",
                            "79017177345",
                        ],
                    },
                    {
                        "aNumber": "79990000000",
                        "bNumbers": ["79992222222"],
                    },
                ],
                "csv": {},
                "template": {},
            },
        )
        assert created.status_code == 202, created.text
        status = wait_for_job(client, created.json()["jobId"], session_id)
        assert status["status"] == "completed", status
        assert status["summary"]["emptyBReplaced"] == 2
        assert status["summary"]["manualMappings"] == 2
        assert status["summary"]["manualAddedA"] == 1
        assert status["summary"]["manualAddedB"] == 6

        downloaded = client.get(
            f"/api/jobs/{created.json()['jobId']}/download",
            headers={"X-Session-ID": session_id},
        )
        rows = list(csv.reader(io.StringIO(downloaded.text)))
        assert rows[1] == [
            "null/$ & null/$ & null/$ &79990000000="
            "4:4,1,79990000000;4,1,79992222222"
        ]
        assert rows[2] == [
            "null/$ & null/$ & null/$ &79991111111="
            "4:4,1,79991111111"
        ]
        assert rows[3] == [
            "null/$ & null/$ & null/$ &79772773649="
            "4:4,1,79017094611;4,1,79017091445;4,1,79017064018;"
            "4,1,79017096642;4,1,79017177345"
        ]


def test_inspection_returns_every_numbered_row_when_preview_limit_is_omitted() -> None:
    session_id = session("full-inspection")
    numbers = [str(79_000_000_000 + index) for index in range(1_000)]
    source = ("A номер\r\n" + "\r\n".join(numbers) + "\r\n").encode()
    with TestClient(app) as client:
        upload_id = upload(
            client,
            session_id,
            "one-thousand-a.csv",
            source,
            "text/csv",
        ).json()["id"]

        inspected = client.post(
            f"/api/uploads/{upload_id}/inspect",
            headers={"X-Session-ID": session_id},
            json={"mode": "auto", "previewRows": None},
        )
        assert inspected.status_code == 200, inspected.text
        inspection = inspected.json()
        assert inspection["sourceHasOnlyA"] is True
        assert len(inspection["preview"]) == 1_000
        assert inspection["preview"][0]["values"][0] == numbers[0]
        assert inspection["preview"][-1]["values"][0] == numbers[-1]
        assert inspection["statistics"]["readRows"] == 1_000
        assert inspection["statistics"]["uniqueA"] == 1_000


def test_raw_convert_applies_individual_formats_to_selected_a_numbers() -> None:
    session_id = session("mapping-formats")
    source = (
        "A номер,B номер\r\n"
        "79776553528,78003020869\r\n"
        "79910062330,79910062330\r\n"
        "79917291275,79779530224\r\n"
        "79917291275,79999167291\r\n"
        "79917291275,79999050283\r\n"
        "79017822586,79017822586\r\n"
    ).encode()
    with TestClient(app) as client:
        upload_id = upload(
            client,
            session_id,
            "mapping-formats.csv",
            source,
            "text/csv",
        ).json()["id"]
        created = client.post(
            "/api/jobs/convert",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": upload_id,
                "mode": "raw",
                "sheet": "CSV",
                "aColumn": 0,
                "bColumn": 1,
                "mappingFormats": [
                    {
                        "aNumber": "79776553528",
                        "prefix": "79947013851& D17$&null&",
                    },
                    {
                        "aNumber": "79917291275",
                        "prefix": "null/$ & null&D77$&",
                    },
                    {
                        "aNumber": "79017822586",
                        "prefix": "79115507987& null/$ & null/$ &",
                    },
                    {
                        "aNumber": "70000000000",
                        "prefix": "null/$ & null/$ & null/$ &",
                    },
                ],
                "csv": {},
                "template": {},
            },
        )
        assert created.status_code == 202, created.text
        status = wait_for_job(client, created.json()["jobId"], session_id)
        assert status["status"] == "completed", status
        assert status["summary"]["customFormatsRequested"] == 4
        assert status["summary"]["customFormatsApplied"] == 3
        assert status["summary"]["customFormatsNotFound"] == 1

        downloaded = client.get(
            f"/api/jobs/{created.json()['jobId']}/download",
            headers={"X-Session-ID": session_id},
        )
        rows = list(csv.reader(io.StringIO(downloaded.text)))
        assert rows[1] == [
            "79947013851& D17$&null&"
            "79776553528=4:4,1,78003020869;"
        ]
        assert rows[2] == [
            "null/$ & null/$ & null/$ &"
            "79910062330=4:4,1,79910062330"
        ]
        assert rows[3] == [
            "null/$ & null&D77$&"
            "79917291275=4:4,1,79779530224;"
            "4,1,79999167291;4,1,79999050283"
        ]
        assert rows[4] == [
            "79115507987& null/$ & null/$ &"
            "79017822586=4:4,1,79017822586"
        ]

        invalid = client.post(
            "/api/jobs/convert",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": upload_id,
                "mode": "raw",
                "aColumn": 0,
                "bColumn": 1,
                "mappingFormats": [
                    {
                        "aNumber": "79776553528",
                        "prefix": "broken-prefix&",
                    }
                ],
            },
        )
        assert invalid.status_code == 422


def test_delete_preserves_custom_formatted_template() -> None:
    session_id = session("custom-template")
    source = (
        f"{HEADER}\r\n"
        '"null/$ & null&D77$&79299994464=9:8,3,79152671935;'
        '9,3,79104627540"\r\n'
    ).encode()
    with TestClient(app) as client:
        uploaded = upload(
            client, session_id, "custom.csv", source, "text/csv"
        )
        assert uploaded.status_code == 201, uploaded.text
        job = client.post(
            "/api/jobs/delete-b",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": uploaded.json()["id"],
                "commands": [
                    {
                        "aNumber": "79299994464",
                        "bNumbers": ["79104627540"],
                    }
                ],
                "csv": {},
                "template": {
                    "regionCode": "D77",
                    "firstBMarker": "9:8",
                    "nextBMarker": "9",
                    "weight": "3",
                },
            },
        )
        status = wait_for_job(client, job.json()["jobId"], session_id)
        assert status["status"] == "completed", status
        downloaded = client.get(
            f"/api/jobs/{job.json()['jobId']}/download",
            headers={"X-Session-ID": session_id},
        )
        rows = list(csv.reader(io.StringIO(downloaded.text)))
        assert rows[1] == [
            "null/$ & null&D77$&79299994464=9:8,3,79152671935"
        ]


def test_formatted_convert_deletes_b_numbers_everywhere() -> None:
    session_id = session("global-delete-b")
    source = (
        f"{HEADER}\r\n"
        '"null/$ & null/$ & null/$ &79299994464='
        '4:4,1,79152671935;4,1,79104627540"\r\n'
        '"null/$ & null/$ & null/$ &79990000000='
        '4:4,1,79104627540"\r\n'
    ).encode()
    with TestClient(app) as client:
        uploaded = upload(
            client,
            session_id,
            "formatted.csv",
            source,
            "text/csv",
        )
        assert uploaded.status_code == 201, uploaded.text

        created = client.post(
            "/api/jobs/convert",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": uploaded.json()["id"],
                "mode": "formatted",
                "deleteBNumbers": [
                    "79104627540",
                    "70000000000",
                    "79104627540",
                ],
                "csv": {},
                "template": {},
            },
        )
        assert created.status_code == 202, created.text
        status = wait_for_job(client, created.json()["jobId"], session_id)
        assert status["status"] == "completed", status
        assert status["summary"]["requestedGlobalB"] == 2
        assert status["summary"]["deletedGlobalB"] == 2
        assert status["summary"]["notFoundGlobalB"] == 1
        assert status["summary"]["globalChangedA"] == 2
        assert status["summary"]["globalDeletedEmptyA"] == 1
        assert status["summary"]["resultRows"] == 1

        downloaded = client.get(
            f"/api/jobs/{created.json()['jobId']}/download",
            headers={"X-Session-ID": session_id},
        )
        assert downloaded.status_code == 200, downloaded.text
        rows = list(csv.reader(io.StringIO(downloaded.text)))
        assert rows == [
            [HEADER],
            [
                "null/$ & null/$ & null/$ &79299994464="
                "4:4,1,79152671935"
            ],
        ]


def test_destructive_job_fails_when_formatted_rows_are_invalid() -> None:
    session_id = session("invalid-formatted")
    source = (
        f"{HEADER}\r\n"
        '"null/$ & null&D29$&79299994464=broken"\r\n'
    ).encode()
    with TestClient(app) as client:
        uploaded = upload(
            client, session_id, "invalid.csv", source, "text/csv"
        )
        assert uploaded.status_code == 201
        job = client.post(
            "/api/jobs/delete-a",
            headers={"X-Session-ID": session_id},
            json={
                "uploadId": uploaded.json()["id"],
                "aNumbers": ["79299994464"],
                "csv": {},
            },
        )
        status = wait_for_job(client, job.json()["jobId"], session_id)
        assert status["status"] == "failed"
        assert status["error"]["code"] == "NO_VALID_MAPPINGS"


def test_cross_session_objects_return_404() -> None:
    owner = session("owner")
    attacker = session("other")
    with TestClient(app) as client:
        uploaded = upload(
            client, owner, "input.csv", b"A,B\n79299994464,79152671935\n"
        )
        assert uploaded.status_code == 201
        upload_id = uploaded.json()["id"]
        response = client.post(
            f"/api/uploads/{upload_id}/inspect",
            headers={"X-Session-ID": attacker},
            json={"mode": "auto", "previewRows": 5},
        )
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "UPLOAD_NOT_FOUND"


@pytest.mark.parametrize(
    ("name", "content", "expected_code"),
    [
        ("wrong.xlsx", b"A,B\n1,2\n", "FORMAT_MISMATCH"),
        ("broken.xlsx", b"PK\x03\x04not-a-real-zip", "CORRUPT_FILE"),
        ("broken.xlsb", b"PK\x03\x04not-a-real-zip", "CORRUPT_FILE"),
        (
            "broken.xls",
            bytes.fromhex("D0CF11E0A1B11AE1") + b"not-a-real-ole-file",
            "CORRUPT_FILE",
        ),
        ("binary.csv", b"\x00\x01\x02\x03", "UNSUPPORTED_FILE"),
    ],
)
def test_corrupt_and_mismatched_uploads(
    name: str, content: bytes, expected_code: str
) -> None:
    with TestClient(app) as client:
        response = upload(client, session("corrupt"), name, content)
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == expected_code


@pytest.mark.parametrize(
    ("member", "payload", "expected_code"),
    [
        ("xl/workbook.xml", b"A" * 1_000_000, "ZIP_BOMB"),
        ("../outside", b"unsafe", "UNSAFE_ARCHIVE"),
    ],
)
def test_unsafe_xlsx_archives_are_rejected_before_publication(
    member: str, payload: bytes, expected_code: str
) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        if member != "xl/workbook.xml":
            archive.writestr("xl/workbook.xml", b"<workbook/>")
        archive.writestr(member, payload)
    with TestClient(app) as client:
        response = upload(
            client,
            session("archive"),
            "unsafe.xlsx",
            buffer.getvalue(),
        )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == expected_code


def test_xlsx_numeric_cells_integration() -> None:
    openpyxl = pytest.importorskip("openpyxl", reason="openpyxl is required for XLSX")
    workbook = openpyxl.Workbook()
    worksheet = workbook.active
    worksheet.title = "Aux"
    worksheet.append(["notes"])
    data = workbook.create_sheet("AB")
    data.append(["A номер", "B номер"])
    data.append([79299994464, 79152671935])
    data.append([79299994464, None])
    buffer = io.BytesIO()
    workbook.save(buffer)
    workbook.close()

    session_id = session("xlsx")
    with TestClient(app) as client:
        uploaded = upload(
            client,
            session_id,
            "numeric.xlsx",
            buffer.getvalue(),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        assert uploaded.status_code == 201, uploaded.text
        inspected = client.post(
            f"/api/uploads/{uploaded.json()['id']}/inspect",
            headers={"X-Session-ID": session_id},
            json={"mode": "auto", "previewRows": 10},
        )
        assert inspected.status_code == 200, inspected.text
        assert inspected.json()["sheet"] == "AB"
        assert inspected.json()["suggestedAColumn"] == 0
        assert inspected.json()["suggestedBColumn"] == 1


def test_xls_integration_when_fixture_dependency_is_available() -> None:
    xlwt = pytest.importorskip(
        "xlwt", reason="optional xlwt package is required to synthesize XLS fixture"
    )
    workbook = xlwt.Workbook()
    sheet = workbook.add_sheet("AB")
    for column, value in enumerate(("A номер", "B номер")):
        sheet.write(0, column, value)
    sheet.write(1, 0, 79299994464)
    sheet.write(1, 1, 79152671935)
    buffer = io.BytesIO()
    workbook.save(buffer)

    session_id = session("xls")
    with TestClient(app) as client:
        uploaded = upload(client, session_id, "input.xls", buffer.getvalue())
        assert uploaded.status_code == 201, uploaded.text
        inspected = client.post(
            f"/api/uploads/{uploaded.json()['id']}/inspect",
            headers={"X-Session-ID": session_id},
            json={"mode": "auto", "previewRows": 10},
        )
        assert inspected.status_code == 200, inspected.text
        assert inspected.json()["mode"] == "raw"


def test_xls_formula_records_are_rejected_instead_of_using_cached_values() -> None:
    xlwt = pytest.importorskip(
        "xlwt", reason="xlwt is required to synthesize XLS formula fixture"
    )
    workbook = xlwt.Workbook()
    sheet = workbook.add_sheet("AB")
    sheet.write(0, 0, "A номер")
    sheet.write(0, 1, "B номер")
    sheet.write(1, 0, xlwt.Formula("1+1"))
    sheet.write(1, 1, 79152671935)
    buffer = io.BytesIO()
    workbook.save(buffer)

    session_id = session("xls-formula")
    with TestClient(app) as client:
        uploaded = upload(
            client, session_id, "formula.xls", buffer.getvalue()
        )
        assert uploaded.status_code == 400
        assert uploaded.json()["detail"]["code"] == "FORMULA_CELL"


def test_external_xlsb_upload_and_inspection() -> None:
    configured = os.getenv("CAROUSEL_TEST_XLSB")
    candidates = [Path(configured)] if configured else []
    candidates.extend(
        [
            Path("/Users/thesaintproduct/Desktop/T2/Carousel/входной.xlsb"),
            Path("/Users/thesaintproduct/Desktop/T2/Carousel/входной.xlsb"),
        ]
    )
    fixture = next((path for path in candidates if path.is_file()), None)
    if fixture is None:
        pytest.skip(
            "external XLSB fixture is absent; set CAROUSEL_TEST_XLSB to enable"
        )

    session_id = session("xlsb")
    with TestClient(app) as client:
        uploaded = upload(
            client,
            session_id,
            fixture.name,
            fixture.read_bytes(),
            "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
        )
        assert uploaded.status_code == 201, uploaded.text
        assert uploaded.json()["format"] == "xlsb"
        inspected = client.post(
            f"/api/uploads/{uploaded.json()['id']}/inspect",
            headers={"X-Session-ID": session_id},
            json={"mode": "auto", "previewRows": 5},
        )
        assert inspected.status_code == 200, inspected.text
        assert inspected.json()["sheets"]
        assert len(inspected.json()["preview"]) <= 5
