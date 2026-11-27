"""Independent synthetic contract vectors; supplied sample outputs are not golden data."""
import csv
from uuid import uuid4

import pyarrow.parquet as pq
import pytest

from app.domain.canonical import build_dataset
from app.domain.projections import ProjectionFailure, projection_rows, verify_projections

PROFILE = {"id": "hub-v1", "name": "RTK HUB", "SPREADING": "0", "INTERNAL_OPERATOR_NAME": "hubRTK"}
HEADER = ["INN", "MSISDN", "MAV_LABEL_NAME", "MAV_LABEL_LATIN", "IS_MAV", "IS_KSS"]
ROWS = [["1234567894", "001900", "Тест", "Test", "1", "1"],
        ["1234567894", "002900", "Тест", "Test", "0", "1"],
        ["123456789047", "003900", "Другой", "Other", "0", "1"]]


def make_dataset(directory, rows=None, *, profile=None, settings=None, source_id=None):
    directory.mkdir(parents=True)
    path = directory / "source.csv"
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream, delimiter=";", lineterminator="\r\n")
        writer.writerow(HEADER)
        writer.writerows(ROWS if rows is None else rows)
    return build_dataset(path, "utf-8", source_id or uuid4(), directory / "dataset", profile or PROFILE,
                         settings=settings, chunk_rows=1)


def test_three_ordered_whitelists_values_and_independent_cardinalities(tmp_path):
    dataset = make_dataset(tmp_path / "positive")
    assert list(projection_rows(dataset, "CLIENTS")) == [
        ["", "", "", "1234567894"], ["", "", "", "123456789047"]]
    assert list(projection_rows(dataset, "DOGTAGS")) == [
        ["1234567894", "Тест", "Test", "1"], ["123456789047", "Другой", "Other", "1"]]
    assert list(projection_rows(dataset, "NUMBERS")) == [
        ["1234567894", "Тест", "001900", "1", "0", "0", "hubRTK"],
        ["1234567894", "Тест", "002900", "0", "1", "0", "hubRTK"],
        ["123456789047", "Другой", "003900", "0", "1", "0", "hubRTK"]]
    result = verify_projections(dataset)
    assert result["counts"] == {"CLIENTS": 2, "DOGTAGS": 2, "NUMBERS": 3}
    assert result["reconciliation"]["complete"] is True


def test_effective_revision_override_is_not_an_optional_client_mapping(tmp_path):
    dataset = make_dataset(tmp_path / "override", settings={"profile_overrides": {
        "SPREADING": {"after": "1"}, "INTERNAL_OPERATOR_NAME": {"after": "accepted"}}})
    assert next(projection_rows(dataset, "CLIENTS")) == ["", "", "", "1234567894"]
    assert next(projection_rows(dataset, "NUMBERS"))[-2:] == ["1", "accepted"]


@pytest.mark.parametrize("role,field", [("clients", "missing_clients"), ("dogtags", "missing_labels"),
                                       ("numbers", "missing_assignments")])
def test_missing_dependency_or_assignment_blocks_even_with_old_complete_summary(tmp_path, role, field):
    dataset = make_dataset(tmp_path / role)
    path = dataset.directory / f"{role}.parquet"
    table = pq.read_table(path)
    pq.write_table(table.slice(1), path)
    assert dataset.summary["reconciliation"]["complete"] is True
    with pytest.raises(ProjectionFailure) as error:
        verify_projections(dataset)
    assert error.value.diagnostics[0]["code"] == "projection_coverage"
    assert error.value.diagnostics[0]["reconciliation"][field] > 0


def test_source_errors_cannot_release_the_internal_valid_subset(tmp_path):
    dataset = make_dataset(tmp_path / "blocked", [ROWS[0], ["123", *ROWS[1][1:]]])
    assert dataset.summary["counts"]["NUMBERS"] == 1
    with pytest.raises(ProjectionFailure) as error:
        verify_projections(dataset)
    assert error.value.diagnostics[0]["code"] == "dataset_blocked"


@pytest.mark.parametrize('inn', ['7,84201E+11', '7.84201e11', ' 7,84201E+11 '])
def test_scientific_text_excludes_whole_row_without_blocking_valid_outputs(tmp_path, inn):
    # Even a shared phone and additional cell errors on the excluded row must not
    # contaminate the valid assignment or lose the rejected row's evidence.
    rejected = [inn, ROWS[0][1], 'Другое', 'Other', '', '1']
    dataset = make_dataset(tmp_path / 'scientific', [rejected, ROWS[0], rejected])
    assert verify_projections(dataset)['counts'] == {'CLIENTS': 1, 'DOGTAGS': 1, 'NUMBERS': 1}
    assert dataset.summary['dispositions'] == {'excluded_scientific_inn': 2, 'included': 1}
    rows = dataset.page('records')['items']
    assert rows[0]['raw_cells'] == rejected
    assert rows[0]['effective']['INN'] == inn
    assert len(dataset.page('lineage')['items']) == 3
    assert dataset.summary['issue_counts'] == {'inn_scientific': 2, 'flag_value': 2}
    assert list(projection_rows(dataset, 'CLIENTS')) == [['', '', '', ROWS[0][0]]]
    assert list(projection_rows(dataset, 'DOGTAGS')) == [[ROWS[0][0], 'Тест', 'Test', '1']]
    assert list(projection_rows(dataset, 'NUMBERS')) == [[ROWS[0][0], 'Тест', ROWS[0][1], '1', '0', '0', 'hubRTK']]


def test_scientific_exclusion_does_not_release_empty_or_otherwise_broken_kit(tmp_path):
    bad = ['7,84201E+11', *ROWS[0][1:]]
    for name, rows in [('empty', [bad]), ('invalid', [bad, ['123', *ROWS[1][1:]]]),
                       ('shape', [ROWS[0], bad[:-1]])]:
        dataset = make_dataset(tmp_path / name, rows)
        with pytest.raises(ProjectionFailure):
            verify_projections(dataset)
