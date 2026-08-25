from __future__ import annotations

import csv
import io
import time
from dataclasses import replace

import pytest
from openpyxl import Workbook

from backend.config import settings
from backend.errors import AppError
from backend.master import MasterService
from backend.models import (
    HEADER,
    MasterImportAnalyzeRequest,
    MasterMergeRequest,
    MasterRecordRequest,
)
from backend.storage import Registry, UploadRecord, opaque_id
from backend.validation import ValidationService


def add_csv_upload(
    registry: Registry,
    *,
    session_id: str,
    name: str,
    content: str,
) -> str:
    upload_id = opaque_id()
    workspace = registry.config.data_dir / "uploads" / upload_id
    workspace.mkdir(parents=True)
    source = workspace / "source"
    source.write_bytes(content.encode("utf-8"))
    now = time.time()
    registry.add_upload(
        UploadRecord(
            id=upload_id,
            session_id=session_id,
            name=name,
            size=source.stat().st_size,
            format="csv",
            path=source,
            created_at=now,
            expires_at=now + 3600,
        )
    )
    return upload_id


def formatted_csv(rows: list[str]) -> str:
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\r\n")
    writer.writerow([HEADER])
    for row in rows:
        writer.writerow([row])
    return stream.getvalue()


def add_formatted_xlsx_upload(
    registry: Registry,
    *,
    session_id: str,
    name: str,
    rows: list[str],
) -> str:
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "Связки"
    worksheet.append([HEADER])
    for row in rows:
        worksheet.append([row])
    content = io.BytesIO()
    workbook.save(content)
    workbook.close()

    upload_id = opaque_id()
    workspace = registry.config.data_dir / "uploads" / upload_id
    workspace.mkdir(parents=True)
    source = workspace / "source"
    source.write_bytes(content.getvalue())
    now = time.time()
    registry.add_upload(
        UploadRecord(
            id=upload_id,
            session_id=session_id,
            name=name,
            size=source.stat().st_size,
            format="xlsx",
            path=source,
            created_at=now,
            expires_at=now + 3600,
        )
    )
    return upload_id


def test_master_analyzes_formatted_excel_file(tmp_path) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-xlsx-session"
    prefix = "null/$ & null/$ & null/$ &"
    upload_id = add_formatted_xlsx_upload(
        registry,
        session_id=session_id,
        name="previous-result.xlsx",
        rows=[
            f"{prefix}79000000001=4:4,1,79100000001",
            f"{prefix}79000000002=4:4,1,79200000001",
        ],
    )

    analysis = service.analyze_import(
        MasterImportAnalyzeRequest(uploadId=upload_id),
        session_id,
    )

    assert analysis["sourceName"] == "previous-result.xlsx"
    assert analysis["mode"] == "formatted"
    assert analysis["stats"]["new"] == 2
    assert analysis["stats"]["conflict"] == 0


def test_master_requires_pani_to_contain_exactly_eleven_digits(
    tmp_path,
) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )

    created = service.create_record(
        MasterRecordRequest(
            aNumber="79000000001",
            sourcePrefix="79990000001& null/$ & null/$ &",
        ),
        "master-pani-session",
        actor="tester@t2.local")
    assert (
        created["record"]["sourcePrefix"]
        == "79990000001& null/$ & null/$ &"
    )

    with pytest.raises(AppError) as too_short:
        service.create_record(
            MasterRecordRequest(
                aNumber="79000000002",
                sourcePrefix="7999000000& null/$ & null/$ &",
            ),
            "master-pani-session",
        actor="tester@t2.local")
    assert too_short.value.code == "INVALID_PREFIX"

    with pytest.raises(AppError) as too_long:
        service.create_record(
            MasterRecordRequest(
                aNumber="79000000003",
                sourcePrefix="799900000012& null/$ & null/$ &",
            ),
            "master-pani-session",
        actor="tester@t2.local")
    assert too_long.value.code == "INVALID_PREFIX"


def test_master_supports_pani_with_region_as_its_own_parameter(
    tmp_path,
) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-pani-region-session"

    created = service.create_record(
        MasterRecordRequest(
            aNumber="79000000071",
            bNumbers=["79100000071"],
            sourcePrefix="79990000001& D29$&null&",
        ),
        session_id,
        actor="tester@t2.local")
    records = service.list_records(query="", offset=0, limit=20)
    assert created["record"]["sourcePrefix"] == "79990000001& D29$&null&"
    assert records["parameterOptions"] == [
        {
            "id": "pani_region",
            "label": "С PANI и кодом региона",
            "count": 1,
        }
    ]
    assert records["regionOptions"][28] == {"value": 29, "count": 1}
    assert service.list_records(
        query="",
        parameter_groups=["pani_region"],
        offset=0,
        limit=20,
    )["total"] == 1
    assert service.list_records(
        query="",
        regions=[29],
        offset=0,
        limit=20,
    )["total"] == 1
    export_path = tmp_path / "pani-region.csv"
    service.export_csv(export_path)
    with export_path.open(encoding="utf-8", newline="") as source:
        exported = list(csv.reader(source))
    assert exported[1] == [
        "79990000001& D29$&null&79000000071=4:4,1,79100000071;"
    ]

    with pytest.raises(AppError) as short_pani:
        service.create_record(
            MasterRecordRequest(
                aNumber="79000000072",
                sourcePrefix="7999000000& D29$&null&",
            ),
            session_id,
        actor="tester@t2.local")
    assert short_pani.value.code == "INVALID_PREFIX"

    with pytest.raises(AppError) as invalid_region:
        service.create_record(
            MasterRecordRequest(
                aNumber="79000000073",
                sourcePrefix="79990000001& D85$&null&",
            ),
            session_id,
        actor="tester@t2.local")
    assert invalid_region.value.code == "INVALID_PREFIX"


@pytest.mark.parametrize(
    ("a_number", "b_numbers"),
    [
        ("79000 000071", ["79100000071"]),
        ("79000000071", ["79100 000071"]),
    ],
)
def test_master_saves_spaces_in_support_and_aon_numbers_as_warnings(
    tmp_path,
    a_number: str,
    b_numbers: list[str],
) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )

    created = service.create_record(
        MasterRecordRequest(aNumber=a_number, bNumbers=b_numbers),
        "master-whitespace-session",
        actor="tester@t2.local")
    assert created["record"]["aNumber"] == a_number
    assert created["record"]["bNumbers"] == b_numbers


def test_master_searches_for_many_a_and_aon_numbers_at_once(tmp_path) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-multi-search-session"
    rows = [
        ("79000000081", "79100000081"),
        ("79000000082", "79100000082"),
        ("79000000083", "79100000083"),
    ]
    for a_number, b_number in rows:
        service.create_record(
            MasterRecordRequest(aNumber=a_number, bNumbers=[b_number]),
            session_id,
        actor="tester@t2.local")

    aon_results = service.list_records(
        query="79100000081\n79100000083",
        offset=0,
        limit=20,
    )
    assert {item["aNumber"] for item in aon_results["items"]} == {
        "79000000081",
        "79000000083",
    }

    a_results = service.list_records(
        query="79000000081, 79000000082",
        offset=0,
        limit=20,
    )
    assert {item["aNumber"] for item in a_results["items"]} == {
        "79000000081",
        "79000000082",
    }


def test_master_number_start_is_warning_only_for_a_and_aon(tmp_path) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-number-start-session"

    created = service.create_record(
        MasterRecordRequest(
            aNumber="89000000001",
            bNumbers=["891"],
        ),
        session_id,
        actor="tester@t2.local")
    assert created["record"]["aNumber"] == "89000000001"
    assert created["record"]["bNumbers"] == ["891"]


def test_master_merge_is_not_blocked_by_any_number_warning(tmp_path) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-aon-warning-merge-session"
    prefix = "null/$ & null/$ & null/$ &"
    upload_id = add_csv_upload(
        registry,
        session_id=session_id,
        name="aon-warning.csv",
        content=formatted_csv(
            [f"{prefix}89000000092=4:4,1,8 91"]
        ),
    )

    analysis = service.analyze_import(
        MasterImportAnalyzeRequest(uploadId=upload_id),
        session_id,
    )
    assert analysis["stats"]["new"] == 1
    assert {item["kind"] for item in analysis["numberStartErrors"]} == {"a", "b"}

    merged = service.merge_import(
        analysis["importId"],
        MasterMergeRequest(),
        session_id,
        actor="tester@t2.local")
    assert merged["added"] == 1
    records = service.list_records(query="89000000092", offset=0, limit=10)
    assert records["items"][0]["bNumbers"] == ["8 91"]


def test_master_pages_and_edits_all_new_rows_before_merge(tmp_path) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-import-pagination-session"
    prefix = "null/$ & null/$ & null/$ &"
    rows = [
        f"{prefix}{79000000000 + index}=4:4,1,{79100000000 + index}"
        for index in range(1, 206)
    ]
    upload_id = add_csv_upload(
        registry,
        session_id=session_id,
        name="many-new.csv",
        content=formatted_csv(rows),
    )
    analysis = service.analyze_import(
        MasterImportAnalyzeRequest(uploadId=upload_id),
        session_id,
    )
    assert analysis["stats"]["new"] == 205
    assert len(analysis["items"]) == 200

    first = service.list_import_items(
        analysis["importId"],
        session_id,
        status="new",
        offset=0,
        limit=200,
    )
    second = service.list_import_items(
        analysis["importId"],
        session_id,
        status="new",
        offset=200,
        limit=200,
    )
    assert first["total"] == 205
    assert len(first["items"]) == 200
    assert len(second["items"]) == 5

    edited_item = first["items"][0]
    updated = service.update_import_item(
        analysis["importId"],
        edited_item["id"],
        MasterRecordRequest(
            aNumber=edited_item["aNumber"],
            bNumbers=["79999999991", "79999999992"],
            sourcePrefix="79990000001& null/$ & null/$ &",
        ),
        session_id,
    )
    assert updated["item"]["incoming"] == {
        "aNumber": edited_item["aNumber"],
        "bNumbers": ["79999999991", "79999999992"],
        "sourcePrefix": "79990000001& null/$ & null/$ &",
    }

    service.merge_import(
        analysis["importId"],
        MasterMergeRequest(),
        session_id,
        actor="tester@t2.local")
    merged = service.list_records(
        query=edited_item["aNumber"],
        offset=0,
        limit=10,
    )
    assert merged["items"][0]["bNumbers"] == [
        "79999999991",
        "79999999992",
    ]
    assert (
        merged["items"][0]["sourcePrefix"]
        == "79990000001& null/$ & null/$ &"
    )


def test_master_merge_ids_history_crud_and_export(tmp_path) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-test-session"
    prefix = "null/$ & null/$ & null/$ &"

    first_upload = add_csv_upload(
        registry,
        session_id=session_id,
        name="first.csv",
        content=formatted_csv(
            [
                f"{prefix}79000000001=4:4,1,79100000001;4,1,79100000002",
                f"{prefix}79000000002=4:4,1,79200000001",
            ]
        ),
    )
    first_analysis = service.analyze_import(
        MasterImportAnalyzeRequest(uploadId=first_upload),
        session_id,
    )
    assert first_analysis["stats"]["new"] == 2
    assert first_analysis["stats"]["conflict"] == 0
    merged = service.merge_import(
        first_analysis["importId"],
        MasterMergeRequest(),
        session_id,
        actor="tester@t2.local")
    assert merged == {
        "revision": 1,
        "added": 2,
        "updated": 0,
        "keptConflicts": 0,
    }

    initial = service.list_records(query="", offset=0, limit=100)
    assert initial["revision"] == 1
    assert initial["activeCount"] == 2
    stable_id = initial["items"][0]["id"]

    second_upload = add_csv_upload(
        registry,
        session_id=session_id,
        name="second.csv",
        content=formatted_csv(
            [
                f"{prefix}79000000001=4:4,1,79100000099",
                f"{prefix}79000000002=4:4,1,79200000001",
            ]
        ),
    )
    second_analysis = service.analyze_import(
        MasterImportAnalyzeRequest(uploadId=second_upload),
        session_id,
    )
    assert second_analysis["stats"]["conflict"] == 1
    assert second_analysis["stats"]["unchanged"] == 1
    conflict_id = next(
        item["id"]
        for item in second_analysis["items"]
        if item["status"] == "conflict"
    )
    second_merge = service.merge_import(
        second_analysis["importId"],
        MasterMergeRequest(
            conflictStrategy="selected",
            replaceConflictItemIds=[conflict_id],
        ),
        session_id,
        actor="tester@t2.local")
    assert second_merge["revision"] == 2
    assert second_merge["updated"] == 1

    after_merge = service.list_records(query="79000000001", offset=0, limit=10)
    assert after_merge["items"][0]["id"] == stable_id
    assert after_merge["items"][0]["bNumbers"] == ["79100000099"]

    updated = service.update_record(
        stable_id,
        MasterRecordRequest(
            aNumber="79000000001",
            bNumbers=["79100000099", "79100000100"],
            expectedVersion=after_merge["items"][0]["version"],
        ),
        session_id,
        actor="tester@t2.local")
    assert updated["revision"] == 3
    deleted = service.delete_record(
        stable_id,
        updated["record"]["version"],
        session_id,
        actor="tester@t2.local")
    assert deleted["revision"] == 4

    history = service.history(query=stable_id, action=None, offset=0, limit=20)
    assert [item["action"] for item in history["items"]] == [
        "deleted",
        "updated",
        "updated",
        "added",
    ]
    assert history["items"][0]["before"]["bNumbers"] == [
        "79100000099",
        "79100000100",
    ]

    export_path = tmp_path / "master.csv"
    service.export_csv(export_path)
    exported = list(csv.reader(io.StringIO(export_path.read_text())))
    assert len(exported) == 2
    assert "79000000002" in exported[1][0]


def test_master_can_review_an_a_number_rename_by_stable_id(tmp_path) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-rename-session"
    prefix = "null/$ & null/$ & null/$ &"
    initial = service.create_record(
        MasterRecordRequest(
            aNumber="79000000010",
            bNumbers=["79100000010"],
        ),
        session_id,
        actor="tester@t2.local")
    stable_id = initial["record"]["id"]
    upload_id = add_csv_upload(
        registry,
        session_id=session_id,
        name="renamed.csv",
        content=formatted_csv(
            [f"{prefix}79000000011=4:4,1,79100000010"]
        ),
    )
    analysis = service.analyze_import(
        MasterImportAnalyzeRequest(uploadId=upload_id),
        session_id,
    )
    assert analysis["stats"]["conflict"] == 1
    conflict = analysis["items"][0]
    assert conflict["current"]["id"] == stable_id
    assert conflict["current"]["aNumber"] == "79000000010"
    assert conflict["incoming"]["aNumber"] == "79000000011"

    service.merge_import(
        analysis["importId"],
        MasterMergeRequest(conflictStrategy="replace_all"),
        session_id,
        actor="tester@t2.local")
    record = service.list_records(query="", offset=0, limit=10)["items"][0]
    assert record["id"] == stable_id
    assert record["aNumber"] == "79000000011"


def test_master_comments_are_versioned_and_history_can_be_reset(tmp_path) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-comment-reset-session"
    created = service.create_record(
        MasterRecordRequest(
            aNumber="79000000101",
            bNumbers=["79100000101"],
            comment="Критично: не менять маршрут",
        ),
        session_id,
        actor="tester@t2.local")
    assert created["record"]["comment"] == "Критично: не менять маршрут"
    updated = service.update_record(
        created["record"]["id"],
        MasterRecordRequest(
            aNumber="79000000101",
            bNumbers=["79100000101"],
            comment="Согласовано с клиентом",
            expectedVersion=created["record"]["version"],
        ),
        session_id,
        actor="tester@t2.local")
    service.create_record(
        MasterRecordRequest(
            aNumber="79000000102",
            bNumbers=["79100000102"],
        ),
        session_id,
        actor="tester@t2.local")
    second = service.list_records(
        query="79000000102", offset=0, limit=10
    )["items"][0]
    service.delete_record(second["id"], second["version"], session_id, actor="tester@t2.local")

    history = service.history(query="79000000101", action=None, offset=0, limit=10)
    assert history["items"][0]["before"]["comment"] == (
        "Критично: не менять маршрут"
    )
    assert history["items"][0]["after"]["comment"] == "Согласовано с клиентом"

    reset = service.clear_history_and_reset_version(session_id)
    assert reset["revision"] == 0
    assert reset["clearedChanges"] == 4
    assert reset["activeRecords"] == 1
    assert reset["discardedDeletedRecords"] == 1
    records = service.list_records(query="", offset=0, limit=10)
    assert records["revision"] == 0
    assert records["historyCount"] == 0
    assert records["items"][0]["version"] == 1
    assert records["items"][0]["updatedRevision"] == 0
    assert records["items"][0]["comment"] == "Согласовано с клиентом"
    assert service.history(query="", action=None, offset=0, limit=10)["total"] == 0


def test_master_filters_parameters_and_filters_history_dates(
    tmp_path,
    monkeypatch,
) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-filter-session"

    monkeypatch.setattr("backend.master.time.time", lambda: 1_000.0)
    first = service.create_record(
        MasterRecordRequest(
            aNumber="79000000021",
            bNumbers=["79100000021"],
            sourcePrefix="null/$ & null&D77$&",
        ),
        session_id,
        actor="tester@t2.local")
    monkeypatch.setattr("backend.master.time.time", lambda: 2_000.0)
    second = service.create_record(
        MasterRecordRequest(
            aNumber="79000000022",
            bNumbers=["79100000022"],
            sourcePrefix="null/$ & null&D29$&",
        ),
        session_id,
        actor="tester@t2.local")

    records = service.list_records(query="D77", offset=0, limit=20)
    assert records["total"] == 0
    assert {
        option["id"]: option["count"]
        for option in records["parameterOptions"]
    } == {
        "region": 2,
    }
    region_counts = {
        option["value"]: option["count"]
        for option in records["regionOptions"]
    }
    assert len(region_counts) == 84
    assert region_counts[29] == 1
    assert region_counts[77] == 1

    aon_search = service.list_records(
        query="79100000022",
        offset=0,
        limit=20,
    )
    assert aon_search["total"] == 1
    assert aon_search["items"][0]["id"] == second["record"]["id"]

    parameter_filter = service.list_records(
        query="",
        regions=[77],
        sort="parameter_asc",
        offset=0,
        limit=20,
    )
    assert parameter_filter["total"] == 1
    assert parameter_filter["items"][0]["id"] == first["record"]["id"]

    multiple_regions = service.list_records(
        query="",
        regions=[29, 77],
        offset=0,
        limit=20,
    )
    assert multiple_regions["total"] == 2
    assert {
        item["id"] for item in multiple_regions["items"]
    } == {first["record"]["id"], second["record"]["id"]}

    parameter_history = service.history(
        query="D29",
        action=None,
        offset=0,
        limit=20,
    )
    assert parameter_history["total"] == 0

    aon_history = service.history(
        query="79100000022",
        action=None,
        offset=0,
        limit=20,
    )
    assert aon_history["total"] == 1
    assert aon_history["items"][0]["recordId"] == second["record"]["id"]

    dated_history = service.history(
        query="",
        action=None,
        offset=0,
        limit=20,
        date_from=1_500.0,
        date_to=2_500.0,
    )
    assert dated_history["total"] == 1
    assert dated_history["items"][0]["recordId"] == second["record"]["id"]


def test_master_groups_all_pani_parameters_into_one_filter_option(
    tmp_path,
) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-pani-filter-session"
    service.create_record(
        MasterRecordRequest(
            aNumber="79000000041",
            bNumbers=["79100000041"],
            sourcePrefix="79990000001& null/$ & null/$ &",
        ),
        session_id,
        actor="tester@t2.local")
    service.create_record(
        MasterRecordRequest(
            aNumber="79000000042",
            bNumbers=["79100000042"],
            sourcePrefix="79990000002& null/$ & null/$ &",
        ),
        session_id,
        actor="tester@t2.local")
    service.create_record(
        MasterRecordRequest(
            aNumber="79000000043",
            bNumbers=["79100000043"],
            sourcePrefix="null/$ & null&D77$&",
        ),
        session_id,
        actor="tester@t2.local")

    records = service.list_records(query="", offset=0, limit=20)
    assert [
        (option["id"], option["count"])
        for option in records["parameterOptions"]
    ] == [
        ("pani", 2),
        ("region", 1),
    ]
    assert records["regionOptions"][76] == {"value": 77, "count": 1}

    pani_records = service.list_records(
        query="",
        parameter_groups=["pani"],
        offset=0,
        limit=20,
    )
    assert pani_records["total"] == 2
    assert {
        item["aNumber"] for item in pani_records["items"]
    } == {"79000000041", "79000000042"}


def test_master_copies_a_number_to_aon_when_aon_is_omitted(tmp_path) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )

    created = service.create_record(
        MasterRecordRequest(aNumber="79000000051"),
        "master-empty-aon-session",
        actor="tester@t2.local")

    assert created["record"]["aNumber"] == "79000000051"
    assert created["record"]["bNumbers"] == ["79000000051"]


def test_master_persists_formatted_duplicate_findings_for_navigation(
    tmp_path,
) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-duplicate-session"
    parameter = "null/$ & null&D77$&"
    upload_id = add_csv_upload(
        registry,
        session_id=session_id,
        name="duplicates.csv",
        content=formatted_csv(
            [
                f"{parameter}79000000031=4:4,1,79100000031",
                f"{parameter}79000000031=4:4,1,79100000032",
            ]
        ),
    )

    analysis = service.analyze_import(
        MasterImportAnalyzeRequest(uploadId=upload_id),
        session_id,
    )
    assert analysis["stats"]["duplicateA"] == 1
    assert analysis["stats"]["duplicateGroups"] == 1
    assert analysis["duplicates"] == [
        {
            "aNumber": "79000000031",
            "sourceRows": [2, 3],
        }
    ]
    duplicate_page = service.list_import_duplicates(
        analysis["importId"],
        session_id,
        offset=0,
        limit=200,
    )
    assert duplicate_page["total"] == 1
    assert duplicate_page["items"] == analysis["duplicates"]

    service.merge_import(
        analysis["importId"],
        MasterMergeRequest(),
        session_id,
        actor="tester@t2.local")
    duplicates = service.list_records(
        query="",
        duplicates_only=True,
        offset=0,
        limit=20,
    )
    assert duplicates["duplicateCount"] == 1
    assert duplicates["total"] == 1
    assert duplicates["items"][0]["isDuplicate"] is True
    assert duplicates["items"][0]["duplicateSourceRows"] == [2, 3]
    assert duplicates["items"][0]["duplicateSourceFile"] == "duplicates.csv"


def test_master_reports_every_source_row_when_duplicates_are_grouped(
    tmp_path,
) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-row-accounting-session"
    prefix = "null/$ & null/$ & null/$ &"
    unique_rows = [
        f"{prefix}{79000010000 + index}=4:4,1,{79100010000 + index}"
        for index in range(100)
    ]
    repeated_rows = [
        f"{prefix}{79000010000 + index}=4:4,1,{79200010000 + index}"
        for index in range(10)
    ]
    upload_id = add_csv_upload(
        registry,
        session_id=session_id,
        name="row-accounting.csv",
        content=formatted_csv(unique_rows + repeated_rows),
    )

    analysis = service.analyze_import(
        MasterImportAnalyzeRequest(uploadId=upload_id),
        session_id,
    )

    assert analysis["stats"]["sourceRows"] == 110
    assert analysis["stats"]["uniqueA"] == 100
    assert analysis["stats"]["duplicateA"] == 10
    assert analysis["stats"]["invalidRows"] == 0
    assert (
        analysis["stats"]["uniqueA"]
        + analysis["stats"]["duplicateA"]
        + analysis["stats"]["invalidRows"]
        + analysis["stats"]["skippedRows"]
        == analysis["stats"]["sourceRows"]
    )


def test_master_row_limit_is_explicit_and_never_silently_truncates(
    tmp_path,
) -> None:
    config = replace(
        settings,
        data_dir=tmp_path / "data",
        max_master_rows=5,
    )
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-row-limit-session"
    prefix = "null/$ & null/$ & null/$ &"
    upload_id = add_csv_upload(
        registry,
        session_id=session_id,
        name="over-limit.csv",
        content=formatted_csv(
            [
                f"{prefix}{79000020000 + index}=4:4,1,{79100020000 + index}"
                for index in range(6)
            ]
        ),
    )

    with pytest.raises(AppError) as failure:
        service.analyze_import(
            MasterImportAnalyzeRequest(uploadId=upload_id),
            session_id,
        )

    assert failure.value.code == "MASTER_ROW_LIMIT"
    assert "5 строк" in failure.value.message


def test_queued_master_analysis_can_be_recovered_by_session(tmp_path) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-reload-recovery-session"
    prefix = "null/$ & null/$ & null/$ &"
    upload_id = add_csv_upload(
        registry,
        session_id=session_id,
        name="reload.csv",
        content=formatted_csv(
            [
                f"{prefix}{79000030000 + index}=4:4,1,{79100030000 + index}"
                for index in range(250)
            ]
        ),
    )

    queued = service.queue_import_analysis(
        MasterImportAnalyzeRequest(uploadId=upload_id),
        session_id,
    )
    deadline = time.monotonic() + 5
    recovered = service.get_import(queued["importId"], session_id)
    while recovered["status"] in {"queued", "analyzing"}:
        assert time.monotonic() < deadline
        time.sleep(0.01)
        recovered = service.get_import(queued["importId"], session_id)

    assert recovered["status"] == "analyzed"
    assert recovered["stats"]["sourceRows"] == 250
    assert recovered["stats"]["uniqueA"] == 250


def test_interrupted_master_analysis_restarts_without_duplicate_items(
    tmp_path,
) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    first_service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-process-restart-session"
    prefix = "null/$ & null/$ & null/$ &"
    upload_id = add_csv_upload(
        registry,
        session_id=session_id,
        name="restart.csv",
        content=formatted_csv(
            [
                f"{prefix}{79000040000 + index}=4:4,1,{79100040000 + index}"
                for index in range(10)
            ]
        ),
    )
    body = MasterImportAnalyzeRequest(uploadId=upload_id)
    import_id = first_service._create_import(  # noqa: SLF001
        body,
        session_id,
        reuse_existing=False,
    )
    with service._connect() as connection:
        connection.execute(
            "UPDATE master_imports SET status = 'analyzing' WHERE id = ?",
            (import_id,),
        )
        connection.execute(
            """
            INSERT INTO master_import_items(
                id, import_id, source_row, a_number, incoming_json,
                incoming_b_json, incoming_prefix, status
            ) VALUES ('partial-item', ?, 2, '79000040000', '{}', '[]', '', 'new')
            """,
            (import_id,),
        )

    restarted_service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    deadline = time.monotonic() + 5
    recovered = restarted_service.get_import(import_id, session_id)
    while recovered["status"] in {"queued", "analyzing"}:
        assert time.monotonic() < deadline
        time.sleep(0.01)
        recovered = restarted_service.get_import(import_id, session_id)

    assert recovered["status"] == "analyzed"
    assert recovered["stats"]["uniqueA"] == 10
    with first_service._connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) AS c FROM master_import_items WHERE import_id = ?",
            (import_id,),
        ).fetchone()["c"] == 10


def test_master_clear_soft_deletes_all_rows_in_one_revision(tmp_path) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-clear-session"
    service.create_record(
        MasterRecordRequest(
            aNumber="79000000901",
            bNumbers=["79100000901", "79100000902"],
        ),
        session_id,
        actor="tester@t2.local")
    service.create_record(
        MasterRecordRequest(
            aNumber="79000000902",
            bNumbers=["79100000903"],
            sourcePrefix="null/$ & null&D77$&",
        ),
        session_id,
        actor="tester@t2.local")
    before = service.list_records(query="", offset=0, limit=20)

    cleared = service.clear_records(session_id, actor="tester@t2.local")

    assert cleared == {
        "revision": before["revision"] + 1,
        "deleted": 2,
    }
    after = service.list_records(query="", offset=0, limit=20)
    assert after["items"] == []
    assert after["activeCount"] == 0
    assert after["totalB"] == 0
    assert after["revision"] == cleared["revision"]

    history = service.history(
        query="",
        action="cleared",
        offset=0,
        limit=20,
    )
    assert history["total"] == 1
    assert history["items"][0]["revision"] == cleared["revision"]
    assert history["items"][0]["sequence"] == 1
    assert history["items"][0]["action"] == "cleared"
    assert history["items"][0]["before"]["clearedCount"] == 2
    assert history["items"][0]["after"] is None

    repeated = service.clear_records(session_id, actor="tester@t2.local")
    assert repeated == {"revision": cleared["revision"], "deleted": 0}


def test_master_batch_deletes_a_numbers_and_aons_in_single_revisions(
    tmp_path,
) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-batch-delete-session"
    service.create_record(
        MasterRecordRequest(
            aNumber="79000000801",
            bNumbers=["79100000801", "79100000802"],
        ),
        session_id,
        actor="tester@t2.local")
    service.create_record(
        MasterRecordRequest(
            aNumber="79000000802",
            bNumbers=["79100000802"],
        ),
        session_id,
        actor="tester@t2.local")
    service.create_record(
        MasterRecordRequest(
            aNumber="79000000803",
            bNumbers=["79100000803"],
        ),
        session_id,
        actor="tester@t2.local")

    aon_result = service.delete_b_numbers(
        ["79100000802", "79100000803"], session_id, actor="tester@t2.local")
    assert aon_result["updatedRecords"] == 3
    assert aon_result["removedAons"] == 3
    after_aon = service.list_records(query="", offset=0, limit=20)
    by_a = {item["aNumber"]: item for item in after_aon["items"]}
    assert by_a["79000000801"]["bNumbers"] == ["79100000801"]
    assert by_a["79000000803"]["bNumbers"] == ["79000000803"]

    a_result = service.delete_records_by_a(
        ["79000000801", "79000000802", "79999999999"], session_id, actor="tester@t2.local")
    assert a_result["deleted"] == 2
    assert a_result["notFound"] == 1
    assert a_result["revision"] == aon_result["revision"] + 1
    remaining = service.list_records(query="", offset=0, limit=20)
    assert [item["aNumber"] for item in remaining["items"]] == [
        "79000000803"
    ]
    history = service.history(
        query="", action="deleted", offset=0, limit=20
    )
    assert history["total"] == 2
    assert {item["revision"] for item in history["items"]} == {
        a_result["revision"]
    }


def test_master_deletes_aons_only_from_selected_a_numbers(tmp_path) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-scoped-aon-delete-session"
    first = service.create_record(
        MasterRecordRequest(
            aNumber="79000000901",
            bNumbers=["79100000901", "79100000902"],
        ),
        session_id,
        actor="tester@t2.local")
    service.create_record(
        MasterRecordRequest(
            aNumber="79000000902",
            bNumbers=["79100000902"],
        ),
        session_id,
        actor="tester@t2.local")

    result = service.delete_b_numbers_for_a(
        ["79000000901", "79999999999"],
        ["79100000902", "79100000999"],
        session_id,
        actor="tester@t2.local")

    assert result["updatedRecords"] == 1
    assert result["removedAons"] == 1
    assert result["requestedRecords"] == 2
    assert result["notFoundRecords"] == 1
    assert result["notLinkedBNumbers"] == ["79100000999"]
    records = service.list_records(query="", offset=0, limit=20)
    by_a = {item["aNumber"]: item for item in records["items"]}
    assert by_a["79000000901"]["bNumbers"] == ["79100000901"]
    assert by_a["79000000902"]["bNumbers"] == ["79100000902"]
    history = service.history(
        query=first["record"]["id"], action="updated", offset=0, limit=20
    )
    assert history["total"] == 1
    assert history["items"][0]["removedBNumbers"] == ["79100000902"]
    assert history["items"][0]["addedBNumbers"] == []


def test_master_reports_and_filters_numbers_with_nonstandard_length(
    tmp_path,
) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-number-length-session"
    service.create_record(
        MasterRecordRequest(
            aNumber="7900000101",
            bNumbers=["79100001001"],
        ),
        session_id,
        actor="tester@t2.local")
    service.create_record(
        MasterRecordRequest(
            aNumber="79000001002",
            bNumbers=["791000010002"],
        ),
        session_id,
        actor="tester@t2.local")
    service.create_record(
        MasterRecordRequest(
            aNumber="79000001003",
            bNumbers=["79100001003"],
        ),
        session_id,
        actor="tester@t2.local")

    records = service.list_records(query="", offset=0, limit=20)
    assert records["invalidANumberCount"] == 1
    assert records["invalidBNumberCount"] == 1
    assert records["invalidRecordCount"] == 2
    invalid_records = service.list_records(
        query="", offset=0, limit=20, invalid_only=True
    )
    assert invalid_records["total"] == 2
    assert {item["aNumber"] for item in invalid_records["items"]} == {
        "7900000101",
        "79000001002",
    }


def test_master_change_actor_is_user_email(tmp_path) -> None:
    config = replace(settings, data_dir=tmp_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-actor-session"
    created = service.create_record(
        MasterRecordRequest(aNumber="79000000111", bNumbers=["79100000111"]),
        session_id,
        actor="ivan@t2.ru",
    )
    history = service.history(query="", offset=0, limit=10)
    assert history["items"]
    assert history["items"][0]["actor"] == "ivan@t2.ru"
    assert history["items"][0]["recordId"] == created["id"]
