#!/usr/bin/env python3
"""Generate and verify the production-size master import reported by the user."""

from __future__ import annotations

import argparse
import csv
import resource
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

from backend.config import settings
from backend.master import MasterService
from backend.models import HEADER, MasterImportAnalyzeRequest, MasterMergeRequest
from backend.storage import Registry, UploadRecord, opaque_id
from backend.validation import ValidationService


SOURCE_ROWS = 726_779
UNIQUE_A = 716_000
DUPLICATE_ROWS = SOURCE_ROWS - UNIQUE_A
PREFIX = "null/$ & null/$ & null/$ &"


def formatted_line(a_number: int, b_number: int) -> str:
    return f"{PREFIX}{a_number}=4:4,1,{b_number}"


def generate_fixture(source: Path) -> None:
    source.parent.mkdir(parents=True, exist_ok=True)
    with source.open("w", encoding="utf-8", newline="") as target:
        writer = csv.writer(target, lineterminator="\n")
        writer.writerow([HEADER])
        for index in range(UNIQUE_A):
            writer.writerow(
                [
                    formatted_line(
                        7_100_000_0000 + index,
                        7_200_000_0000 + index,
                    )
                ]
            )
        for index in range(DUPLICATE_ROWS):
            writer.writerow(
                [
                    formatted_line(
                        7_100_000_0000 + index,
                        7_300_000_0000 + index,
                    )
                ]
            )


def run_load_test(root_path: Path) -> None:
    config = replace(settings, data_dir=root_path / "data")
    registry = Registry(config)
    service = MasterService(
        config,
        registry,
        ValidationService(config.preview_limit),
    )
    session_id = "master-production-load-test"
    upload_id = opaque_id()
    upload_dir = config.data_dir / "uploads" / upload_id
    upload_dir.mkdir(parents=True)
    source = upload_dir / "source"

    generation_started = time.monotonic()
    generate_fixture(source)

    now = time.time()
    registry.add_upload(
        UploadRecord(
            id=upload_id,
            session_id=session_id,
            name="master-726779.csv",
            size=source.stat().st_size,
            format="csv",
            path=source,
            created_at=now,
            expires_at=now + 3600,
        )
    )
    analysis_started = time.monotonic()
    analysis = service.analyze_import(
        MasterImportAnalyzeRequest(uploadId=upload_id),
        session_id,
    )
    stats = analysis["stats"]
    assert stats["sourceRows"] == SOURCE_ROWS, stats
    assert stats["uniqueA"] == UNIQUE_A, stats
    assert stats["duplicateA"] == DUPLICATE_ROWS, stats
    assert stats["invalidRows"] == 0, stats
    assert stats["skippedRows"] == 0, stats
    assert (
        stats["uniqueA"]
        + stats["duplicateA"]
        + stats["invalidRows"]
        + stats["skippedRows"]
        == stats["sourceRows"]
    )

    merge_started = time.monotonic()
    merged = service.merge_import(
        analysis["importId"],
        MasterMergeRequest(),
        session_id,
    )
    assert merged["added"] == UNIQUE_A, merged
    records = service.list_records(query="", offset=0, limit=1)
    assert records["activeCount"] == UNIQUE_A, records
    peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    peak_rss_mib = (
        peak_rss / (1024 * 1024) if sys.platform == "darwin" else peak_rss / 1024
    )

    print(
        {
            "fileBytes": source.stat().st_size,
            "sourceRows": stats["sourceRows"],
            "uniqueA": stats["uniqueA"],
            "duplicateA": stats["duplicateA"],
            "invalidRows": stats["invalidRows"],
            "generationSeconds": round(analysis_started - generation_started, 2),
            "analysisSeconds": round(merge_started - analysis_started, 2),
            "mergeSeconds": round(time.monotonic() - merge_started, 2),
            "peakRssMiB": round(peak_rss_mib, 1),
        }
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--fixture-only",
        type=Path,
        help="Generate the 726779-row CSV at this path without importing it.",
    )
    arguments = parser.parse_args()
    if arguments.fixture_only is not None:
        generate_fixture(arguments.fixture_only)
        print(
            {
                "fixture": str(arguments.fixture_only),
                "bytes": arguments.fixture_only.stat().st_size,
                "sourceRows": SOURCE_ROWS,
            }
        )
        return
    with tempfile.TemporaryDirectory(prefix="carousel-master-load-") as root:
        run_load_test(Path(root))


if __name__ == "__main__":
    main()
