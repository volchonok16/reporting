#!/usr/bin/env python3
"""Streaming 700k-row conversion and indexed A/B search benchmark."""

from __future__ import annotations

import argparse
import csv
import json
import platform
import resource
import shutil
import sys
import tempfile
import time
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from backend.importers import CsvImporter
from backend.mapping import MappingBuilder, MappingSerializer, MappingSpool
from backend.mapping_index import MappingIndexService
from backend.reporting import ReportWriter
from backend.validation import ValidationService


def peak_rss_bytes() -> int:
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == "darwin" else value * 1024)


def directory_size(path: Path) -> int:
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def write_source(path: Path, rows: int, unique_a: int) -> float:
    started = time.perf_counter()
    with path.open("w", encoding="utf-8", newline="") as target:
        writer = csv.writer(target, lineterminator="\n")
        writer.writerow(["A номер", "B номер"])
        for index in range(rows):
            a_number = str(79_000_000_000 + (index % unique_a))
            b_number = "" if index and index % 100_003 == 0 else str(
                78_000_000_000 + index
            )
            writer.writerow([a_number, b_number])
    return time.perf_counter() - started


def run(args: argparse.Namespace) -> dict[str, object]:
    if args.rows < 1 or args.unique_a < 1 or args.unique_a > args.rows:
        raise SystemExit("--rows and --unique-a must satisfy 1 <= unique-a <= rows")
    workspace = (
        Path(args.workspace).resolve()
        if args.workspace
        else Path(tempfile.mkdtemp(prefix="carousel-perf-"))
    )
    workspace.mkdir(parents=True, exist_ok=True)
    source = workspace / "input.csv"
    spool_path = workspace / "spool.sqlite3"
    report_path = workspace / "report.csv"
    result_path = workspace / "result.csv"
    index_path = workspace / "mapping-index.sqlite3"
    generated_seconds = write_source(source, args.rows, args.unique_a)

    import_started = time.perf_counter()
    with ReportWriter(report_path) as report, MappingSpool(spool_path) as spool:
        stats = MappingBuilder(spool, report).build_raw(
            CsvImporter(source).iterateRows("CSV"),
            a_column=0,
            b_column=1,
        )
        import_seconds = time.perf_counter() - import_started
        storage_after_import = directory_size(workspace)

        export_started = time.perf_counter()
        result_rows, result_size = MappingSerializer().write(
            spool.iter_mappings(), result_path
        )
        export_seconds = time.perf_counter() - export_started
        unique_a_count, unique_b_count = spool.counts()
        peak_storage = max(storage_after_import, directory_size(workspace))

    index_service = MappingIndexService(ValidationService())
    index_started = time.perf_counter()
    indexed = index_service.query(
        CsvImporter(source),
        index_path,
        requested_sheet="CSV",
        requested_mode="raw",
        a_column=0,
        b_column=1,
        query="",
        offset=0,
        limit=1,
    )
    index_build_seconds = time.perf_counter() - index_started
    searched_index = args.rows - 1
    if searched_index and searched_index % 100_003 == 0:
        searched_index -= 1
    searched_b = str(78_000_000_000 + searched_index)
    search_started = time.perf_counter()
    search_result = index_service.query(
        CsvImporter(source),
        index_path,
        requested_sheet="CSV",
        requested_mode="raw",
        a_column=0,
        b_column=1,
        query=searched_b,
        offset=0,
        limit=10,
    )
    search_seconds = time.perf_counter() - search_started
    broad_search_started = time.perf_counter()
    broad_search_result = index_service.query(
        CsvImporter(source),
        index_path,
        requested_sheet="CSV",
        requested_mode="raw",
        a_column=0,
        b_column=1,
        query="7",
        offset=0,
        limit=100,
    )
    broad_search_seconds = time.perf_counter() - broad_search_started
    peak_storage = max(peak_storage, directory_size(workspace))

    metrics: dict[str, object] = {
        "rows": args.rows,
        "uniqueA": unique_a_count,
        "uniqueB": unique_b_count,
        "resultRows": result_rows,
        "emptyBReplaced": stats["emptyBReplaced"],
        "duplicateBRemoved": stats["duplicateBRemoved"],
        "generateSeconds": round(generated_seconds, 3),
        "importSeconds": round(import_seconds, 3),
        "exportSeconds": round(export_seconds, 3),
        "indexBuildSeconds": round(index_build_seconds, 3),
        "indexedSearchSeconds": round(search_seconds, 6),
        "broadPrefixSearchSeconds": round(broad_search_seconds, 6),
        "totalProcessingSeconds": round(import_seconds + export_seconds, 3),
        "peakRssBytes": peak_rss_bytes(),
        "peakTempBytes": peak_storage,
        "inputBytes": source.stat().st_size,
        "resultBytes": result_size,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "workspace": str(workspace),
    }
    if unique_a_count != args.unique_a or result_rows != args.unique_a:
        raise AssertionError(
            f"expected {args.unique_a} result rows, got {result_rows}"
        )
    if (
        indexed["total"] != args.unique_a
        or search_result["total"] != 1
        or broad_search_result["total"] != args.unique_a
    ):
        raise AssertionError(
            "search index returned unexpected A/B counts: "
            f"{indexed['total']=}, {search_result['total']=}, "
            f"{broad_search_result['total']=}"
        )
    if args.max_seconds and import_seconds + export_seconds > args.max_seconds:
        raise AssertionError(
            f"processing exceeded {args.max_seconds}s: "
            f"{import_seconds + export_seconds:.3f}s"
        )
    if args.max_rss_mb and metrics["peakRssBytes"] > args.max_rss_mb * 1024 * 1024:
        raise AssertionError(
            f"peak RSS exceeded {args.max_rss_mb} MiB: "
            f"{metrics['peakRssBytes']} bytes"
        )
    slowest_search_seconds = max(search_seconds, broad_search_seconds)
    if (
        args.max_search_ms
        and slowest_search_seconds * 1_000 > args.max_search_ms
    ):
        raise AssertionError(
            f"indexed search exceeded {args.max_search_ms}ms: "
            f"{slowest_search_seconds * 1_000:.3f}ms"
        )

    if args.json_output:
        output = Path(args.json_output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(
            json.dumps(metrics, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    if not args.keep_workspace and not args.workspace:
        shutil.rmtree(workspace)
        metrics["workspace"] = "removed"
    return metrics


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, default=700_000)
    parser.add_argument("--unique-a", type=int, default=100_000)
    parser.add_argument("--workspace")
    parser.add_argument("--keep-workspace", action="store_true")
    parser.add_argument("--json-output")
    parser.add_argument("--max-seconds", type=float)
    parser.add_argument("--max-rss-mb", type=int)
    parser.add_argument("--max-search-ms", type=float)
    return parser.parse_args()


if __name__ == "__main__":
    run(parse_args())
