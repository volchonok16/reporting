from uuid import uuid4

import duckdb
import pytest
import pyarrow.parquet as pq

from app.domain.canonical import build_dataset
from app.domain.ingress import source_record_id
from app.domain.reconciliation import reconcile
from test_validation import HEADER

PROFILE = {"id": "hub-v1", "name": "RTK HUB", "SPREADING": "0", "INTERNAL_OPERATOR_NAME": "hubRTK"}


def dataset(tmp_path, rows, overlay=None):
    source_id = uuid4()
    path = tmp_path / "source.csv"
    path.write_text(HEADER + "\n" + "\n".join(";".join(r) for r in rows) + "\n")
    result = build_dataset(path, "utf-8", source_id, tmp_path / "dataset", PROFILE,
                           correction_overlay=overlay(source_id) if overlay else [], chunk_rows=1)
    return source_id, result


ROW = ["1234567894", "79000000000", "Тест", "Test", "1", "1"]


def test_cross_chunk_exact_duplicates_have_all_provenance(tmp_path):
    source, result = dataset(tmp_path, [ROW, [*ROW[:1], "79000000900", *ROW[2:]], ROW])
    assert result.summary["blocking"] is False
    rows = result.page("records")["items"]
    assert [row["disposition"] for row in rows] == ["included", "included", "exact_duplicate"]
    assert rows[2]["representative_id"] == str(source_record_id(source, 1))
    assert len(result.page("lineage")["items"]) == 3
    assert result.summary["counts"] == {"CLIENTS": 1, "DOGTAGS": 1, "NUMBERS": 2}
    assert result.page("CLIENTS")["items"][0]["MAV_OPERATOR_NAME"] == ""
    assert result.page("NUMBERS")["items"][0]["IS_MAV"] == "1"
    assert result.page("NUMBERS")["items"][0]["IS_KSS"] == "0"


@pytest.mark.parametrize("other,code", [
    (["123456789047", "79000000000", "Тест", "Test", "1", "1"], "msisdn_assignment_conflict"),
])
def test_global_conflicts_block_every_dependent_row(tmp_path, other, code):
    _, result = dataset(tmp_path, [ROW, other, ROW])
    assert result.summary["blocking"] is True
    assert {row["disposition"] for row in result.page("records")["items"]} == {"conflict"}
    assert code in {row["code"] for row in result.page("issues")["items"]}


def test_assignment_flag_difference_is_a_warning_and_both_assignments_are_exported(tmp_path):
    _, result = dataset(tmp_path, [ROW, [*ROW[:4], '0', '1'], ROW])
    assert not result.summary['blocking']
    assert result.summary['counts']['NUMBERS'] == 2
    assert [row['disposition'] for row in result.page('records')['items']] == ['included', 'included', 'exact_duplicate']
    assert all(issue['scope'] == 'warning' for issue in result.page('issues')['items'])
    assert result.summary['reconciliation']['complete']


def test_correction_of_one_copy_recomputes_groups_without_mass_edit(tmp_path):
    def overlay(source):
        return [{"record_id": str(source_record_id(source, 2)), "ordinal": 2, "field": "MSISDN",
                 "before": ROW[1], "after": "79000000900", "reason": "Synthetic distinct assignment"}]
    source, result = dataset(tmp_path, [ROW, ROW], overlay)
    assert result.summary["counts"]["NUMBERS"] == 2
    rows = result.page("records")["items"]
    assert rows[0]["effective"]["MSISDN"] == ROW[1]
    assert rows[1]["effective"]["MSISDN"] == "79000000900"
    assert rows[1]["record_id"] == str(source_record_id(source, 2))
    assert rows[1]["raw_cells"][1] == ROW[1]


def test_missing_assignment_coverage_is_detected(tmp_path):
    _, result = dataset(tmp_path, [ROW, [*ROW[:1], "79000000900", *ROW[2:]]])
    with duckdb.connect() as db:
        db.execute("CREATE TABLE numbers AS SELECT * FROM read_parquet(?)", [str(result.directory / "numbers.parquet")])
        db.execute("DELETE FROM numbers WHERE MSISDN='79000000900'")
        checked = reconcile(db, result.directory, numbers_table="numbers")
    assert checked["complete"] is False
    assert checked["missing_assignments"] == 1


def test_parse_failure_prevents_complete_dataset_and_retains_prefix(tmp_path):
    path = tmp_path / "source.csv"
    path.write_text(HEADER + "\n" + ";".join(ROW) + '\n123;"unfinished')
    result = build_dataset(path, "utf-8", uuid4(), tmp_path / "dataset", PROFILE, chunk_rows=1)
    assert result.summary["blocking"] is True
    assert result.summary["parsed_records"] == 1
    assert result.summary["unknown_remainder"] is True
    assert len(result.page("records")["items"]) == 1


def test_raw_identity_coverage_detects_dropped_error_outcome_and_lineage(tmp_path):
    _, result = dataset(tmp_path, [ROW, [*ROW[:-1], ""]])
    for role in ("records", "lineage"):
        path = result.directory / f"{role}.parquet"
        table = pq.read_table(path)
        pq.write_table(table.slice(0, 1), path)
    with duckdb.connect() as db:
        checked = reconcile(db, result.directory)
    assert checked["complete"] is False
    assert checked["unaccounted_records"] == 1
    assert checked["missing_lineage"] == 1


def test_correcting_scientific_inn_reincludes_record_with_original_evidence(tmp_path):
    def overlay(source):
        return [{'record_id': str(source_record_id(source, 1)), 'ordinal': 1, 'field': 'INN',
                 'before': '7,84201E+11', 'after': ROW[0], 'reason': 'Confirmed full INN'}]
    _, result = dataset(tmp_path, [['7,84201E+11', *ROW[1:]]], overlay)
    assert not result.summary['blocking']
    record = result.page('records')['items'][0]
    assert record['disposition'] == 'included'
    assert record['effective']['INN'] == ROW[0]
    assert record['raw_cells'][0] == '7,84201E+11'
