"""Persisted PostgreSQL/raw/artifacts through fenced processing and an independent API process."""
import csv
import hashlib
import json
import os
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy.engine import make_url

from app.domain.ingress import source_record_id
from app.main import create_app
from app.models import ProcessingRun
from app.processing.tasks import process_run
from conftest import ORIGIN, new_case, upload

DEFAULT_CSV_FIELD_LIMIT = 131072
LARGE_VALUE = "9" * (DEFAULT_CSV_FIELD_LIMIT + 31)
HEADER = "INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\r\n"
FRESH_API_PREVIEW = """
import csv
import hashlib
import json
import os

from fastapi.testclient import TestClient
from app.main import create_app

try:
    initial_limit = csv.field_size_limit()
    app = create_app()
    with TestClient(app, base_url=os.environ["TEST_PREVIEW_ORIGIN"]) as client:
        client.cookies.update(json.loads(os.environ["TEST_PREVIEW_COOKIES"]))
        response = client.get(os.environ["TEST_PREVIEW_PATH"], params={"limit": 1})
        result = {"status": response.status_code, "initial_limit": initial_limit}
        if response.status_code == 200:
            page = response.json()
            result.update(row_count=page["row_count"], items_count=len(page["items"]),
                          next_cursor=page["next_cursor"])
            for field in ("MSISDN", "INTERNAL_OPERATOR_NAME"):
                value = page["items"][0][page["columns"].index(field)]
                result[field] = {"length": len(value), "sha256": hashlib.sha256(value.encode()).hexdigest()}
        print(json.dumps(result))
    app.state.engine.dispose()
except Exception:
    # Neither connection credentials nor authenticated cookies may enter subprocess diagnostics.
    print(json.dumps({"failure": "Independent API preview failed; details suppressed."}))
    raise SystemExit(1)
"""


def preview_in_fresh_api_process(backend, client, path):
    url = make_url(backend.settings.database_url).update_query_dict({"options": f"-c search_path={backend.schema}"})
    env = os.environ.copy()
    # Private URL and session cookie travel only in the environment, never arguments or diagnostics.
    env.update(DATABASE_URL=url.render_as_string(hide_password=False),
               STORAGE_ROOT=str(backend.settings.storage_root), APP_ORIGIN=ORIGIN,
               TEST_PREVIEW_ORIGIN=ORIGIN, TEST_PREVIEW_COOKIES=json.dumps(dict(client.cookies)),
               TEST_PREVIEW_PATH=path, PYTHONPATH=str(Path(__file__).resolve().parents[2]))
    completed = subprocess.run([sys.executable, "-c", FRESH_API_PREVIEW], env=env,
                               capture_output=True, text=True, timeout=30)
    assert completed.returncode == 0, "Independent API preview failed; private diagnostics suppressed."
    return json.loads(completed.stdout)


@pytest.mark.parametrize("kind", ["source", "correction", "profile_override"])
def test_large_accepted_values_survive_pipeline_and_preview_in_fresh_api_process(backend, tmp_path, kind):
    previous_limit = csv.field_size_limit()
    try:
        settings = replace(backend.settings, max_upload_bytes=1024 * 1024,
                           scratch_root=tmp_path / "scratch", max_job_attempts=1)
        backend.settings = settings
        backend.app = create_app(settings, engine=backend.engine)
        client = backend.client()
        case = new_case(client)
        msisdn = LARGE_VALUE if kind == "source" else "001900"
        raw = (HEADER + f"1234567894;{msisdn};Тест;Test;1;1\r\n").encode()
        uploaded = upload(client, case, data=raw)
        assert uploaded.status_code == 200
        result = uploaded.json()["result"]
        source, revision = result["source"]["id"], result["revision"]["id"]
        assert result["source"]["inspection"]["schema_supported"] is True
        if kind == "source":
            response = client.post(f"/api/cases/{case}/processing/start", json={
                "operation_id": str(uuid4()), "expected_revision_id": revision})
        else:
            corrections, overrides = [], []
            if kind == "correction":
                corrections = [{"record_id": str(source_record_id(source, 1)), "ordinal": 1,
                                "field": "MSISDN", "before": "001900", "after": LARGE_VALUE,
                                "reason": "Synthetic accepted value larger than raw source"}]
                msisdn = LARGE_VALUE
            else:
                overrides = [{"field": "INTERNAL_OPERATOR_NAME", "before": "hubRTK", "after": LARGE_VALUE,
                              "reason": "Synthetic accepted override larger than raw source"}]
            assert len(LARGE_VALUE) > len(raw)
            response = client.post(f"/api/cases/{case}/processing/save-and-start", json={
                "operation_id": str(uuid4()), "expected_revision_id": revision, "source_asset_id": source,
                "corrections": corrections, "overrides": overrides})
        assert response.status_code == 200
        job = response.json()["result"]["job"]
        revision = job["revision_id"]
        # Run the production fenced worker pipeline at independent-worker CSV capacity.
        csv.field_size_limit(DEFAULT_CSV_FIELD_LIMIT)
        process_run(backend.app.state.sessions, UUID(job["id"]), settings, backend.app.state.storage)
        with backend.app.state.sessions() as db:
            assert db.get(ProcessingRun, UUID(job["id"])).state == "PREPARED"
        assert client.get(f"/api/cases/{case}/sources/{source}/raw").content == raw
        base = f"/api/cases/{case}/revisions/{revision}/artifacts"
        artifacts = client.get(base)
        assert artifacts.status_code == 200 and artifacts.json()["available"] is True
        numbers = next(obj for obj in artifacts.json()["artifacts"] if obj["role"] == "NUMBERS")
        preview = preview_in_fresh_api_process(backend, client, base + f"/{numbers['id']}/preview")
        assert preview["initial_limit"] == DEFAULT_CSV_FIELD_LIMIT
        assert preview["status"] == 200
        assert (preview["row_count"], preview["items_count"], preview["next_cursor"]) == (1, 1, None)
        operator = LARGE_VALUE if kind == "profile_override" else "hubRTK"
        for field, expected in (("MSISDN", msisdn), ("INTERNAL_OPERATOR_NAME", operator)):
            assert preview[field] == {"length": len(expected), "sha256": hashlib.sha256(expected.encode()).hexdigest()}
    finally:
        csv.field_size_limit(previous_limit)
