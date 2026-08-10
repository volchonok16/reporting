from __future__ import annotations

import csv
import time
from pathlib import Path

from backend.importers import CsvImporter
from backend.mapping_index import MappingIndexService
from backend.models import HEADER
from backend.validation import ValidationService


def write_rows(path: Path, rows: int = 20_000) -> None:
    with path.open("w", encoding="utf-8", newline="") as target:
        writer = csv.writer(target, lineterminator="\n")
        writer.writerow(["A номер", "B номер"])
        for index in range(rows):
            writer.writerow(
                [
                    str(79_000_000_000 + index // 2),
                    str(78_000_000_000 + index),
                ]
            )


def test_index_is_reused_and_searches_by_b_without_reading_source(
    tmp_path: Path,
) -> None:
    source = tmp_path / "input.csv"
    index = tmp_path / "mapping-index.sqlite3"
    write_rows(source)
    service = MappingIndexService(ValidationService())
    importer = CsvImporter(source)

    first = service.query(
        importer,
        index,
        requested_sheet="CSV",
        requested_mode="raw",
        a_column=0,
        b_column=1,
        query="",
        offset=0,
        limit=5,
    )
    assert first["total"] == 10_000
    assert index.is_file()

    source.unlink()
    started = time.perf_counter()
    searched = service.query(
        importer,
        index,
        requested_sheet="CSV",
        requested_mode="raw",
        a_column=0,
        b_column=1,
        query="78000012345",
        offset=0,
        limit=5,
    )
    elapsed = time.perf_counter() - started

    assert searched["total"] == 1
    assert searched["items"] == [
        {
            "aNumber": "79000006172",
            "bNumbers": ["78000012345"],
            "bTotal": 2,
            "bTruncated": True,
        }
    ]
    assert elapsed < 0.5


def test_index_keeps_a_numbers_that_do_not_have_b_numbers(tmp_path: Path) -> None:
    source = tmp_path / "mixed.csv"
    index = tmp_path / "mapping-index.sqlite3"
    with source.open("w", encoding="utf-8", newline="") as target:
        writer = csv.writer(target, lineterminator="\n")
        writer.writerow(["A номер", "B номер"])
        writer.writerow(["79000000001", "78000000001"])
        writer.writerow(["79000000002", ""])
        writer.writerow(["79000000003", None])

    service = MappingIndexService(ValidationService())
    importer = CsvImporter(source)
    result = service.query(
        importer,
        index,
        requested_sheet="CSV",
        requested_mode="raw",
        a_column=0,
        b_column=1,
        query="",
        offset=0,
        limit=500,
    )

    assert result["total"] == 3
    assert result["items"] == [
        {"aNumber": "79000000001", "bNumbers": ["78000000001"]},
        {"aNumber": "79000000002", "bNumbers": []},
        {"aNumber": "79000000003", "bNumbers": []},
    ]


def test_index_shows_all_a_numbers_when_first_row_is_an_unknown_header(
    tmp_path: Path,
) -> None:
    source = tmp_path / "one-thousand-a.csv"
    index = tmp_path / "mapping-index.sqlite3"
    numbers = [str(79_000_000_000 + offset) for offset in range(1_000)]
    with source.open("w", encoding="utf-8", newline="") as target:
        writer = csv.writer(target, lineterminator="\n")
        writer.writerow(["Реестр номеров"])
        writer.writerows([[number] for number in numbers])

    service = MappingIndexService(ValidationService())
    importer = CsvImporter(source)
    first_page = service.query(
        importer,
        index,
        requested_sheet="CSV",
        requested_mode="raw",
        a_column=0,
        b_column=1,
        query="",
        offset=0,
        limit=500,
    )
    second_page = service.query(
        importer,
        index,
        requested_sheet="CSV",
        requested_mode="raw",
        a_column=0,
        b_column=1,
        query="",
        offset=500,
        limit=500,
    )

    assert first_page["total"] == 1_000
    assert len(first_page["items"]) == 500
    assert len(second_page["items"]) == 500
    assert [
        item["aNumber"] for item in first_page["items"] + second_page["items"]
    ] == numbers
    assert all(
        item["bNumbers"] == []
        for item in first_page["items"] + second_page["items"]
    )


def test_formatted_index_keeps_valid_rows_with_mixed_templates(
    tmp_path: Path,
) -> None:
    source = tmp_path / "mixed-formatted.csv"
    index = tmp_path / "mapping-index.sqlite3"
    with source.open("w", encoding="utf-8", newline="") as target:
        writer = csv.writer(target, lineterminator="\n")
        writer.writerow([HEADER])
        writer.writerow(
            [
                "null/$ & null/$ & null/$ &79299994464="
                "4:4,1,79152671935"
            ]
        )
        writer.writerow(
            [
                "null/$ & null&D77$&79990000000="
                "9:8,3,79991111111"
            ]
        )
        writer.writerow(["служебная строка"])

    service = MappingIndexService(ValidationService())
    importer = CsvImporter(source)
    result = service.query(
        importer,
        index,
        requested_sheet="CSV",
        requested_mode="formatted",
        a_column=0,
        b_column=1,
        query="",
        offset=0,
        limit=500,
    )

    assert result["total"] == 2
    assert result["items"] == [
        {
            "aNumber": "79299994464",
            "bNumbers": ["79152671935"],
        },
        {
            "aNumber": "79990000000",
            "bNumbers": ["79991111111"],
            "sourcePrefix": "null/$ & null&D77$&",
        },
    ]

    parameter_text_search = service.query(
        importer,
        index,
        requested_sheet="CSV",
        requested_mode="formatted",
        a_column=0,
        b_column=1,
        query="D77",
        offset=0,
        limit=500,
    )
    assert parameter_text_search["total"] == 0
    assert parameter_text_search["items"] == []


def test_formatted_index_exposes_and_searches_linked_a_number(
    tmp_path: Path,
) -> None:
    source = tmp_path / "linked-a.csv"
    index = tmp_path / "mapping-index.sqlite3"
    with source.open("w", encoding="utf-8", newline="") as target:
        writer = csv.writer(target, lineterminator="\n")
        writer.writerow([HEADER])
        writer.writerow(
            [
                "79105036319& null/$ & null/$ &"
                "79001422737=4:4,1,79001422737"
            ]
        )

    service = MappingIndexService(ValidationService())
    importer = CsvImporter(source)
    result = service.query(
        importer,
        index,
        requested_sheet="CSV",
        requested_mode="formatted",
        a_column=0,
        b_column=1,
        query="79105036319",
        offset=0,
        limit=500,
    )

    assert result["total"] == 1
    assert result["items"] == [
        {
            "aNumber": "79001422737",
            "bNumbers": ["79001422737"],
            "sourcePrefix": "79105036319& null/$ & null/$ &",
            "linkedANumber": "79105036319",
        }
    ]
