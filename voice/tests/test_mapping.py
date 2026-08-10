from __future__ import annotations

import csv
from pathlib import Path

import pytest

from backend.errors import AppError
from backend.importers import RowRecord
from backend.mapping import (
    AddMappingsService,
    DeleteAService,
    DeleteBService,
    MappingBuilder,
    MappingParser,
    MappingSerializer,
    MappingSpool,
)
from backend.models import (
    CsvSettings,
    HEADER,
    ManualMapping,
    Mapping,
    MappingFormatOverride,
    TemplateSettings,
)
from backend.reporting import ReportWriter
from backend.security import csv_injection_safe, mask_number, normalize_number


GOLDEN_A = "79299994464"
GOLDEN_B = [
    "79152671935",
    "79104627540",
    "79067126691",
    "79266799162",
    "79067820699",
    "79779270654",
    "79161314066",
]
GOLDEN_ROW = (
    "null/$ & null/$ & null/$ &79299994464=4:4,1,79152671935;"
    "4,1,79104627540;4,1,79067126691;4,1,79266799162;"
    "4,1,79067820699;4,1,79779270654;4,1,79161314066"
)


def build_raw(
    tmp_path: Path,
    rows: list[tuple[object, object]],
    *,
    keep_duplicate_b: bool = False,
) -> tuple[list[Mapping], dict[str, int]]:
    records = [RowRecord(1, ("A номер", "B номер"))]
    records.extend(
        RowRecord(source_row, tuple(values))
        for source_row, values in enumerate(rows, start=2)
    )
    with ReportWriter(tmp_path / "report.csv") as report, MappingSpool(
        tmp_path / "spool.sqlite3"
    ) as spool:
        stats = MappingBuilder(spool, report).build_raw(
            records,
            a_column=0,
            b_column=1,
            keep_duplicate_b=keep_duplicate_b,
        )
        mappings = list(spool.iter_mappings())
    return mappings, stats


def populated_spool(tmp_path: Path) -> tuple[MappingSpool, ReportWriter]:
    spool = MappingSpool(tmp_path / "delete-spool.sqlite3")
    report = ReportWriter(tmp_path / "delete-report.csv")
    spool.add("79299994464", "79152671935", 1, keep_duplicate=False)
    spool.add("79299994464", "79104627540", 2, keep_duplicate=False)
    spool.add("79990000000", "79990000000", 3, keep_duplicate=False)
    spool.commit()
    return spool, report


def test_one_a_one_b(tmp_path: Path) -> None:
    mappings, stats = build_raw(tmp_path, [("79299994464", "79152671935")])
    assert [(item.aNumber, item.bNumbers) for item in mappings] == [
        ("79299994464", ["79152671935"])
    ]
    assert stats["inputRows"] == stats["uniqueA"] == stats["totalB"] == 1


def test_repeated_and_interleaved_a_preserve_first_seen_order(tmp_path: Path) -> None:
    mappings, stats = build_raw(
        tmp_path,
        [
            ("79299994464", "79152671935"),
            ("79990000000", "79991111111"),
            ("79299994464", "79104627540"),
            ("78880000000", "78881111111"),
            ("79990000000", "79992222222"),
        ],
    )
    assert [item.aNumber for item in mappings] == [
        "79299994464",
        "79990000000",
        "78880000000",
    ]
    assert mappings[0].bNumbers == ["79152671935", "79104627540"]
    assert mappings[1].bNumbers == ["79991111111", "79992222222"]
    assert stats["resultRows"] == 3
    assert stats["duplicateA"] == 2


def test_empty_b_replaced_and_mixed_with_filled_b(tmp_path: Path) -> None:
    mappings, stats = build_raw(
        tmp_path,
        [
            ("79299994464", "79152671935"),
            ("79299994464", ""),
            ("79990000000", None),
        ],
    )
    assert mappings[0].bNumbers == ["79152671935", "79299994464"]
    assert mappings[1].bNumbers == ["79990000000"]
    assert stats["emptyBReplaced"] == 2


def test_duplicate_b_default_and_keep_mode(tmp_path: Path) -> None:
    rows = [
        ("79299994464", "79152671935"),
        ("79299994464", "79152671935"),
    ]
    mappings, stats = build_raw(tmp_path / "dedupe", rows)
    assert mappings[0].bNumbers == ["79152671935"]
    assert stats["duplicateBRemoved"] == 1

    kept, kept_stats = build_raw(
        tmp_path / "keep", rows, keep_duplicate_b=True
    )
    assert kept[0].bNumbers == ["79152671935", "79152671935"]
    assert kept_stats["duplicateBRemoved"] == 0


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("+79299994464", "+79299994464"),
        (79299994464, "79299994464"),
        (79299994464.0, "79299994464"),
        ("000123", "000123"),
    ],
)
def test_numbers_are_identifiers(raw: object, expected: str) -> None:
    assert normalize_number(raw, source_row=2, field="A") == expected


@pytest.mark.parametrize(
    "raw",
    [
        -1,
        -1.0,
        1.5,
        float("inf"),
        True,
        " 79299994464",
        "79299994464 ",
        "7 929",
        "7\t929",
        "abc",
        "=1+1",
    ],
)
def test_invalid_numbers_are_rejected(raw: object) -> None:
    with pytest.raises(AppError):
        normalize_number(raw, source_row=153, field="B")


def test_manual_addition_accepts_all_number_warnings(
    tmp_path: Path,
) -> None:
    with ReportWriter(tmp_path / "manual-warning-report.csv") as report, MappingSpool(
        tmp_path / "manual-warning-spool.sqlite3"
    ) as spool:
        stats = AddMappingsService().apply(
            spool,
            [ManualMapping(aNumber=" 89299994464", bNumbers=["8 91"])],
            report,
        )
        mappings = list(spool.iter_mappings())

    assert stats["manualAddedB"] == 1
    assert mappings[0].aNumber == " 89299994464"
    assert mappings[0].bNumbers == ["8 91"]


def test_inspection_mode_can_preserve_whitespace_for_manual_correction() -> None:
    assert normalize_number(
        " 79299994464",
        source_row=2,
        field="A",
        allow_whitespace_error=True,
    ) == " 79299994464"


def test_empty_rows_and_invalid_rows_are_reported(tmp_path: Path) -> None:
    mappings, stats = build_raw(
        tmp_path,
        [
            ("", ""),
            ("not-a-number", "79152671935"),
            ("79299994464", "1.5"),
            ("79990000000", ""),
        ],
    )
    assert [(item.aNumber, item.bNumbers) for item in mappings] == [
        ("79990000000", ["79990000000"])
    ]
    assert stats["skippedRows"] == 1
    assert stats["invalidRows"] == 2


def test_leading_blank_rows_do_not_hide_raw_header(tmp_path: Path) -> None:
    rows = [
        RowRecord(1, ("", "")),
        RowRecord(2, ("A номер", "B номер")),
        RowRecord(3, ("79299994464", "79152671935")),
    ]
    with ReportWriter(tmp_path / "leading-report.csv") as report, MappingSpool(
        tmp_path / "leading-spool.sqlite3"
    ) as spool:
        stats = MappingBuilder(spool, report).build_raw(
            rows, a_column=0, b_column=1
        )
        mappings = list(spool.iter_mappings())
    assert [(item.aNumber, item.bNumbers) for item in mappings] == [
        ("79299994464", ["79152671935"])
    ]
    assert stats["skippedRows"] == 1
    assert stats["invalidRows"] == 0


def test_golden_serializer_parser_round_trip_has_no_accumulating_rows(
    tmp_path: Path,
) -> None:
    mapping = Mapping(aNumber=GOLDEN_A, bNumbers=GOLDEN_B, firstSeenOrder=1)
    serializer = MappingSerializer()
    assert serializer.logical_row(mapping) == GOLDEN_ROW
    parsed = MappingParser().parse(GOLDEN_ROW, source_row=2)
    assert parsed.a_number == GOLDEN_A
    assert list(parsed.b_numbers) == GOLDEN_B

    destination = tmp_path / "golden.csv"
    count, _ = serializer.write([mapping], destination)
    with destination.open(encoding="utf-8", newline="") as source:
        rows = list(csv.reader(source))
    assert count == 1
    assert rows == [[HEADER], [GOLDEN_ROW]]


def test_auto_parser_extracts_custom_template_parameters() -> None:
    template = TemplateSettings(
        prefix="null/$ & null&D77$&",
        firstBMarker="9:8",
        nextBMarker="9",
        weight="3",
    )
    mapping = Mapping(
        aNumber=GOLDEN_A,
        bNumbers=GOLDEN_B[:2],
        firstSeenOrder=1,
    )
    row = MappingSerializer(template=template).logical_row(mapping)
    parser = MappingParser(auto_detect=True)
    parsed = parser.parse(row, source_row=2)
    assert parsed.a_number == GOLDEN_A
    assert list(parsed.b_numbers) == GOLDEN_B[:2]
    assert parser.detected_template == template


def test_linked_a_prefix_is_kept_as_editable_source_format(
    tmp_path: Path,
) -> None:
    row = (
        "79105036319& null/$ & null/$ &"
        "79001422737=4:4,1,79001422737"
    )
    parser = MappingParser(auto_detect=True, allow_mixed_templates=True)
    parsed = parser.parse(row, source_row=1)

    assert parsed.a_number == "79001422737"
    assert parsed.b_numbers == ("79001422737",)
    assert parsed.source_prefix == "79105036319& null/$ & null/$ &"
    assert parsed.linked_a_number == "79105036319"

    with ReportWriter(tmp_path / "linked-report.csv") as report, MappingSpool(
        tmp_path / "linked-spool.sqlite3"
    ) as spool:
        stats = MappingBuilder(spool, report).build_formatted(
            [RowRecord(1, (row,))],
            parser=MappingParser(
                auto_detect=True,
                allow_mixed_templates=True,
            ),
        )
        mappings = list(spool.iter_mappings())

    assert stats["resultRows"] == 1
    assert mappings[0].sourcePrefix == "79105036319& null/$ & null/$ &"
    assert MappingSerializer().logical_row(mappings[0]) == row


def test_optional_region_code_changes_only_the_output_prefix() -> None:
    mapping = Mapping(
        aNumber=GOLDEN_A,
        bNumbers=GOLDEN_B[:1],
        firstSeenOrder=1,
    )
    without_region = MappingSerializer().logical_row(mapping)
    with_region = MappingSerializer(
        template=TemplateSettings(regionCode="D29")
    ).logical_row(mapping)

    assert without_region.startswith("null/$ & null/$ & null/$ &")
    assert with_region.startswith("null/$ & null&D29$&")
    assert without_region.endswith(f"{GOLDEN_A}=4:4,1,{GOLDEN_B[0]}")
    assert with_region.endswith(f"{GOLDEN_A}=4:4,1,{GOLDEN_B[0]}")


def test_pani_and_region_can_be_used_in_the_same_parameter() -> None:
    prefix = "79947013851& D17$&null&"
    template = TemplateSettings(prefix=prefix)
    mapping = Mapping(
        aNumber="79015799813",
        bNumbers=["79045115894"],
        firstSeenOrder=1,
    )

    row = MappingSerializer(template=template).logical_row(mapping)
    parsed = MappingParser(auto_detect=True).parse(row, source_row=2)

    assert row == "79947013851& D17$&null&79015799813=4:4,1,79045115894;"
    assert parsed.source_prefix == prefix
    assert parsed.a_number == "79015799813"

    with pytest.raises(ValueError):
        TemplateSettings(prefix="7994701385& D29$&null&")
    with pytest.raises(ValueError):
        TemplateSettings(prefix="79947013851& D85$&null&")

    legacy_row = MappingSerializer(
        template=TemplateSettings(prefix="79947013851& null&D17$&")
    ).logical_row(mapping)
    assert legacy_row == row


@pytest.mark.parametrize(
    ("template", "a_number", "b_number", "expected"),
    [
        (
            TemplateSettings(prefix="79947013851& D69$&null&"),
            "79015244851",
            "79516403424",
            "79947013851& D69$&null&79015244851=4:4,1,79516403424;",
        ),
        (
            TemplateSettings(prefix="79144293926& null/$ & null/$ &"),
            "79779856062",
            "79779856062",
            "79144293926& null/$ & null/$ &79779856062=4:4,1,79779856062",
        ),
        (
            TemplateSettings(),
            "79930228063",
            "79930228063",
            "null/$ & null/$ & null/$ &79930228063=4:4,1,79930228063",
        ),
        (
            TemplateSettings(regionCode="16"),
            "79912916176",
            "79520383543",
            "null/$ & null&D16$&79912916176=4:4,1,79520383543",
        ),
    ],
)
def test_supported_parameter_formats_match_examples(
    template: TemplateSettings,
    a_number: str,
    b_number: str,
    expected: str,
) -> None:
    mapping = Mapping(
        aNumber=a_number,
        bNumbers=[b_number],
        firstSeenOrder=1,
    )
    assert MappingSerializer(template=template).logical_row(mapping) == expected


def test_individual_mapping_prefixes_reproduce_supported_row_formats() -> None:
    mappings = [
        Mapping(
            aNumber="79776553528",
            bNumbers=["78003020869"],
            firstSeenOrder=1,
        ),
        Mapping(
            aNumber="79910062330",
            bNumbers=["79910062330"],
            firstSeenOrder=2,
        ),
        Mapping(
            aNumber="79917291275",
            bNumbers=["79779530224", "79999167291", "79999050283"],
            firstSeenOrder=3,
        ),
        Mapping(
            aNumber="79017822586",
            bNumbers=["79017822586"],
            firstSeenOrder=4,
        ),
    ]
    serializer = MappingSerializer(
        mapping_formats=[
            MappingFormatOverride(
                aNumber="79776553528",
                prefix="79947013851& null/$ & null/$ &",
            ),
            MappingFormatOverride(
                aNumber="79917291275",
                prefix="null/$ & null&D77$&",
            ),
            MappingFormatOverride(
                aNumber="79017822586",
                prefix="79115507987& null/$ & null/$ &",
            ),
        ]
    )

    assert serializer.logical_row(mappings[0]) == (
        "79947013851& null/$ & null/$ &"
        "79776553528=4:4,1,78003020869"
    )
    assert serializer.logical_row(mappings[1]) == (
        "null/$ & null/$ & null/$ &"
        "79910062330=4:4,1,79910062330"
    )
    assert serializer.logical_row(mappings[2]) == (
        "null/$ & null&D77$&"
        "79917291275=4:4,1,79779530224;"
        "4,1,79999167291;4,1,79999050283"
    )
    assert serializer.logical_row(mappings[3]) == (
        "79115507987& null/$ & null/$ &"
        "79017822586=4:4,1,79017822586"
    )
    parser = MappingParser(auto_detect=True)
    parsed = [
        parser.parse(serializer.logical_row(mapping), source_row=index)
        for index, mapping in enumerate(mappings, start=2)
    ]
    assert [item.a_number for item in parsed] == [
        "79776553528",
        "79910062330",
        "79917291275",
        "79017822586",
    ]


def test_duplicate_formatted_a_rows_are_merged_in_first_seen_order(
    tmp_path: Path,
) -> None:
    rows = [
        RowRecord(1, (HEADER,)),
        RowRecord(
            2,
            ("null/$ & null&D29$&79299994464=4:4,1,79152671935",),
        ),
        RowRecord(
            3,
            ("null/$ & null&D29$&79990000000=4:4,1,79990000000",),
        ),
        RowRecord(
            4,
            ("null/$ & null&D29$&79299994464=4:4,1,79104627540",),
        ),
    ]
    with ReportWriter(tmp_path / "formatted-report.csv") as report, MappingSpool(
        tmp_path / "formatted-spool.sqlite3"
    ) as spool:
        stats = MappingBuilder(spool, report).build_formatted(
            rows, parser=MappingParser(auto_detect=True)
        )
        mappings = list(spool.iter_mappings())
    assert [item.aNumber for item in mappings] == [
        "79299994464",
        "79990000000",
    ]
    assert mappings[0].bNumbers == ["79152671935", "79104627540"]
    assert stats["duplicateA"] == 1
    assert stats["resultRows"] == 2


@pytest.mark.parametrize(
    ("line", "code"),
    [
        ("bad-prefix79299994464=4:4,1,79152671935", "INVALID_PREFIX"),
        ("null/$ & null&D29$&=4:4,1,79152671935", "INVALID_A_NUMBER"),
        ("null/$ & null&D29$&79299994464=4,1,79152671935", "INVALID_FIRST_B"),
        ("null/$ & null&D29$&79299994464=4:4,1,", "INVALID_B_NUMBER"),
        ("null/$ & null&D29$&79299994464=4:4,1,79152671935;", "INVALID_B_NUMBER"),
        (" null/$ & null&D29$&79299994464=4:4,1,79152671935", "INVALID_FORMATTED_ROW"),
    ],
)
def test_corrupt_formatted_rows_are_rejected(line: str, code: str) -> None:
    with pytest.raises(AppError) as raised:
        MappingParser(TemplateSettings(regionCode="D29")).parse(
            line,
            source_row=12,
        )
    assert raised.value.code == code
    assert raised.value.source_row == 12


@pytest.mark.parametrize("delimiter", [",", ";", "|", "\t"])
@pytest.mark.parametrize("line_ending", ["CRLF", "LF"])
def test_export_is_standard_one_column_csv(
    tmp_path: Path, delimiter: str, line_ending: str
) -> None:
    destination = tmp_path / f"result-{ord(delimiter)}-{line_ending}.csv"
    settings = CsvSettings(delimiter=delimiter, lineEnding=line_ending)
    MappingSerializer(settings).write(
        [Mapping(aNumber=GOLDEN_A, bNumbers=GOLDEN_B[:2], firstSeenOrder=1)],
        destination,
    )
    raw = destination.read_bytes()
    assert (b"\r\n" in raw) is (line_ending == "CRLF")
    with destination.open(encoding="utf-8", newline="") as source:
        rows = list(csv.reader(source, delimiter=delimiter))
    assert len(rows) == 2
    assert all(len(row) == 1 for row in rows)


def test_bom_setting(tmp_path: Path) -> None:
    destination = tmp_path / "bom.csv"
    MappingSerializer(CsvSettings(bom=True)).write(
        [Mapping(aNumber=GOLDEN_A, bNumbers=GOLDEN_B[:1], firstSeenOrder=1)],
        destination,
    )
    assert destination.read_bytes().startswith(b"\xef\xbb\xbf")


def test_delete_one_and_batch_a_are_exact_and_deduplicated(tmp_path: Path) -> None:
    spool, report = populated_spool(tmp_path)
    try:
        result = DeleteAService().apply(
            spool,
            ["7929", "79299994464", "79299994464"],
            report,
        )
        assert result == {
            "requestedA": 2,
            "foundA": 1,
            "deletedRows": 1,
            "notFoundA": 1,
            "remainingMappings": 1,
        }
        assert [item.aNumber for item in spool.iter_mappings()] == ["79990000000"]
    finally:
        report.close()
        spool.close()


def test_delete_one_multiple_missing_and_last_b(tmp_path: Path) -> None:
    spool, report = populated_spool(tmp_path)
    try:
        result = DeleteBService().apply(
            spool,
            [
                ("79299994464", ["79104627540", "70000000000"]),
                ("79990000000", ["79990000000"]),
            ],
            report,
        )
        assert result == {
            "processedA": 2,
            "deletedB": 2,
            "notFoundB": 1,
            "deletedEmptyA": 1,
            "changedRows": 2,
        }
        mappings = list(spool.iter_mappings())
        assert [(item.aNumber, item.bNumbers) for item in mappings] == [
            ("79299994464", ["79152671935"]),
        ]
    finally:
        report.close()
        spool.close()


def test_report_protection_masks_numbers_and_escapes_formula_injection() -> None:
    assert mask_number("79299994464") != "79299994464"
    assert mask_number("79299994464").startswith("79")
    for value in ("=SUM(1,1)", "+cmd", "-cmd", "@cmd"):
        assert csv_injection_safe(value).startswith("'")
