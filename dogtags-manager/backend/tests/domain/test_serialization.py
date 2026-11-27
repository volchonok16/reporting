import csv
import hashlib
import re
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4
from zipfile import ZipFile

import pytest

from app.domain.canonical import build_dataset
from app.domain.ingress import parse_source, source_record_id
from app.domain.manifest import capture_filename_components, export_filename
from app.domain.serialization import SerializationFailure, verify_csv, write_csv, write_zip
from app.domain.source_inspection import inspect_source
from test_projections import PROFILE, ROWS, make_dataset

REVISION_ID = UUID("00000000-0000-0000-0000-000000000007")
CASE_ID = UUID("00000000-0000-0000-0000-000000000008")
DEFAULT_CSV_FIELD_LIMIT = 131072


@pytest.mark.parametrize('operator', ['', 'none'])
def test_absent_operator_is_an_empty_csv_cell_not_a_placeholder(tmp_path, operator):
    dataset = make_dataset(tmp_path / 'input', profile={**PROFILE, 'INTERNAL_OPERATOR_NAME': operator})
    obj = write_csv(dataset, 'NUMBERS', tmp_path / 'numbers.csv')
    verify_csv(dataset, obj)
    with obj.path.open(encoding='cp1251', newline='') as stream:
        rows = list(csv.reader(stream, delimiter=';'))
    assert rows[0][-1] == 'INTERNAL_OPERATOR_NAME'
    assert all(row[-1] == '' for row in rows[1:])


@pytest.fixture
def fresh_csv_limit():
    previous = csv.field_size_limit()
    csv.field_size_limit(DEFAULT_CSV_FIELD_LIMIT)
    try:
        yield
    finally:
        csv.field_size_limit(previous)


def revision():
    return SimpleNamespace(id=REVISION_ID, case_id=CASE_ID, sequence=7,
                           export_timestamp=datetime(2026, 10, 10, 10, 11, 12, tzinfo=timezone.utc),
                           export_timezone="Europe/Moscow", serializer_version="cp1251-crlf-v1",
                           filename_components=capture_filename_components(CASE_ID, REVISION_ID, 7, "source.csv"))


def test_csv_exact_bytes_headers_values_counts_and_hash_after_reread(tmp_path):
    dataset = make_dataset(tmp_path / "input")
    expected = {
        "CLIENTS": "COMPANY_NAME;COMPANY_CONTRACT;MAV_OPERATOR_NAME;INN\r\n;;;1234567894\r\n;;;123456789047\r\n",
        "DOGTAGS": "INN;MAV_LABEL;MAV_LABEL_LATIN;IS_ACTIVE\r\n1234567894;Тест;Test;1\r\n123456789047;Другой;Other;1\r\n",
        "NUMBERS": "INN;MAV_LABEL_NAME;MSISDN;IS_MAV;IS_KSS;SPREADING;INTERNAL_OPERATOR_NAME\r\n"
                   "1234567894;Тест;001900;1;0;0;hubRTK\r\n1234567894;Тест;002900;0;1;0;hubRTK\r\n"
                   "123456789047;Другой;003900;0;1;0;hubRTK\r\n"}
    for role, text in expected.items():
        path = tmp_path / export_filename(revision(), role)
        obj = write_csv(dataset, role, path)
        assert path.read_bytes() == text.encode("cp1251")
        assert obj.sha256 == hashlib.sha256(text.encode("cp1251")).hexdigest()
        assert obj.size_bytes == len(text.encode("cp1251"))
        assert obj.row_count == (3 if role == "NUMBERS" else 2)
        verify_csv(dataset, obj)
        path.write_bytes(path.read_bytes().replace(b"\r\n", b"\n"))
        with pytest.raises(SerializationFailure):
            verify_csv(dataset, obj)


def test_delimiters_quotes_and_embedded_lines_roundtrip_without_data_changes(tmp_path):
    rows = [[ROWS[0][0], '001;"call"\r\nnext', *ROWS[0][2:]]]
    dataset = make_dataset(tmp_path / "quoted", rows)
    obj = write_csv(dataset, "NUMBERS", tmp_path / "numbers.csv")
    assert b'"001;""call""\r\nnext"' in obj.path.read_bytes()
    verify_csv(dataset, obj)


@pytest.mark.parametrize("kind,index", [("correction", 2), ("profile_override", 6)])
def test_output_larger_than_raw_source_roundtrips_at_fresh_process_capacity(tmp_path, fresh_csv_limit,
                                                                         kind, index):
    source_id = uuid4()
    path = tmp_path / "source.csv"
    path.write_text("INN;MSISDN;MAV_LABEL_NAME;MAV_LABEL_LATIN;IS_MAV;IS_KSS\r\n"
                    "1234567894;001900;Тест;Test;1;1\r\n", encoding="utf-8", newline="")
    value = "9" * (DEFAULT_CSV_FIELD_LIMIT + 31)
    settings, overlay = {}, []
    if kind == "correction":
        overlay = [{"record_id": str(source_record_id(source_id, 1)), "ordinal": 1,
                    "field": "MSISDN", "before": "001900", "after": value}]
    else:
        settings = {"profile_overrides": {"INTERNAL_OPERATOR_NAME": {"after": value}}}
    dataset = build_dataset(path, "utf-8", source_id, tmp_path / "dataset", PROFILE,
                            settings=settings, correction_overlay=overlay, chunk_rows=1)
    assert dataset.summary["blocking"] is False
    assert csv.field_size_limit() == DEFAULT_CSV_FIELD_LIMIT
    obj = write_csv(dataset, "NUMBERS", tmp_path / "numbers.csv")
    assert obj.size_bytes > path.stat().st_size
    # Rereading must establish its own capacity without relying on prior ingress or serialization.
    csv.field_size_limit(DEFAULT_CSV_FIELD_LIMIT)
    verify_csv(dataset, obj)
    with obj.path.open(encoding="cp1251", newline="") as stream:
        rows = list(csv.reader(stream, delimiter=";", strict=True))
    assert rows[1][index] == value


def test_smaller_source_reads_preserve_capacity_for_large_output(tmp_path, fresh_csv_limit):
    dataset = make_dataset(tmp_path / "input", settings={"profile_overrides": {
        "INTERNAL_OPERATOR_NAME": {"after": "9" * (DEFAULT_CSV_FIELD_LIMIT + 31)}}})
    obj = write_csv(dataset, "NUMBERS", tmp_path / "numbers.csv")
    output_limit = csv.field_size_limit()
    source = dataset.directory.parent / "source.csv"
    inspection = inspect_source(source, "utf-8", source.stat().st_size)
    assert inspection["schema_supported"] is True and inspection["records_count"] == 3
    assert csv.field_size_limit() == output_limit
    assert len(list(parse_source(source, "utf-8", dataset.summary["source_asset_id"]).records())) == 3
    assert csv.field_size_limit() == output_limit
    verify_csv(dataset, obj)


@pytest.mark.parametrize("kind,field", [("source", "MSISDN"), ("profile", "INTERNAL_OPERATOR_NAME")])
def test_non_cp1251_value_is_actionable_and_never_replaced(tmp_path, kind, field):
    rows, profile = [row.copy() for row in ROWS], PROFILE.copy()
    if kind == "source":
        rows[0][1] = "900🙂"
    else:
        profile[field] = "operator🙂"
    dataset = make_dataset(tmp_path / kind, rows, profile=profile)
    assert dataset.summary["blocking"] is False
    with pytest.raises(SerializationFailure) as error:
        write_csv(dataset, "NUMBERS", tmp_path / "numbers.csv")
    diagnostic = error.value.diagnostics[0]
    expected = {"code": "output_encoding_error", "role": "NUMBERS", "row": 1, "field": field,
                "scope": "revision_setting" if kind == "profile" else "source_cell"}
    if kind == "source":
        expected.update(ordinal=1, record_id=str(source_record_id(dataset.summary["source_asset_id"], 1)))
    assert diagnostic == expected
    assert "🙂" not in str(error.value)


def test_encoding_diagnostic_addresses_source_ordinal_after_duplicate_collapse(tmp_path):
    rows = [ROWS[0], ROWS[0], [ROWS[1][0], "900🙂", *ROWS[1][2:]]]
    dataset = make_dataset(tmp_path / "duplicate", rows)
    with pytest.raises(SerializationFailure) as error:
        write_csv(dataset, "NUMBERS", tmp_path / "numbers.csv")
    diagnostic = error.value.diagnostics[0]
    assert diagnostic["row"] == 2 and diagnostic["ordinal"] == 3
    assert diagnostic["record_id"] == str(source_record_id(dataset.summary["source_asset_id"], 3))


def test_stable_safe_captured_names_and_fixed_three_csv_zip(tmp_path):
    dataset = make_dataset(tmp_path / "zip-input")
    snapshot = revision()
    names = [export_filename(snapshot, role) for role in ("CLIENTS", "DOGTAGS", "NUMBERS")]
    assert names[0] == ("2026-10-10T13-11-12+0300_RTK-HUB_MARKING_00000000-0000-0000-0000-000000000008_"
                        "r7-00000000-0000-0000-0000-000000000007_PREPARED_CLIENTS.csv")
    assert all(len(name) <= 240 and not re.search(r'[<>:"/\\|?*\x00-\x1f]', name) for name in names)
    files = [write_csv(dataset, role, tmp_path / name) for role, name in zip(
        ("CLIENTS", "DOGTAGS", "NUMBERS"), names, strict=True)]
    first = write_zip(files, tmp_path / "first.zip")
    second = write_zip(files, tmp_path / "second.zip")
    assert first.path.read_bytes() == second.path.read_bytes()
    with ZipFile(first.path) as archive:
        assert archive.namelist() == names
        assert all(item.date_time == (1980, 1, 1, 0, 0, 0) and item.compress_type == 0
                   for item in archive.infolist())
        assert [archive.read(name) for name in names] == [obj.path.read_bytes() for obj in files]
    snapshot.filename_components["partner"] = "../unsafe"
    with pytest.raises(ValueError):
        export_filename(snapshot, "CLIENTS")
