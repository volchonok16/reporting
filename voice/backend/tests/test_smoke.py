from __future__ import annotations

import csv
import io
import time
import uuid
from pathlib import Path

from fastapi.testclient import TestClient as FastAPITestClient

from backend.config import settings
from backend.importers import RowRecord
from backend.main import app
from backend.mapping import (
    DeleteAService,
    DeleteBService,
    MappingBuilder,
    MappingParser,
    MappingSerializer,
    MappingSpool,
)
from backend.models import HEADER, Mapping
from backend.reporting import ReportWriter


class TestClient(FastAPITestClient):
    def __enter__(self):
        client = super().__enter__()
        response = self.post(
            "/api/auth/login",
            json={
                "email": settings.auth_bootstrap_email,
                "password": settings.auth_bootstrap_password,
            },
        )
        assert response.status_code == 200, response.text
        self.headers.update(
            {"Authorization": f"Bearer {response.json()['token']}"}
        )
        return client


def test_serializer_parser_golden_round_trip() -> None:
    mapping = Mapping(
        aNumber="79299994464",
        bNumbers=[
            "79152671935",
            "79104627540",
            "79067126691",
            "79266799162",
            "79067820699",
            "79779270654",
            "79161314066",
        ],
        firstSeenOrder=1,
    )
    row = MappingSerializer().logical_row(mapping)
    assert row == (
        "null/$ & null/$ & null/$ &79299994464=4:4,1,79152671935;"
        "4,1,79104627540;4,1,79067126691;4,1,79266799162;"
        "4,1,79067820699;4,1,79779270654;4,1,79161314066"
    )
    parsed = MappingParser().parse(row, source_row=2)
    assert parsed.a_number == mapping.aNumber
    assert list(parsed.b_numbers) == mapping.bNumbers


def test_csv_end_to_end() -> None:
    session = f"smoke-{uuid.uuid4()}"
    source = (
        "A номер,B номер\r\n"
        "79299994464,79152671935\r\n"
        "79299994464,79104627540\r\n"
        "79990000000,\r\n"
    ).encode()
    with TestClient(app) as client:
        uploaded = client.post(
            "/api/uploads",
            headers={"X-Session-ID": session},
            files={"file": ("input.csv", source, "text/csv")},
        )
        assert uploaded.status_code == 201, uploaded.text
        upload_id = uploaded.json()["id"]

        inspected = client.post(
            f"/api/uploads/{upload_id}/inspect",
            headers={"X-Session-ID": session},
            json={"sheet": None, "mode": "auto", "previewRows": 20},
        )
        assert inspected.status_code == 200, inspected.text
        assert inspected.json()["mode"] == "raw"
        assert inspected.json()["suggestedAColumn"] == 0
        assert inspected.json()["suggestedBColumn"] == 1

        created = client.post(
            "/api/jobs/convert",
            headers={"X-Session-ID": session},
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
        for _ in range(100):
            status = client.get(
                f"/api/jobs/{job_id}", headers={"X-Session-ID": session}
            ).json()
            if status["status"] in {"completed", "failed", "cancelled"}:
                break
            time.sleep(0.02)
        assert status["status"] == "completed", status
        assert status["summary"]["resultRows"] == 2
        assert status["summary"]["emptyBReplaced"] == 1

        downloaded = client.get(
            f"/api/jobs/{job_id}/download",
            headers={"X-Session-ID": session},
        )
        assert downloaded.status_code == 200
        rows = list(csv.reader(io.StringIO(downloaded.text)))
        assert rows[0] == [HEADER]
        assert len(rows) == 3
        assert rows[1] == [
            "null/$ & null/$ & null/$ &79299994464=4:4,1,79152671935;"
            "4,1,79104627540"
        ]
        assert rows[2] == [
            "null/$ & null/$ & null/$ &79990000000=4:4,1,79990000000"
        ]


def test_builder_deduplicates_and_replaces_empty_b(tmp_path: Path) -> None:
    report_path = tmp_path / "report.csv"
    with ReportWriter(report_path) as report, MappingSpool(
        tmp_path / "spool.sqlite3"
    ) as spool:
        stats = MappingBuilder(spool, report).build_raw(
            [
                RowRecord(1, ("A номер", "B номер")),
                RowRecord(2, ("79299994464", "79152671935")),
                RowRecord(3, ("79299994464", "79152671935")),
                RowRecord(4, ("79299994464", "")),
                RowRecord(5, ("79990000000", None)),
                RowRecord(6, ("", "")),
            ],
            a_column=0,
            b_column=1,
        )
        mappings = list(spool.iter_mappings())
    assert [mapping.aNumber for mapping in mappings] == [
        "79299994464",
        "79990000000",
    ]
    assert mappings[0].bNumbers == ["79152671935", "79299994464"]
    assert mappings[1].bNumbers == ["79990000000"]
    assert stats["duplicateBRemoved"] == 1
    assert stats["emptyBReplaced"] == 2
    assert stats["skippedRows"] == 1


def test_exact_delete_services_and_last_b_rule(tmp_path: Path) -> None:
    with ReportWriter(tmp_path / "report.csv") as report, MappingSpool(
        tmp_path / "spool.sqlite3"
    ) as spool:
        spool.add("79299994464", "79152671935", 1, keep_duplicate=False)
        spool.add("79299994464", "79104627540", 2, keep_duplicate=False)
        spool.add("79990000000", "79990000000", 3, keep_duplicate=False)
        operation = DeleteBService().apply(
            spool,
            [
                ("79299994464", ["79104627540"]),
                ("79990000000", ["79990000000"]),
            ],
            report,
        )
        assert operation["deletedB"] == 2
        assert operation["deletedEmptyA"] == 1
        assert [item.aNumber for item in spool.iter_mappings()] == [
            "79299994464",
        ]
        delete_a = DeleteAService().apply(
            spool,
            ["7929", "79299994464", "79299994464", "79990000000"],
            report,
        )
        assert delete_a["requestedA"] == 3
        assert delete_a["deletedRows"] == 1
        assert list(spool.iter_mappings()) == []
