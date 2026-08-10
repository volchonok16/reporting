from __future__ import annotations

import json
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any

from .errors import AppError
from .importers import FileImporter, FormattedMappingImporter
from .mapping import MappingBuilder, MappingParser, MappingSpool
from .models import NO_REGION_PREFIX
from .reporting import ReportWriter
from .validation import ValidationService


class MappingIndexService:
    """Build and query a bounded-memory, per-upload A/B search index."""

    B_NUMBERS_PER_A_LIMIT = 200

    def __init__(self, validation: ValidationService):
        self.validation = validation
        self._locks_guard = threading.Lock()
        self._locks: dict[Path, threading.Lock] = {}

    def _lock_for(self, path: Path) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(path, threading.Lock())

    @staticmethod
    def _signature(
        requested_sheet: str | None,
        requested_mode: str,
        a_column: int,
        b_column: int,
    ) -> str:
        return json.dumps(
            {
                "sheet": requested_sheet,
                "mode": requested_mode,
                "aColumn": a_column,
                "bColumn": b_column,
                "version": 7,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    @staticmethod
    def _connect(path: Path) -> sqlite3.Connection:
        connection = sqlite3.connect(path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA temp_store=FILE")
        return connection

    def _matches_signature(self, path: Path, signature: str) -> bool:
        if not path.is_file():
            return False
        try:
            with self._connect(path) as connection:
                row = connection.execute(
                    "SELECT value FROM index_metadata WHERE key = 'signature'"
                ).fetchone()
                return row is not None and str(row["value"]) == signature
        except sqlite3.Error:
            return False

    def _build(
        self,
        importer: FileImporter,
        index_path: Path,
        *,
        signature: str,
        requested_sheet: str | None,
        requested_mode: str,
        a_column: int,
        b_column: int,
    ) -> None:
        selected, mode = self.validation.choose(
            importer,
            requested_sheet=requested_sheet,
            requested_mode=requested_mode,
        )
        temporary_path = index_path.with_name(f"{index_path.name}.building")
        report_path = index_path.with_name(f"{index_path.name}.report.building")
        for path in (
            temporary_path,
            temporary_path.with_name(f"{temporary_path.name}-wal"),
            temporary_path.with_name(f"{temporary_path.name}-shm"),
            report_path,
        ):
            path.unlink(missing_ok=True)

        try:
            with ReportWriter(report_path) as report, MappingSpool(
                temporary_path
            ) as spool:
                builder = MappingBuilder(spool, report)
                parser: MappingParser | None = None
                if mode == "raw":
                    stats = builder.build_raw(
                        importer.iterateRows(selected.name),
                        a_column=a_column,
                        b_column=b_column,
                        keep_duplicate_b=False,
                        replace_empty_b_with_a=False,
                    )
                else:
                    parser = MappingParser(
                        auto_detect=True,
                        allow_mixed_templates=True,
                    )
                    stats = builder.build_formatted(
                        FormattedMappingImporter(importer).iterateRows(selected.name),
                        parser=parser,
                        keep_duplicate_b=False,
                    )
                if (
                    stats["uniqueA"] == 0
                    or (mode == "formatted" and parser is not None
                        and parser.detected_template is None)
                ):
                    raise AppError(
                        "NO_VALID_MAPPINGS",
                        "Файл не содержит ни одной корректной связки",
                    )

            with self._connect(temporary_path) as connection:
                connection.executescript(
                    """
                    CREATE INDEX IF NOT EXISTS rows_b_a
                        ON rows(b_number, a_number);
                    CREATE INDEX IF NOT EXISTS mappings_first_sequence
                        ON mappings(first_sequence);
                    CREATE INDEX IF NOT EXISTS mappings_linked_a_number
                        ON mappings(linked_a_number);
                    CREATE TABLE IF NOT EXISTS index_metadata (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    ) WITHOUT ROWID;
                    """
                )
                metadata = {
                    "signature": signature,
                    "mode": mode,
                    "sheet": selected.name,
                    "uniqueA": str(stats["uniqueA"]),
                    "totalB": str(stats["totalB"]),
                    "invalidRows": str(stats["invalidRows"]),
                }
                connection.executemany(
                    """
                    INSERT OR REPLACE INTO index_metadata(key, value)
                    VALUES (?, ?)
                    """,
                    metadata.items(),
                )
                connection.commit()
                connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                connection.execute("PRAGMA journal_mode=DELETE")
            os.replace(temporary_path, index_path)
        finally:
            report_path.unlink(missing_ok=True)
            temporary_path.unlink(missing_ok=True)
            temporary_path.with_name(f"{temporary_path.name}-wal").unlink(
                missing_ok=True
            )
            temporary_path.with_name(f"{temporary_path.name}-shm").unlink(
                missing_ok=True
            )

    def _ensure(
        self,
        importer: FileImporter,
        index_path: Path,
        *,
        signature: str,
        requested_sheet: str | None,
        requested_mode: str,
        a_column: int,
        b_column: int,
    ) -> None:
        if self._matches_signature(index_path, signature):
            return
        with self._lock_for(index_path):
            if self._matches_signature(index_path, signature):
                return
            self._build(
                importer,
                index_path,
                signature=signature,
                requested_sheet=requested_sheet,
                requested_mode=requested_mode,
                a_column=a_column,
                b_column=b_column,
            )

    @staticmethod
    def _metadata(connection: sqlite3.Connection) -> dict[str, str]:
        return {
            str(row["key"]): str(row["value"])
            for row in connection.execute("SELECT key, value FROM index_metadata")
        }

    def query(
        self,
        importer: FileImporter,
        index_path: Path,
        *,
        requested_sheet: str | None,
        requested_mode: str,
        a_column: int,
        b_column: int,
        query: str,
        offset: int,
        limit: int,
    ) -> dict[str, Any]:
        signature = self._signature(
            requested_sheet,
            requested_mode,
            a_column,
            b_column,
        )
        self._ensure(
            importer,
            index_path,
            signature=signature,
            requested_sheet=requested_sheet,
            requested_mode=requested_mode,
            a_column=a_column,
            b_column=b_column,
        )

        normalized_query = query.strip()
        upper_bound = f"{normalized_query}\uffff"
        with self._connect(index_path) as connection:
            metadata = self._metadata(connection)
            if normalized_query:
                if len(normalized_query) <= 6:
                    matched_sql = """
                        SELECT m.a_number, m.first_sequence
                        FROM mappings AS m
                        WHERE (
                            m.a_number >= ? AND m.a_number < ?
                        ) OR EXISTS (
                            SELECT 1
                            FROM seen_b AS s
                            WHERE s.a_number = m.a_number
                              AND s.b_number >= ?
                              AND s.b_number < ?
                        ) OR (
                            m.linked_a_number >= ?
                            AND m.linked_a_number < ?
                        )
                    """
                    parameters: tuple[Any, ...] = (
                        normalized_query,
                        upper_bound,
                        normalized_query,
                        upper_bound,
                        normalized_query,
                        upper_bound,
                    )
                else:
                    matched_sql = """
                        SELECT m.a_number, m.first_sequence
                        FROM mappings AS m
                        WHERE m.a_number >= ? AND m.a_number < ?
                        UNION
                        SELECT m.a_number, m.first_sequence
                        FROM rows AS r
                        JOIN mappings AS m ON m.a_number = r.a_number
                        WHERE r.b_number >= ? AND r.b_number < ?
                        UNION
                        SELECT m.a_number, m.first_sequence
                        FROM mappings AS m
                        WHERE m.linked_a_number >= ?
                          AND m.linked_a_number < ?
                    """
                    parameters = (
                        normalized_query,
                        upper_bound,
                        normalized_query,
                        upper_bound,
                        normalized_query,
                        upper_bound,
                    )
                total = int(
                    connection.execute(
                        f"SELECT COUNT(*) FROM ({matched_sql})",
                        parameters,
                    ).fetchone()[0]
                )
                page = connection.execute(
                    f"""
                    SELECT a_number, first_sequence
                    FROM ({matched_sql})
                    ORDER BY first_sequence
                    LIMIT ? OFFSET ?
                    """,
                    (*parameters, limit, offset),
                ).fetchall()
            else:
                total = int(metadata["uniqueA"])
                page = connection.execute(
                    """
                    SELECT a_number, first_sequence
                    FROM mappings
                    ORDER BY first_sequence
                    LIMIT ? OFFSET ?
                    """,
                    (limit, offset),
                ).fetchall()

            a_numbers = [str(row["a_number"]) for row in page]
            b_by_a: dict[str, list[str]] = {a_number: [] for a_number in a_numbers}
            b_totals: dict[str, int] = {a_number: 0 for a_number in a_numbers}
            source_prefixes: dict[str, str] = {}
            linked_a_numbers: dict[str, str] = {}
            if a_numbers:
                placeholders = ",".join("?" for _ in a_numbers)
                for row in connection.execute(
                    f"""
                    SELECT a_number, source_prefix, linked_a_number
                    FROM mappings
                    WHERE a_number IN ({placeholders})
                    """,
                    a_numbers,
                ):
                    a_number = str(row["a_number"])
                    if row["source_prefix"] is not None:
                        source_prefixes[a_number] = str(row["source_prefix"])
                    if row["linked_a_number"] is not None:
                        linked_a_numbers[a_number] = str(row["linked_a_number"])
                for row in connection.execute(
                    f"""
                    SELECT a_number, COUNT(*) AS total
                    FROM rows
                    WHERE a_number IN ({placeholders})
                    GROUP BY a_number
                    """,
                    a_numbers,
                ):
                    b_totals[str(row["a_number"])] = int(row["total"])

                b_filter = ""
                b_parameters: list[Any] = list(a_numbers)
                if normalized_query:
                    mapping_query_matches = [
                        a_number
                        for a_number in a_numbers
                        if (
                            normalized_query <= a_number < upper_bound
                            or normalized_query
                            <= linked_a_numbers.get(a_number, "")
                            < upper_bound
                        )
                    ]
                    b_filter = "AND (r.b_number >= ? AND r.b_number < ?"
                    b_parameters.extend((normalized_query, upper_bound))
                    if mapping_query_matches:
                        a_match_placeholders = ",".join(
                            "?" for _ in mapping_query_matches
                        )
                        b_filter += (
                            f" OR r.a_number IN ({a_match_placeholders})"
                        )
                        b_parameters.extend(mapping_query_matches)
                    b_filter += ")"
                b_parameters.append(self.B_NUMBERS_PER_A_LIMIT)
                for row in connection.execute(
                    f"""
                    WITH ranked AS (
                        SELECT
                            r.a_number,
                            r.b_number,
                            r.sequence,
                            ROW_NUMBER() OVER (
                                PARTITION BY r.a_number
                                ORDER BY r.sequence
                            ) AS number_rank
                        FROM rows AS r
                        WHERE r.a_number IN ({placeholders})
                        {b_filter}
                    )
                    SELECT a_number, b_number
                    FROM ranked
                    WHERE number_rank <= ?
                    ORDER BY sequence
                    """,
                    b_parameters,
                ):
                    b_by_a[str(row["a_number"])].append(str(row["b_number"]))

        items: list[dict[str, Any]] = []
        for a_number in a_numbers:
            item: dict[str, Any] = {
                "aNumber": a_number,
                "bNumbers": b_by_a[a_number],
            }
            source_prefix = source_prefixes.get(a_number)
            if source_prefix and source_prefix != NO_REGION_PREFIX:
                item["sourcePrefix"] = source_prefix
            linked_a_number = linked_a_numbers.get(a_number)
            if linked_a_number:
                item["linkedANumber"] = linked_a_number
            if len(b_by_a[a_number]) < b_totals[a_number]:
                item["bTotal"] = b_totals[a_number]
                item["bTruncated"] = True
            items.append(item)
        return {
            "items": items,
            "total": total,
            "offset": offset,
            "limit": limit,
            "mode": metadata["mode"],
            "sheet": metadata["sheet"],
        }
