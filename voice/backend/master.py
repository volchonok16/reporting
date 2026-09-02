from __future__ import annotations

import csv
import json
import logging
import re
import shutil
import sqlite3
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Iterable

from .config import Settings
from .errors import AppError, CancelledError
from .importers import FormattedMappingImporter, importer_for
from .mapping import MappingBuilder, MappingParser
from .models import (
    HEADER,
    NO_REGION_PREFIX,
    MasterImportAnalyzeRequest,
    MasterMergeRequest,
    MasterRecordFilterRequest,
    MasterRecordRequest,
    Mapping,
    PANI_REGION_PREFIX_PATTERN,
    TemplateSettings,
    canonicalize_pani_region_prefix,
    is_single_short_aon,
    resolved_first_b_marker,
)
from .pg_db import PgConnection, configure as configure_master_db, connect as pg_connect
from .reporting import ReportWriter
from .security import normalize_number
from .storage import Registry
from .validation import ValidationService

from psycopg.pq import TransactionStatus


logger = logging.getLogger(__name__)

# Размер батча compare/merge (раньше 500): меньше round-trip к PostgreSQL.
MASTER_IMPORT_BATCH_SIZE = 5000


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _pick_compare_master_row(
    candidates: list[Any],
    *,
    b_json: str,
    prefix: str,
) -> Any | None:
    """Жадный 1:1 match: точная активная связка → любая активная → soft-deleted."""
    if not candidates:
        return None
    exact_active: list[Any] = []
    active: list[Any] = []
    soft: list[Any] = []
    for row in candidates:
        if row["deleted_at"] is not None:
            soft.append(row)
            continue
        if (
            str(row["b_numbers_json"]) == b_json
            and str(row["source_prefix"]) == prefix
        ):
            exact_active.append(row)
        else:
            active.append(row)
    chosen = (
        exact_active[0]
        if exact_active
        else active[0]
        if active
        else soft[0]
        if soft
        else None
    )
    if chosen is not None:
        candidates.remove(chosen)
    return chosen


def _logical_master_row(
    a_number: str,
    b_numbers_json: str,
    source_prefix: str,
) -> str:
    try:
        decoded = json.loads(str(b_numbers_json))
    except (TypeError, ValueError, json.JSONDecodeError):
        decoded = []
    b_numbers = [str(value) for value in decoded] if isinstance(decoded, list) else []
    prefix = canonicalize_pani_region_prefix(str(source_prefix))
    if not b_numbers:
        return f"{prefix}{a_number}="
    first_marker = resolved_first_b_marker(b_numbers)
    first = f"{first_marker},1,{b_numbers[0]}"
    rest = "".join(f";4,1,{number}" for number in b_numbers[1:])
    return f"{prefix}{a_number}={first}{rest}"


def _full_row_search_query(query: str) -> str:
    normalized = query.strip()
    if len(normalized) >= 2 and normalized.startswith('"') and normalized.endswith('"'):
        normalized = normalized[1:-1].strip()
    if "=" in normalized:
        normalized = normalized.removesuffix(";").rstrip()
    return normalized


def _like_contains(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _import_failure_message(error: BaseException) -> str:
    detail = " ".join(str(error).split())
    if len(detail) > 280:
        detail = detail[:277] + "..."
    lowered = detail.lower()
    if "index row size" in lowered or "btree" in lowered:
        return (
            "Не удалось проверить файл: слишком длинная связка B для индекса "
            f"PostgreSQL. {detail}"
        )
    if detail:
        return f"Не удалось проверить файл. {detail}"
    return "Не удалось проверить файл. Повторите загрузку."


MASTER_EXACT_DUPLICATE_EXTRA_SQL = """
(
    EXISTS (
        SELECT 1
        FROM master_exact_counts AS selected_exact_duplicate_count
        WHERE selected_exact_duplicate_count.signature_hash = master_exact_signature(
                master_records.a_number,
                master_records.b_numbers_json,
                master_records.source_prefix
              )
          AND selected_exact_duplicate_count.active_count > 1
    )
    AND master_records.id <> (
        SELECT original_exact_duplicate.id
        FROM master_records AS original_exact_duplicate
        WHERE original_exact_duplicate.deleted_at IS NULL
          AND original_exact_duplicate.a_number = master_records.a_number
          AND original_exact_duplicate.source_prefix = master_records.source_prefix
          AND master_b_signature(
                original_exact_duplicate.b_numbers_json,
                original_exact_duplicate.source_prefix
              ) = master_b_signature(
                master_records.b_numbers_json,
                master_records.source_prefix
              )
        ORDER BY original_exact_duplicate.sort_order, original_exact_duplicate.id
        LIMIT 1
    )
)
"""

MASTER_SHORT_AON_SQL = """
(
    json_array_length(master_records.b_numbers_json) = 1
    AND length(
        CAST(json_extract(master_records.b_numbers_json, '$[0]') AS TEXT)
    ) BETWEEN 3 AND 5
    AND master_is_digits(
        CAST(json_extract(master_records.b_numbers_json, '$[0]') AS TEXT)
    )
)
"""


class MasterImportSpool:
    """In-memory import rows that preserve every physical source row.

    Voice master storage is PostgreSQL; this spool is only a transient parse
    buffer for the reading phase (no SQLite).
    """

    preserve_duplicate_a = True

    def __init__(self, path: Path | None = None):
        del path  # kept for call-site compatibility; unused
        self._first_sequence = 1
        self._first_a: dict[str, int] = {}
        # (a_number, source_row) -> index into _entries
        self._entry_index: dict[tuple[str, int], int] = {}
        self._entries: list[dict[str, Any]] = []
        self._row_count = 0
        # a_number -> ordered unique source rows (first + duplicates)
        self._duplicate_rows: dict[str, list[int]] = {}

    def add_a(
        self,
        a_number: str,
        source_row: int,
        *,
        source_prefix: str | None = None,
        linked_a_number: str | None = None,
    ) -> bool:
        del linked_a_number
        first = a_number not in self._first_a
        if first:
            self._first_a[a_number] = source_row
        key = (a_number, source_row)
        if key not in self._entry_index:
            self._entry_index[key] = len(self._entries)
            self._entries.append(
                {
                    "a_number": a_number,
                    "first_sequence": self._first_sequence,
                    "source_row": source_row,
                    "source_prefix": source_prefix,
                    "b_numbers": [],
                    "seen_b": set(),
                }
            )
            self._first_sequence += 1
        return first

    def add(
        self,
        a_number: str,
        b_number: str,
        source_row: int,
        *,
        keep_duplicate: bool,
        source_prefix: str | None = None,
        linked_a_number: str | None = None,
    ) -> tuple[bool, bool]:
        first = self.add_a(
            a_number,
            source_row,
            source_prefix=source_prefix,
            linked_a_number=linked_a_number,
        )
        entry = self._entries[self._entry_index[(a_number, source_row)]]
        if entry["source_prefix"] is None and source_prefix is not None:
            entry["source_prefix"] = source_prefix
        duplicate = False
        if not keep_duplicate:
            seen: set[str] = entry["seen_b"]
            if b_number in seen:
                duplicate = True
            else:
                seen.add(b_number)
        if not duplicate:
            entry["b_numbers"].append(b_number)
            self._row_count += 1
        return first, duplicate

    def source_row_for_a(self, a_number: str) -> int | None:
        return self._first_a.get(a_number)

    def remember_duplicate(
        self,
        a_number: str,
        first_source_row: int,
        duplicate_source_row: int,
    ) -> None:
        rows = self._duplicate_rows.get(a_number)
        if rows is None:
            self._duplicate_rows[a_number] = [first_source_row, duplicate_source_row]
            return
        if first_source_row not in rows:
            rows.append(first_source_row)
        if duplicate_source_row not in rows:
            rows.append(duplicate_source_row)

    def duplicate_group_count(self) -> int:
        return len(self._duplicate_rows)

    def iter_duplicate_findings(self) -> Iterable[tuple[str, list[int]]]:
        for a_number in sorted(self._duplicate_rows):
            rows = sorted(set(self._duplicate_rows[a_number]))[:500]
            yield a_number, rows

    def counts(self) -> tuple[int, int]:
        return len(self._first_a), self._row_count

    def mapping_count(self) -> int:
        return len(self._entries)

    def iter_mapping_entries(self) -> Iterable[tuple[Mapping, int]]:
        for entry in self._entries:
            b_numbers = list(entry["b_numbers"])
            if not b_numbers:
                continue
            yield (
                Mapping(
                    aNumber=str(entry["a_number"]),
                    bNumbers=b_numbers,
                    firstSeenOrder=int(entry["first_sequence"]),
                    sourcePrefix=(
                        str(entry["source_prefix"])
                        if entry["source_prefix"] is not None
                        else None
                    ),
                ),
                int(entry["source_row"]),
            )

    def commit(self) -> None:
        return

    def close(self) -> None:
        return

    def __enter__(self) -> "MasterImportSpool":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()



def _snapshot(row: sqlite3.Row | dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "id": str(row["id"]),
        "aNumber": str(row["a_number"]),
        "bNumbers": json.loads(str(row["b_numbers_json"])),
        "sourcePrefix": str(row["source_prefix"]),
        "comment": str(row["comment"] or ""),
        "version": int(row["version"]),
    }


def _region_number(value: str) -> int | None:
    standalone = re.fullmatch(r"null/\$ & null&D?([0-9]+)\$&", value)
    combined = re.fullmatch(
        r"\+?[0-9]+& D?([0-9]+)\$&null&", value
    ) or re.fullmatch(r"\+?[0-9]+& null&D?([0-9]+)\$&", value)
    match = standalone or combined
    if match is None:
        return None
    token = match.group(1)
    if not token.isdigit():
        return None
    number = int(token)
    return number if 1 <= number <= 84 else None


def _pani_region_parts(value: str) -> tuple[str, int] | None:
    match = re.fullmatch(
        r"\+?([0-9]{11})& D?([0-9]+)\$&null&", value
    ) or re.fullmatch(r"\+?([0-9]{11})& null&D?([0-9]+)\$&", value)
    if match is None:
        return None
    pani, region = match.groups()
    region_number = int(region)
    if not 1 <= region_number <= 84:
        return None
    return pani, region_number


def _number_starts_with_seven(value: str) -> bool:
    return value.removeprefix("+").startswith("7")


def _number_start_errors(
    payload: dict[str, Any],
    *,
    source_row: int,
    item_id: str | None = None,
) -> list[dict[str, Any]]:
    errors: list[dict[str, Any]] = []
    a_number = str(payload["aNumber"])
    if not _number_starts_with_seven(a_number):
        errors.append(
            {
                "itemId": item_id,
                "sourceRow": source_row,
                "kind": "a",
                "number": a_number,
                "aNumber": a_number,
            }
        )
    b_numbers = [str(value) for value in payload["bNumbers"]]
    short_aon = is_single_short_aon(b_numbers)
    for b_number in b_numbers:
        value = str(b_number)
        if not short_aon and not _number_starts_with_seven(value):
            errors.append(
                {
                    "itemId": item_id,
                    "sourceRow": source_row,
                    "kind": "b",
                    "number": value,
                    "aNumber": a_number,
                }
            )
    return errors


def _query_tokens(query: str) -> list[str]:
    tokens = list(
        dict.fromkeys(
            token.removeprefix("+")
            for token in re.split(r"[\s,;]+", query.strip())
            if token.strip()
        )
    )
    if len(tokens) > 500:
        raise AppError(
            "TOO_MANY_SEARCH_NUMBERS",
            "За один поиск можно указать не более 500 номеров",
        )
    return tokens


def _parameter_group(value: str) -> tuple[str, str]:
    if value == NO_REGION_PREFIX:
        return "default", "По умолчанию"
    if _pani_region_parts(value) is not None:
        return "pani_region", "С PANI и кодом региона"
    if re.fullmatch(r"[0-9]{11}& null/\$ & null/\$ &", value):
        return "pani", "С PANI"
    if _region_number(value) is not None:
        return "region", "С кодом региона"
    return "custom", "Другие параметры"


# GLOB [0-9]* means "one digit + anything"; use eleven explicit digits
# so SQL filters stay aligned with _parameter_group / _pani_region_parts.
_ELEVEN_DIGIT_GLOB = "[0-9]" * 11
_MAX_CACHED_FILTER_PREFIXES = 8000


def _pani_glob_patterns() -> tuple[str, ...]:
    return (
        f"{_ELEVEN_DIGIT_GLOB}& null/$ & null/$ &",
        f"+{_ELEVEN_DIGIT_GLOB}& null/$ & null/$ &",
    )


def _pani_region_glob_patterns() -> tuple[str, ...]:
    patterns: list[str] = []
    for sign in ("", "+"):
        body = f"{sign}{_ELEVEN_DIGIT_GLOB}"
        patterns.extend(
            (
                f"{body}& D[0-9]*$&null&",
                f"{body}& [0-9]*$&null&",
                f"{body}& null&D[0-9]*$&",
                f"{body}& null&[0-9]*$&",
            )
        )
    return tuple(patterns)


def _remember_filter_prefix(
    buckets: dict[str, list[str] | None],
    group_id: str,
    prefix: str,
) -> None:
    current = buckets.get(group_id)
    if group_id in buckets and current is None:
        return
    if current is None:
        buckets[group_id] = [prefix]
        return
    if len(current) >= _MAX_CACHED_FILTER_PREFIXES:
        buckets[group_id] = None
        return
    current.append(prefix)


class MasterService:
    """Durable local master branch with optimistic, revisioned merges."""

    def __init__(
        self,
        config: Settings,
        registry: Registry,
        validation: ValidationService,
    ):
        self.config = config
        self.registry = registry
        self.validation = validation
        self._lock = threading.RLock()
        self._analysis_executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="master-analysis",
        )
        self._pending_merges: dict[str, tuple[MasterMergeRequest, str]] = {}
        self._merge_cancellations: dict[str, threading.Event] = {}
        self._merge_backends: dict[str, int] = {}
        self._list_stats_lock = threading.Lock()
        self._list_stats_revision: int | None = None
        self._list_stats_cache: dict[str, Any] | None = None
        self._initialize()
        self._resume_interrupted_analyses()
        self._reset_interrupted_merges()

    def _connect(self) -> PgConnection:
        if getattr(self.config, "database_url", None):
            configure_master_db(self.config.database_url)
        else:
            configure_master_db()
        return pg_connect()

    def _initialize(self) -> None:
        """Ensure seed/meta rows; schema comes from reporting migration 050."""
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO master_state(id, current_revision)
                VALUES (1, 0)
                ON CONFLICT (id) DO NOTHING
                """
            )
            if connection.execute(
                "SELECT 1 FROM master_schema_meta "
                "WHERE key = 'canonical_pani_region_prefixes'"
            ).fetchone() is None:
                legacy_prefixes = connection.execute(
                    """
                    SELECT DISTINCT source_prefix
                    FROM master_records
                    WHERE master_glob_match(source_prefix, '[0-9]*& null&D[0-9]*$&')
                       OR master_glob_match(source_prefix, '+[0-9]*& null&D[0-9]*$&')
                    """
                ).fetchall()
                for prefix_row in legacy_prefixes:
                    legacy_prefix = str(prefix_row["source_prefix"])
                    canonical_prefix = canonicalize_pani_region_prefix(
                        legacy_prefix
                    )
                    if canonical_prefix != legacy_prefix:
                        connection.execute(
                            "UPDATE master_records SET source_prefix = ? "
                            "WHERE source_prefix = ?",
                            (canonical_prefix, legacy_prefix),
                        )
                connection.execute(
                    "INSERT INTO master_schema_meta(key, value) VALUES (?, ?)",
                    ("canonical_pani_region_prefixes", "1"),
                )
            if connection.execute(
                "SELECT 1 FROM master_schema_meta "
                "WHERE key = 'sparse_exact_duplicate_counts'"
            ).fetchone() is None:
                connection.execute("DELETE FROM master_exact_counts")
                connection.execute(
                    """
                    INSERT INTO master_exact_counts(
                        signature_hash, a_number, b_numbers_json,
                        source_prefix, active_count
                    )
                    SELECT
                        master_exact_signature(
                            a_number, b_numbers_json, source_prefix
                        ),
                        a_number, b_numbers_json, source_prefix, COUNT(*)
                    FROM master_records
                    WHERE deleted_at IS NULL
                    GROUP BY a_number, b_numbers_json, source_prefix
                    HAVING COUNT(*) > 1
                    """
                )
                connection.execute(
                    "INSERT INTO master_schema_meta(key, value) VALUES (?, ?)",
                    ("sparse_exact_duplicate_counts", "1"),
                )
            if (
                connection.execute(
                    "SELECT 1 FROM master_a_counts LIMIT 1"
                ).fetchone()
                is None
                and connection.execute(
                    "SELECT 1 FROM master_records WHERE deleted_at IS NULL LIMIT 1"
                ).fetchone()
                is not None
            ):
                connection.execute(
                    """
                    INSERT INTO master_a_counts(a_number, active_count)
                    SELECT a_number, COUNT(*)
                    FROM master_records
                    WHERE deleted_at IS NULL
                    GROUP BY a_number
                    """
                )

    @staticmethod
    def _current_revision(connection: sqlite3.Connection) -> int:
        row = connection.execute(
            "SELECT current_revision FROM master_state WHERE id = 1"
        ).fetchone()
        return int(row["current_revision"])

    @staticmethod
    def _active_line(
        connection: sqlite3.Connection, sort_order: int
    ) -> int:
        row = connection.execute(
            """
            SELECT COUNT(*) AS count
            FROM master_records
            WHERE deleted_at IS NULL AND sort_order <= ?
            """,
            (sort_order,),
        ).fetchone()
        return int(row["count"])

    @staticmethod
    def _active_lines(
        connection: sqlite3.Connection, sort_orders: Iterable[int]
    ) -> dict[int, int]:
        unique_orders = list(dict.fromkeys(int(value) for value in sort_orders))
        if not unique_orders:
            return {}
        if len(unique_orders) == 1:
            order = unique_orders[0]
            return {order: MasterService._active_line(connection, order)}
        # One window scan for large batches; per-order COUNT for small sets.
        if len(unique_orders) >= 64:
            rows = connection.execute(
                """
                SELECT sort_order, MAX(line_number) AS count
                FROM (
                    SELECT
                        sort_order,
                        ROW_NUMBER() OVER (ORDER BY sort_order, id)
                            AS line_number
                    FROM master_records
                    WHERE deleted_at IS NULL
                ) AS numbered
                WHERE sort_order = ANY(?)
                GROUP BY sort_order
                """,
                (unique_orders,),
            ).fetchall()
            return {
                int(row["sort_order"]): int(row["count"]) for row in rows
            }
        parts: list[str] = []
        values: list[int] = []
        for order in unique_orders:
            parts.append(
                """
                SELECT ? AS sort_order, (
                    SELECT COUNT(*)
                    FROM master_records
                    WHERE deleted_at IS NULL AND sort_order <= ?
                ) AS count
                """
            )
            values.extend([order, order])
        rows = connection.execute(
            " UNION ALL ".join(parts),
            values,
        ).fetchall()
        return {int(row["sort_order"]): int(row["count"]) for row in rows}

    def _list_global_stats(
        self, connection: sqlite3.Connection
    ) -> dict[str, Any]:
        revision = self._current_revision(connection)
        with self._list_stats_lock:
            cached = self._list_stats_cache
            if (
                cached is not None
                and self._list_stats_revision == revision
            ):
                return cached

        active = int(
            connection.execute(
                "SELECT COUNT(*) AS count FROM master_records WHERE deleted_at IS NULL"
            ).fetchone()["count"]
        )
        total_b = int(
            connection.execute(
                """
                SELECT COALESCE(SUM(json_array_length(b_numbers_json)), 0) AS count
                FROM master_records WHERE deleted_at IS NULL
                """
            ).fetchone()["count"]
        )
        history_count = int(
            connection.execute(
                "SELECT COUNT(*) AS count FROM master_changes"
            ).fetchone()["count"]
        )
        invalid_a_count = int(
            connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM master_records
                WHERE deleted_at IS NULL AND length(a_number) <> 11
                """
            ).fetchone()["count"]
        )
        invalid_b_count = int(
            connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM master_records AS record,
                     json_each(record.b_numbers_json) AS aon
                WHERE record.deleted_at IS NULL
                  AND length(CAST(aon.value AS TEXT)) <> 11
                  AND NOT (
                    json_array_length(record.b_numbers_json) = 1
                    AND length(CAST(aon.value AS TEXT)) BETWEEN 3 AND 5
                    AND CAST(aon.value AS TEXT) NOT GLOB '*[^0-9]*'
                  )
                """
            ).fetchone()["count"]
        )
        invalid_record_count = int(
            connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM master_records
                WHERE deleted_at IS NULL
                  AND (
                    length(a_number) <> 11
                    OR (
                        NOT {MASTER_SHORT_AON_SQL}
                        AND EXISTS (
                            SELECT 1
                            FROM json_each(b_numbers_json) AS invalid_aon
                            WHERE length(CAST(invalid_aon.value AS TEXT)) <> 11
                        )
                    )
                  )
                """.format(MASTER_SHORT_AON_SQL=MASTER_SHORT_AON_SQL)
            ).fetchone()["count"]
        )
        invalid_start_a_count = int(
            connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM master_records
                WHERE deleted_at IS NULL
                  AND substr(a_number, 1, 1) <> '7'
                """
            ).fetchone()["count"]
        )
        invalid_start_b_count = int(
            connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM master_records AS record,
                     json_each(record.b_numbers_json) AS aon
                WHERE record.deleted_at IS NULL
                  AND substr(CAST(aon.value AS TEXT), 1, 1) <> '7'
                  AND NOT (
                    json_array_length(record.b_numbers_json) = 1
                    AND length(CAST(aon.value AS TEXT)) BETWEEN 3 AND 5
                    AND CAST(aon.value AS TEXT) NOT GLOB '*[^0-9]*'
                  )
                """
            ).fetchone()["count"]
        )
        invalid_start_record_count = int(
            connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM master_records
                WHERE deleted_at IS NULL
                  AND (
                    substr(a_number, 1, 1) <> '7'
                    OR (
                        NOT {MASTER_SHORT_AON_SQL}
                        AND EXISTS (
                            SELECT 1
                            FROM json_each(b_numbers_json) AS invalid_start_aon
                            WHERE substr(CAST(invalid_start_aon.value AS TEXT), 1, 1) <> '7'
                        )
                    )
                  )
                """.format(MASTER_SHORT_AON_SQL=MASTER_SHORT_AON_SQL)
            ).fetchone()["count"]
        )
        short_aon_record_count = int(
            connection.execute(
                f"""
                SELECT COUNT(*) AS count
                FROM master_records
                WHERE deleted_at IS NULL
                  AND {MASTER_SHORT_AON_SQL}
                """
            ).fetchone()["count"]
        )
        grouped_parameters: dict[str, dict[str, Any]] = {}
        region_counts = {number: 0 for number in range(1, 85)}
        prefixes_by_group: dict[str, list[str] | None] = {}
        prefixes_by_region: dict[int, list[str]] = {
            number: [] for number in range(1, 85)
        }
        for row in connection.execute(
            """
            SELECT source_prefix, COUNT(*) AS count
            FROM master_records
            WHERE deleted_at IS NULL
            GROUP BY source_prefix
            ORDER BY count DESC, source_prefix COLLATE NOCASE
            """
        ):
            prefix = str(row["source_prefix"])
            group_id, label = _parameter_group(prefix)
            group = grouped_parameters.setdefault(
                group_id,
                {"id": group_id, "label": label, "count": 0},
            )
            group["count"] += int(row["count"])
            _remember_filter_prefix(prefixes_by_group, group_id, prefix)
            region_number = _region_number(prefix)
            if region_number is not None:
                region_counts[region_number] += int(row["count"])
                prefixes_by_region[region_number].append(prefix)
        group_order = {
            "default": 0,
            "pani": 1,
            "region": 2,
            "pani_region": 3,
            "custom": 4,
        }
        parameter_options = sorted(
            grouped_parameters.values(),
            key=lambda item: (
                group_order.get(str(item["id"]), 4),
                str(item["label"]),
            ),
        )
        duplicate_count = int(
            connection.execute(
                """
                SELECT COALESCE(SUM(active_count), 0) AS count
                FROM master_a_counts
                WHERE active_count > 1
                """
            ).fetchone()["count"]
        )
        exact_duplicate_count = int(
            connection.execute(
                """
                SELECT COALESCE(SUM(active_count), 0) AS count
                FROM master_exact_counts
                WHERE active_count > 1
                """
            ).fetchone()["count"]
        )
        exact_duplicate_extra_count = int(
            connection.execute(
                """
                SELECT COALESCE(SUM(active_count - 1), 0) AS count
                FROM master_exact_counts
                WHERE active_count > 1
                """
            ).fetchone()["count"]
        )
        stats = {
            "revision": revision,
            "activeCount": active,
            "totalB": total_b,
            "historyCount": history_count,
            "invalidANumberCount": invalid_a_count,
            "invalidBNumberCount": invalid_b_count,
            "invalidRecordCount": invalid_record_count,
            "invalidStartANumberCount": invalid_start_a_count,
            "invalidStartBNumberCount": invalid_start_b_count,
            "invalidStartRecordCount": invalid_start_record_count,
            "shortAonRecordCount": short_aon_record_count,
            "parameterOptions": parameter_options,
            "regionOptions": [
                {"value": number, "count": region_counts[number]}
                for number in range(1, 85)
            ],
            "duplicateCount": duplicate_count,
            "exactDuplicateCount": exact_duplicate_count,
            "exactDuplicateExtraCount": exact_duplicate_extra_count,
            # Server-only: used to build fast IN filters (not returned to UI).
            "prefixesByGroup": prefixes_by_group,
            "prefixesByRegion": prefixes_by_region,
        }
        with self._list_stats_lock:
            self._list_stats_revision = revision
            self._list_stats_cache = stats
        return stats

    def _invalidate_list_stats_cache(self) -> None:
        with self._list_stats_lock:
            self._list_stats_revision = None
            self._list_stats_cache = None

    @staticmethod
    def _record_payload(row: sqlite3.Row, line_number: int) -> dict[str, Any]:
        logical_row = _logical_master_row(
            str(row["a_number"]),
            str(row["b_numbers_json"]),
            str(row["source_prefix"]),
        )
        return {
            "id": str(row["id"]),
            "lineNumber": line_number,
            "aNumber": str(row["a_number"]),
            "bNumbers": json.loads(str(row["b_numbers_json"])),
            "sourcePrefix": str(row["source_prefix"]),
            "comment": str(row["comment"] or ""),
            "version": int(row["version"]),
            "createdAt": float(row["created_at"]),
            "updatedAt": float(row["updated_at"]),
            "createdRevision": int(row["created_revision"]),
            "updatedRevision": int(row["updated_revision"]),
            "logicalRow": logical_row,
        }

    @staticmethod
    def _normalize_record(body: MasterRecordRequest) -> dict[str, Any]:
        a_number = normalize_number(
            body.aNumber,
            source_row=1,
            field="A",
            allow_whitespace_error=True,
        )
        if not a_number:
            raise AppError("INVALID_A_NUMBER", "Укажите опорный номер")
        b_numbers: list[str] = []
        seen: set[str] = set()
        raw_b_numbers = body.bNumbers or [a_number]
        for index, raw in enumerate(raw_b_numbers, start=1):
            number = normalize_number(
                raw,
                source_row=index,
                field="B",
                allow_whitespace_error=True,
            )
            if not number:
                raise AppError("INVALID_B_NUMBER", "Укажите хотя бы один АОН")
            if number not in seen:
                seen.add(number)
                b_numbers.append(number)
        prefix = canonicalize_pani_region_prefix(
            body.sourcePrefix or NO_REGION_PREFIX
        )
        try:
            TemplateSettings(prefix=prefix)
        except ValueError as exc:
            raise AppError(
                "INVALID_PREFIX",
                "Параметр строки имеет некорректный формат",
            ) from exc
        return {
            "aNumber": a_number,
            "bNumbers": b_numbers,
            "sourcePrefix": prefix,
            "comment": (body.comment or "").strip(),
        }

    @staticmethod
    def _import_item_payload(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": str(row["id"]),
            "status": str(row["status"]),
            "sourceRow": int(row["source_row"]),
            "aNumber": str(row["a_number"]),
            "incoming": json.loads(str(row["incoming_json"])),
            "current": (
                json.loads(str(row["current_json"]))
                if row["current_json"]
                else None
            ),
        }

    @staticmethod
    def _import_number_start_errors(
        connection: sqlite3.Connection,
        import_id: str,
        *,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        return [
            {
                "itemId": str(row["item_id"]),
                "sourceRow": int(row["source_row"]),
                "kind": str(row["kind"]),
                "number": str(row["number"]),
                "aNumber": str(row["a_number"]),
                "status": str(row["status"]),
            }
            for row in connection.execute(
            """
            SELECT item_id, source_row, kind, number, a_number, status
            FROM master_import_number_warnings
            WHERE import_id = ?
            ORDER BY source_row, item_id
            LIMIT ?
            """,
            (import_id, limit),
        )
        ]

    @staticmethod
    def _import_number_start_counts(
        connection: sqlite3.Connection,
        import_id: str,
    ) -> tuple[int, int]:
        row = connection.execute(
            """
            SELECT COUNT(*) AS numbers, COUNT(DISTINCT source_row) AS rows
            FROM master_import_number_warnings
            WHERE import_id = ?
            """,
            (import_id,),
        ).fetchone()
        return int(row["rows"]), int(row["numbers"])

    @staticmethod
    def _allocate_ids(
        connection: sqlite3.Connection, table: str, count: int
    ) -> list[int]:
        if count <= 0:
            return []
        if table not in {
            "master_records",
            "master_imports",
            "master_import_items",
            "master_changes",
        }:
            raise ValueError(f"unsupported id table: {table}")
        rows = connection.execute(
            f"""
            SELECT nextval(pg_get_serial_sequence('{table}', 'id')) AS id
            FROM generate_series(1, ?)
            """,
            (count,),
        ).fetchall()
        return [int(row["id"]) for row in rows]

    @staticmethod
    def _append_change(
        connection: sqlite3.Connection,
        *,
        revision: int,
        sequence: int,
        record_id: str,
        action: str,
        line_number: int | None,
        before: dict[str, Any] | None,
        after: dict[str, Any] | None,
        source_file: str | None,
        source_row: int | None,
        actor: str,
        created_at: float,
    ) -> None:
        connection.execute(
            """
            INSERT INTO master_changes(
                revision, sequence, record_id, action, line_number,
                before_json, after_json, source_file, source_row, actor,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                revision,
                sequence,
                int(record_id),
                action,
                line_number,
                _json(before) if before is not None else None,
                _json(after) if after is not None else None,
                source_file,
                source_row,
                actor,
                created_at,
            ),
        )

    @staticmethod
    def _append_changes_many(
        connection: sqlite3.Connection,
        rows: list[tuple[Any, ...]],
    ) -> None:
        if not rows:
            return
        connection.executemany(
            """
            INSERT INTO master_changes(
                revision, sequence, record_id, action, line_number,
                before_json, after_json, source_file, source_row, actor,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )

    @staticmethod
    def _prefix_in_sql(prefixes: list[str]) -> tuple[str, list[Any]]:
        if not prefixes:
            return "FALSE", []
        unique = list(dict.fromkeys(prefixes))
        # One array bind keeps the plan cheap vs thousands of scalar IN params.
        return "source_prefix = ANY(?::text[])", [unique]

    @staticmethod
    def _qualify_order_by(order_by: str, alias: str) -> str:
        parts: list[str] = []
        for piece in order_by.split(","):
            piece = piece.strip()
            if not piece:
                continue
            tokens = piece.split(None, 1)
            column = tokens[0]
            suffix = f" {tokens[1]}" if len(tokens) > 1 else ""
            parts.append(f"{alias}.{column}{suffix}")
        return ", ".join(parts)

    @staticmethod
    def _glob_match_or_sql(patterns: Iterable[str]) -> tuple[str, list[Any]]:
        values = list(patterns)
        if not values:
            return "FALSE", []
        clause = " OR ".join(
            "master_glob_match(source_prefix, ?)" for _ in values
        )
        return f"({clause})", values

    @staticmethod
    def _filtered_total_from_stats(
        stats: dict[str, Any],
        *,
        query: str,
        parameter_groups: Iterable[str] = (),
        regions: Iterable[int] = (),
        duplicates_only: bool = False,
        exact_duplicates_only: bool = False,
        exact_duplicate_extras_only: bool = False,
        short_aon_only: bool = False,
        invalid_only: bool = False,
        invalid_start_only: bool = False,
    ) -> int | None:
        """Return a cached total when COUNT(*) would only recompute known stats."""

        if query.strip():
            return None
        selected_parameter_groups = tuple(
            dict.fromkeys(value for value in parameter_groups if value)
        )
        selected_regions = tuple(dict.fromkeys(int(value) for value in regions))
        quality_flags = (
            duplicates_only,
            exact_duplicates_only,
            exact_duplicate_extras_only,
            short_aon_only,
            invalid_only,
            invalid_start_only,
        )
        quality_count = sum(1 for flag in quality_flags if flag)
        if quality_count > 1:
            return None
        if quality_count == 1 and (
            selected_parameter_groups or selected_regions
        ):
            return None
        if selected_parameter_groups and selected_regions:
            return None
        if duplicates_only:
            return int(stats["duplicateCount"])
        if exact_duplicates_only:
            return int(stats["exactDuplicateCount"])
        if exact_duplicate_extras_only:
            return int(stats["exactDuplicateExtraCount"])
        if short_aon_only:
            return int(stats["shortAonRecordCount"])
        if invalid_only:
            return int(stats["invalidRecordCount"])
        if invalid_start_only:
            return int(stats["invalidStartRecordCount"])
        if selected_parameter_groups:
            counts = {
                str(option["id"]): int(option["count"])
                for option in stats["parameterOptions"]
            }
            return sum(
                counts.get(group, 0) for group in selected_parameter_groups
            )
        if selected_regions:
            counts = {
                int(option["value"]): int(option["count"])
                for option in stats["regionOptions"]
            }
            return sum(counts.get(number, 0) for number in selected_regions)
        return None

    @staticmethod
    def _record_filter_sql(
        *,
        query: str,
        parameter_groups: Iterable[str] = (),
        regions: Iterable[int] = (),
        duplicates_only: bool = False,
        exact_duplicates_only: bool = False,
        exact_duplicate_extras_only: bool = False,
        short_aon_only: bool = False,
        invalid_only: bool = False,
        invalid_start_only: bool = False,
        group_prefixes: dict[str, list[str] | None] | None = None,
        region_prefixes_by_number: dict[int, list[str]] | None = None,
    ) -> tuple[str, list[Any]]:
        full_row_query = _full_row_search_query(query)
        try:
            normalized_tokens = _query_tokens(query)
        except AppError:
            if "=" not in full_row_query:
                raise
            normalized_tokens = []
        selected_parameter_groups = tuple(
            dict.fromkeys(value for value in parameter_groups if value)
        )
        selected_regions = tuple(dict.fromkeys(int(value) for value in regions))
        if any(value < 1 or value > 84 for value in selected_regions):
            raise AppError(
                "INVALID_REGION",
                "Номер региона должен быть от 1 до 84",
            )

        clauses = ["deleted_at IS NULL"]
        values: list[Any] = []
        if full_row_query or normalized_tokens:
            query_clauses: list[str] = []
            if full_row_query:
                query_clauses.append(
                    "master_logical_row(a_number, b_numbers_json, source_prefix) "
                    "LIKE ? ESCAPE '\\'"
                )
                values.append(_like_contains(full_row_query))
            for token in normalized_tokens:
                like = _like_contains(token)
                query_clauses.append(
                    """
                    (
                        a_number LIKE ? ESCAPE '\\'
                        OR EXISTS (
                            SELECT 1
                            FROM json_each(b_numbers_json) AS searched_aon
                            WHERE CAST(searched_aon.value AS TEXT) LIKE ? ESCAPE '\\'
                        )
                        OR CAST(id AS TEXT) LIKE ? ESCAPE '\\'
                    )
                    """
                )
                values.extend([like, like, like])
            clauses.append(f"({' OR '.join(query_clauses)})")
        if selected_parameter_groups or selected_regions:
            parameter_clauses: list[str] = []
            parameter_values: list[Any] = []
            pani_globs = _pani_glob_patterns()
            pani_region_globs = _pani_region_glob_patterns()
            standalone_region_prefixes = [
                prefix
                for number in range(1, 85)
                for prefix in (
                    f"null/$ & null&D{number}$&",
                    f"null/$ & null&{number}$&",
                )
            ]

            def append_group_clause(group: str) -> None:
                cached = (
                    None
                    if group_prefixes is None
                    else group_prefixes.get(group)
                )
                if cached is not None:
                    clause, clause_values = MasterService._prefix_in_sql(
                        cached
                    )
                    parameter_clauses.append(clause)
                    parameter_values.extend(clause_values)
                    return
                if group == "default":
                    parameter_clauses.append("source_prefix = ?")
                    parameter_values.append(NO_REGION_PREFIX)
                elif group == "pani":
                    clause, clause_values = MasterService._glob_match_or_sql(
                        pani_globs
                    )
                    parameter_clauses.append(clause)
                    parameter_values.extend(clause_values)
                elif group == "pani_region":
                    clause, clause_values = MasterService._glob_match_or_sql(
                        pani_region_globs
                    )
                    parameter_clauses.append(clause)
                    parameter_values.extend(clause_values)
                elif group == "region":
                    clause, clause_values = MasterService._prefix_in_sql(
                        standalone_region_prefixes
                    )
                    parameter_clauses.append(clause)
                    parameter_values.extend(clause_values)
                elif group == "custom":
                    region_clause, region_values = MasterService._prefix_in_sql(
                        standalone_region_prefixes
                    )
                    pani_clause, pani_values = MasterService._glob_match_or_sql(
                        pani_globs
                    )
                    pani_region_clause, pani_region_values = (
                        MasterService._glob_match_or_sql(pani_region_globs)
                    )
                    parameter_clauses.append(
                        f"""
                        (
                            source_prefix <> ?
                            AND NOT {pani_clause}
                            AND NOT {pani_region_clause}
                            AND NOT ({region_clause})
                        )
                        """
                    )
                    parameter_values.extend(
                        [
                            NO_REGION_PREFIX,
                            *pani_values,
                            *pani_region_values,
                            *region_values,
                        ]
                    )
                else:
                    raise AppError(
                        "INVALID_PARAMETER_GROUP",
                        "Неизвестная группа параметров",
                    )

            for group in selected_parameter_groups:
                append_group_clause(group)
            if selected_regions:
                if region_prefixes_by_number is not None:
                    selected_prefixes = [
                        prefix
                        for number in selected_regions
                        for prefix in region_prefixes_by_number.get(number, [])
                    ]
                    clause, clause_values = MasterService._prefix_in_sql(
                        selected_prefixes
                    )
                    parameter_clauses.append(clause)
                    parameter_values.extend(clause_values)
                else:
                    selected_region_prefixes = [
                        prefix
                        for number in selected_regions
                        for prefix in (
                            f"null/$ & null&D{number}$&",
                            f"null/$ & null&{number}$&",
                        )
                    ]
                    pani_region_patterns = [
                        pattern
                        for number in selected_regions
                        for sign in ("", "+")
                        for pattern in (
                            f"{sign}{_ELEVEN_DIGIT_GLOB}& D{number}$&null&",
                            f"{sign}{_ELEVEN_DIGIT_GLOB}& {number}$&null&",
                            f"{sign}{_ELEVEN_DIGIT_GLOB}& null&D{number}$&",
                            f"{sign}{_ELEVEN_DIGIT_GLOB}& null&{number}$&",
                        )
                    ]
                    in_clause, in_values = MasterService._prefix_in_sql(
                        selected_region_prefixes
                    )
                    glob_clause, glob_values = MasterService._glob_match_or_sql(
                        pani_region_patterns
                    )
                    parameter_clauses.append(
                        f"({in_clause} OR {glob_clause})"
                    )
                    parameter_values.extend([*in_values, *glob_values])
            clauses.append(f"({' OR '.join(parameter_clauses)})")
            values.extend(parameter_values)
        if duplicates_only:
            clauses.append(
                """
                EXISTS (
                    SELECT 1
                    FROM master_a_counts AS duplicate_count
                    WHERE duplicate_count.a_number = master_records.a_number
                      AND duplicate_count.active_count > 1
                )
                """
            )
        if exact_duplicates_only:
            clauses.append(
                """
                EXISTS (
                    SELECT 1
                    FROM master_exact_counts AS exact_duplicate_count
                    WHERE exact_duplicate_count.signature_hash = master_exact_signature(
                            master_records.a_number,
                            master_records.b_numbers_json,
                            master_records.source_prefix
                          )
                      AND exact_duplicate_count.active_count > 1
                )
                """
            )
        if exact_duplicate_extras_only:
            clauses.append(MASTER_EXACT_DUPLICATE_EXTRA_SQL)
        if short_aon_only:
            clauses.append(MASTER_SHORT_AON_SQL)
        if invalid_only:
            clauses.append(
                """
                (
                    length(a_number) <> 11
                    OR (
                        NOT {MASTER_SHORT_AON_SQL}
                        AND EXISTS (
                            SELECT 1
                            FROM json_each(b_numbers_json) AS invalid_aon
                            WHERE length(CAST(invalid_aon.value AS TEXT)) <> 11
                        )
                    )
                )
                """.format(MASTER_SHORT_AON_SQL=MASTER_SHORT_AON_SQL)
            )
        if invalid_start_only:
            clauses.append(
                """
                (
                    substr(a_number, 1, 1) <> '7'
                    OR (
                        NOT {MASTER_SHORT_AON_SQL}
                        AND EXISTS (
                            SELECT 1
                            FROM json_each(b_numbers_json) AS invalid_start_aon
                            WHERE substr(CAST(invalid_start_aon.value AS TEXT), 1, 1) <> '7'
                        )
                    )
                )
                """.format(MASTER_SHORT_AON_SQL=MASTER_SHORT_AON_SQL)
            )
        return " AND ".join(clauses), values

    def list_records(
        self,
        *,
        query: str,
        offset: int,
        limit: int,
        parameter_groups: Iterable[str] = (),
        regions: Iterable[int] = (),
        sort: str = "base",
        duplicates_only: bool = False,
        exact_duplicates_only: bool = False,
        exact_duplicate_extras_only: bool = False,
        short_aon_only: bool = False,
        invalid_only: bool = False,
        invalid_start_only: bool = False,
    ) -> dict[str, Any]:
        order_by = {
            "base": "sort_order",
            "parameter_asc": "source_prefix COLLATE NOCASE ASC, sort_order",
            "parameter_desc": "source_prefix COLLATE NOCASE DESC, sort_order",
        }.get(sort)
        if order_by is None:
            raise AppError("INVALID_SORT", "Неизвестный порядок сортировки")
        with self._connect() as connection:
            stats = self._list_global_stats(connection)
            where, values = self._record_filter_sql(
                query=query,
                parameter_groups=parameter_groups,
                regions=regions,
                duplicates_only=duplicates_only,
                exact_duplicates_only=exact_duplicates_only,
                exact_duplicate_extras_only=exact_duplicate_extras_only,
                short_aon_only=short_aon_only,
                invalid_only=invalid_only,
                invalid_start_only=invalid_start_only,
                group_prefixes=stats.get("prefixesByGroup"),
                region_prefixes_by_number=stats.get("prefixesByRegion"),
            )

            unfiltered_active = where == "deleted_at IS NULL" and not values
            if unfiltered_active:
                total = int(stats["activeCount"])
            else:
                cached_total = self._filtered_total_from_stats(
                    stats,
                    query=query,
                    parameter_groups=parameter_groups,
                    regions=regions,
                    duplicates_only=duplicates_only,
                    exact_duplicates_only=exact_duplicates_only,
                    exact_duplicate_extras_only=exact_duplicate_extras_only,
                    short_aon_only=short_aon_only,
                    invalid_only=invalid_only,
                    invalid_start_only=invalid_start_only,
                )
                if cached_total is not None:
                    total = cached_total
                else:
                    total = int(
                        connection.execute(
                            f"SELECT COUNT(*) AS count FROM master_records WHERE {where}",
                            values,
                        ).fetchone()["count"]
                    )

            matching_exact_duplicate_extra_count = int(
                stats["exactDuplicateExtraCount"]
            )
            if exact_duplicates_only or exact_duplicate_extras_only:
                matching_exact_duplicate_extra_count = int(
                    connection.execute(
                        f"""
                        SELECT COUNT(*) AS count
                        FROM master_records
                        WHERE ({where})
                          AND {MASTER_EXACT_DUPLICATE_EXTRA_SQL}
                        """,
                        values,
                    ).fetchone()["count"]
                )

            rows = connection.execute(
                f"""
                SELECT page.*,
                       COALESCE(a_counts.active_count, 0) AS duplicate_group_size,
                       COALESCE(exact_counts.active_count, 0)
                           AS exact_duplicate_group_size
                FROM (
                    SELECT master_records.*
                    FROM master_records
                    WHERE {where}
                    ORDER BY {order_by}
                    LIMIT ? OFFSET ?
                ) AS page
                LEFT JOIN master_a_counts AS a_counts
                  ON a_counts.a_number = page.a_number
                LEFT JOIN master_exact_counts AS exact_counts
                  ON exact_counts.signature_hash = master_exact_signature(
                         page.a_number,
                         page.b_numbers_json,
                         page.source_prefix
                     )
                ORDER BY {self._qualify_order_by(order_by, "page")}
                """,
                [*values, limit, offset],
            ).fetchall()

            exact_original_ids: dict[str, str] = {}
            exact_duplicate_rows = [
                row
                for row in rows
                if int(row["exact_duplicate_group_size"]) > 1
            ]
            for row in exact_duplicate_rows:
                original = connection.execute(
                    """
                    SELECT id
                    FROM master_records AS original_exact_duplicate
                    WHERE original_exact_duplicate.deleted_at IS NULL
                      AND original_exact_duplicate.a_number = ?
                      AND original_exact_duplicate.source_prefix = ?
                      AND master_b_signature(
                            original_exact_duplicate.b_numbers_json,
                            original_exact_duplicate.source_prefix
                          ) = master_b_signature(?, ?)
                    ORDER BY original_exact_duplicate.sort_order,
                             original_exact_duplicate.id
                    LIMIT 1
                    """,
                    (
                        row["a_number"],
                        row["source_prefix"],
                        row["b_numbers_json"],
                        row["source_prefix"],
                    ),
                ).fetchone()
                if original is not None:
                    exact_original_ids[str(row["id"])] = str(original["id"])

            duplicate_a_numbers = [
                str(row["a_number"])
                for row in rows
                if int(row["duplicate_group_size"]) > 1
            ]
            duplicate_findings: dict[str, Any] = {}
            if duplicate_a_numbers:
                latest_duplicate_import = connection.execute(
                    """
                    SELECT id
                    FROM master_imports
                    WHERE status = 'merged'
                    ORDER BY merged_at DESC, created_at DESC
                    LIMIT 1
                    """
                ).fetchone()
                if latest_duplicate_import is not None:
                    placeholders = ",".join("?" for _ in duplicate_a_numbers)
                    duplicate_findings = {
                        str(row["a_number"]): row
                        for row in connection.execute(
                            f"""
                            SELECT a_number, source_rows_json, source_file
                            FROM master_duplicate_findings
                            WHERE import_id = ?
                              AND a_number IN ({placeholders})
                            """,
                            [
                                str(latest_duplicate_import["id"]),
                                *duplicate_a_numbers,
                            ],
                        )
                    }

            use_offset_lines = unfiltered_active and sort == "base"
            line_numbers = (
                {}
                if use_offset_lines
                else self._active_lines(
                    connection,
                    (int(row["sort_order"]) for row in rows),
                )
            )
            items: list[dict[str, Any]] = []
            for index, row in enumerate(rows):
                if use_offset_lines:
                    line_number = offset + index + 1
                else:
                    line_number = line_numbers[int(row["sort_order"])]
                item = self._record_payload(row, line_number)
                duplicate = duplicate_findings.get(item["aNumber"])
                if int(row["duplicate_group_size"]) > 1:
                    item["isDuplicate"] = True
                    if duplicate is not None:
                        item.update(
                            {
                                "duplicateSourceRows": json.loads(
                                    str(duplicate["source_rows_json"])
                                ),
                                "duplicateSourceFile": str(
                                    duplicate["source_file"]
                                ),
                            }
                        )
                else:
                    item["isDuplicate"] = False
                item["isExactDuplicate"] = (
                    int(row["exact_duplicate_group_size"]) > 1
                )
                original_id = exact_original_ids.get(item["id"], item["id"])
                item["isExactDuplicateExtra"] = (
                    item["isExactDuplicate"] and original_id != item["id"]
                )
                items.append(item)
            return {
                "revision": int(stats["revision"]),
                "total": total,
                "activeCount": int(stats["activeCount"]),
                "totalB": int(stats["totalB"]),
                "historyCount": int(stats["historyCount"]),
                "invalidANumberCount": int(stats["invalidANumberCount"]),
                "invalidBNumberCount": int(stats["invalidBNumberCount"]),
                "invalidRecordCount": int(stats["invalidRecordCount"]),
                "invalidStartANumberCount": int(
                    stats["invalidStartANumberCount"]
                ),
                "invalidStartBNumberCount": int(
                    stats["invalidStartBNumberCount"]
                ),
                "invalidStartRecordCount": int(
                    stats["invalidStartRecordCount"]
                ),
                "shortAonRecordCount": int(stats["shortAonRecordCount"]),
                "parameterOptions": stats["parameterOptions"],
                "regionOptions": stats["regionOptions"],
                "duplicateCount": int(stats["duplicateCount"]),
                "exactDuplicateCount": int(stats["exactDuplicateCount"]),
                "exactDuplicateExtraCount": int(
                    stats["exactDuplicateExtraCount"]
                ),
                "matchingExactDuplicateExtraCount": (
                    matching_exact_duplicate_extra_count
                ),
                "offset": offset,
                "limit": limit,
                "items": items,
            }

    def history(
        self,
        *,
        query: str,
        action: str | None,
        offset: int,
        limit: int,
        date_from: float | None = None,
        date_to: float | None = None,
    ) -> dict[str, Any]:
        normalized = query.strip()
        clauses = ["1 = 1"]
        values: list[Any] = []
        if action:
            clauses.append("action = ?")
            values.append(action)
        if date_from is not None:
            clauses.append("created_at >= ?")
            values.append(date_from)
        if date_to is not None:
            clauses.append("created_at < ?")
            values.append(date_to)
        if normalized:
            clauses.append(
                """
                (
                    CAST(record_id AS TEXT) LIKE ?
                    OR source_file LIKE ?
                    OR json_extract(before_json, '$.aNumber') LIKE ?
                    OR json_extract(after_json, '$.aNumber') LIKE ?
                    OR EXISTS (
                        SELECT 1
                        FROM json_each(before_json, '$.bNumbers') AS before_aon
                        WHERE before_aon.value LIKE ?
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM json_each(after_json, '$.bNumbers') AS after_aon
                        WHERE after_aon.value LIKE ?
                    )
                )
                """
            )
            like = f"%{normalized}%"
            values.extend([like, like, like, like, like, like])
        where = " AND ".join(clauses)
        with self._connect() as connection:
            total = int(
                connection.execute(
                    f"SELECT COUNT(*) AS count FROM master_changes WHERE {where}",
                    values,
                ).fetchone()["count"]
            )
            rows = connection.execute(
                f"""
                SELECT * FROM master_changes
                WHERE {where}
                ORDER BY revision DESC, sequence DESC
                LIMIT ? OFFSET ?
                """,
                [*values, limit, offset],
            ).fetchall()
        items: list[dict[str, Any]] = []
        for row in rows:
            before = (
                json.loads(str(row["before_json"]))
                if row["before_json"]
                else None
            )
            after = (
                json.loads(str(row["after_json"]))
                if row["after_json"]
                else None
            )
            before_b = before.get("bNumbers", []) if before else []
            after_b = after.get("bNumbers", []) if after else []
            before_set = set(before_b)
            after_set = set(after_b)
            items.append(
                {
                    "id": str(row["id"]),
                    "revision": int(row["revision"]),
                    "sequence": int(row["sequence"]),
                    "recordId": str(row["record_id"]),
                    "action": str(row["action"]),
                    "lineNumber": (
                        int(row["line_number"])
                        if row["line_number"] is not None
                        else None
                    ),
                    "before": before,
                    "after": after,
                    "removedBNumbers": [
                        number for number in before_b if number not in after_set
                    ],
                    "addedBNumbers": [
                        number for number in after_b if number not in before_set
                    ],
                    "sourceFile": row["source_file"],
                    "sourceRow": row["source_row"],
                    "actor": str(row["actor"]),
                    "createdAt": float(row["created_at"]),
                }
            )
        return {
            "total": total,
            "offset": offset,
            "limit": limit,
            "items": items,
        }

    def _resume_interrupted_analyses(self) -> None:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, session_id, request_json
                FROM master_imports
                WHERE status IN ('queued', 'analyzing')
                  AND request_json != '{}'
                ORDER BY created_at
                """
            ).fetchall()
            connection.execute(
                """
                UPDATE master_imports
                SET status = 'queued', progress_phase = 'queued',
                    updated_at = ?
                WHERE status = 'analyzing'
                """,
                (time.time(),),
            )
        for row in rows:
            try:
                body = MasterImportAnalyzeRequest.model_validate_json(
                    str(row["request_json"])
                )
            except ValueError:
                continue
            self._analysis_executor.submit(
                self._run_import_analysis,
                str(row["id"]),
                body,
                str(row["session_id"]),
            )

    def _reset_interrupted_merges(self) -> None:
        """Return half-finished merges to analyzed so the user can retry."""
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE master_imports
                SET status = 'analyzed',
                    progress_phase = 'completed',
                    error_code = 'MASTER_MERGE_INTERRUPTED',
                    error_message = 'Слияние было прервано перезапуском сервера. Подтвердите снова.',
                    updated_at = ?
                WHERE status = 'merging'
                """,
                (time.time(),),
            )

    def _merge_cancel_event(self, import_id: str) -> threading.Event:
        event = self._merge_cancellations.get(import_id)
        if event is None:
            event = threading.Event()
            self._merge_cancellations[import_id] = event
        return event

    def _raise_if_merge_cancelled(self, import_id: str) -> None:
        event = self._merge_cancellations.get(import_id)
        if event is not None and event.is_set():
            raise CancelledError()

    def _mark_merge_cancelled(self, import_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE master_imports
                SET status = 'analyzed',
                    progress_phase = 'completed',
                    error_code = 'MASTER_MERGE_CANCELLED',
                    error_message = 'Слияние отменено',
                    updated_at = ?
                WHERE id = ? AND status = 'merging'
                """,
                (time.time(), import_id),
            )

    def _cancel_merge_backend(self, import_id: str) -> None:
        pid = self._merge_backends.get(import_id)
        if pid is None:
            return
        try:
            with self._connect() as connection:
                connection.execute(
                    "SELECT pg_cancel_backend(?)",
                    (pid,),
                )
                connection.commit()
        except Exception:  # noqa: BLE001 — best-effort interrupt
            logging.getLogger(__name__).exception(
                "Failed to cancel merge backend pid=%s import_id=%s",
                pid,
                import_id,
            )

    def cancel_merge_import(
        self, import_id: str, session_id: str
    ) -> dict[str, Any]:
        """Stop an in-flight merge and roll back its DB transaction."""
        with self._connect() as connection:
            import_row = connection.execute(
                """
                SELECT * FROM master_imports
                WHERE id = ? AND session_id = ?
                """,
                (import_id, session_id),
            ).fetchone()
            if import_row is None:
                raise AppError(
                    "MASTER_IMPORT_NOT_FOUND",
                    "Анализ импорта не найден",
                    status_code=404,
                )
            status = str(import_row["status"])
            if status != "merging":
                return self._analysis_payload(connection, import_row)

        event = self._merge_cancel_event(import_id)
        event.set()
        self._pending_merges.pop(import_id, None)
        self._cancel_merge_backend(import_id)
        self._mark_merge_cancelled(import_id)
        return self.get_import(import_id, session_id)

    def shutdown(self) -> None:
        for event in list(self._merge_cancellations.values()):
            event.set()
        for import_id in list(self._merge_backends):
            self._cancel_merge_backend(import_id)
        self._analysis_executor.shutdown(wait=False, cancel_futures=False)

    def _create_import(
        self,
        body: MasterImportAnalyzeRequest,
        session_id: str,
        *,
        reuse_existing: bool,
    ) -> str:
        upload = self.registry.get_upload(body.uploadId, session_id)
        now = time.time()
        with self._lock, self._connect() as connection:
            if reuse_existing:
                existing = connection.execute(
                    """
                    SELECT id FROM master_imports
                    WHERE session_id = ? AND upload_id = ?
                      AND status IN ('queued', 'analyzing', 'analyzed')
                    ORDER BY created_at DESC LIMIT 1
                    """,
                    (session_id, body.uploadId),
                ).fetchone()
                if existing is not None:
                    return str(existing["id"])
            import_row = connection.execute(
                """
                INSERT INTO master_imports(
                    session_id, upload_id, source_name, detected_mode,
                    base_revision, status, stats_json, request_json,
                    warnings_json, progress_rows, progress_phase, updated_at,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, 'queued', '{}', ?, '{}', 0,
                          'queued', ?, ?)
                RETURNING id
                """,
                (
                    session_id,
                    body.uploadId,
                    upload.name,
                    body.mode,
                    self._current_revision(connection),
                    body.model_dump_json(),
                    now,
                    now,
                ),
            ).fetchone()
        return str(import_row["id"])

    def queue_import_analysis(
        self,
        body: MasterImportAnalyzeRequest,
        session_id: str,
    ) -> dict[str, Any]:
        import_id = self._create_import(
            body,
            session_id,
            reuse_existing=True,
        )
        payload = self.get_import(import_id, session_id)
        if payload["status"] == "queued":
            self._analysis_executor.submit(
                self._run_import_analysis,
                import_id,
                body,
                session_id,
            )
        return payload

    def analyze_import(
        self,
        body: MasterImportAnalyzeRequest,
        session_id: str,
    ) -> dict[str, Any]:
        """Synchronous service API retained for tests and internal callers."""

        import_id = self._create_import(
            body,
            session_id,
            reuse_existing=False,
        )
        self._run_import_analysis(import_id, body, session_id)
        payload = self.get_import(import_id, session_id)
        if payload["status"] == "failed":
            raise AppError(
                str(payload.get("errorCode") or "MASTER_IMPORT_FAILED"),
                str(payload.get("errorMessage") or "Не удалось проверить файл"),
                status_code=(
                    413
                    if payload.get("errorCode") == "MASTER_ROW_LIMIT"
                    else 400
                ),
            )
        return payload

    def get_active_import(self, session_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT id FROM master_imports
                WHERE session_id = ?
                  AND status IN ('queued', 'analyzing', 'merging')
                ORDER BY created_at DESC LIMIT 1
                """,
                (session_id,),
            ).fetchone()
        return {
            "active": (
                self.get_import(str(row["id"]), session_id)
                if row is not None
                else None
            )
        }

    def get_import(self, import_id: str, session_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM master_imports
                WHERE id = ? AND session_id = ?
                """,
                (import_id, session_id),
            ).fetchone()
            if row is None:
                raise AppError(
                    "MASTER_IMPORT_NOT_FOUND",
                    "Анализ импорта не найден",
                    status_code=404,
                )
            return self._analysis_payload(connection, row)

    def _analysis_payload(
        self,
        connection: sqlite3.Connection,
        row: sqlite3.Row,
    ) -> dict[str, Any]:
        status = str(row["status"])
        payload: dict[str, Any] = {
            "importId": str(row["id"]),
            "status": status,
            "sourceName": str(row["source_name"]),
            "mode": str(row["detected_mode"]),
            "baseRevision": int(row["base_revision"]),
            "progressRows": int(row["progress_rows"] or 0),
            "progressPhase": str(row["progress_phase"] or status),
            "maxRows": self.config.max_master_rows,
        }
        if status == "failed":
            payload.update(
                {
                    "errorCode": str(row["error_code"] or "MASTER_IMPORT_FAILED"),
                    "errorMessage": str(
                        row["error_message"] or "Не удалось проверить файл"
                    ),
                }
            )
            return payload
        if status == "merging":
            if row["error_code"] or row["error_message"]:
                payload.update(
                    {
                        "errorCode": str(row["error_code"] or ""),
                        "errorMessage": str(row["error_message"] or ""),
                    }
                )
            return payload
        if status == "analyzed" and (
            row["error_code"] or row["error_message"]
        ):
            # Merge failed and rolled back to analyzed — surface the error.
            payload["errorCode"] = str(row["error_code"] or "")
            payload["errorMessage"] = str(row["error_message"] or "")
        if status not in {"analyzed", "merged"}:
            return payload
        stats = json.loads(str(row["stats_json"] or "{}"))
        items: list[dict[str, Any]] = []
        for item_status in ("new", "conflict"):
            items.extend(
                self._import_item_payload(item)
                for item in connection.execute(
                    """
                    SELECT * FROM master_import_items
                    WHERE import_id = ? AND status = ?
                    ORDER BY source_row, id LIMIT 200
                    """,
                    (str(row["id"]), item_status),
                )
            )
        duplicates = [
            {
                "aNumber": str(duplicate["a_number"]),
                "sourceRows": json.loads(str(duplicate["source_rows_json"])),
                "entries": self._duplicate_entry_payloads(
                    connection,
                    str(row["id"]),
                    str(duplicate["a_number"]),
                ),
            }
            for duplicate in connection.execute(
                """
                SELECT a_number, source_rows_json
                FROM master_duplicate_findings
                WHERE import_id = ?
                ORDER BY a_number LIMIT 200
                """,
                (str(row["id"]),),
            )
        ]
        payload.update(
            {
                "stats": stats,
                "items": items,
                "duplicates": duplicates,
                "numberStartErrors": self._import_number_start_errors(
                    connection,
                    str(row["id"]),
                ),
            }
        )
        if status == "merged":
            merge_result = stats.get("mergeResult")
            if isinstance(merge_result, dict):
                payload["mergeResult"] = merge_result
        return payload

    def _update_analysis_progress(
        self,
        import_id: str,
        *,
        phase: str,
        rows: int,
        connection: sqlite3.Connection | None = None,
    ) -> None:
        params = (phase, rows, time.time(), import_id)
        sql = """
            UPDATE master_imports
            SET progress_phase = ?, progress_rows = ?, updated_at = ?
            WHERE id = ? AND status IN ('queued', 'analyzing', 'merging')
            """
        if connection is not None:
            connection.execute(sql, params)
            return
        with self._connect() as owned:
            owned.execute(sql, params)

    def _run_import_analysis(
        self,
        import_id: str,
        body: MasterImportAnalyzeRequest,
        session_id: str,
    ) -> None:
        with self._connect() as connection:
            claimed = connection.execute(
                """
                UPDATE master_imports
                SET status = 'analyzing', progress_phase = 'reading',
                    error_code = NULL, error_message = NULL, updated_at = ?
                WHERE id = ? AND status = 'queued'
                """,
                (time.time(), import_id),
            ).rowcount
        if claimed != 1:
            return
        # A process restart can leave a durable import in the middle of a
        # committed batch. Rebuild that import from its still-retained upload
        # instead of duplicating the already persisted prefix of the file.
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "DELETE FROM master_import_items WHERE import_id = ?",
                (import_id,),
            )
            connection.execute(
                "DELETE FROM master_duplicate_findings WHERE import_id = ?",
                (import_id,),
            )
            connection.execute(
                "DELETE FROM master_import_number_warnings WHERE import_id = ?",
                (import_id,),
            )
            connection.execute(
                """
                UPDATE master_imports
                SET base_revision = (
                        SELECT current_revision FROM master_state WHERE id = 1
                    ),
                    stats_json = '{}', warnings_json = '{}',
                    progress_rows = 0, progress_phase = 'reading',
                    updated_at = ?
                WHERE id = ?
                """,
                (time.time(), import_id),
            )
        try:
            self._process_import(import_id, body, session_id)
        except AppError as error:
            self._fail_import(import_id, error.code, error.message)
        except Exception as error:
            logger.exception("Master import analysis %s failed", import_id)
            self._fail_import(
                import_id,
                "MASTER_IMPORT_FAILED",
                _import_failure_message(error),
            )

    def _fail_import(self, import_id: str, code: str, message: str) -> None:
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "DELETE FROM master_import_items WHERE import_id = ?",
                (import_id,),
            )
            connection.execute(
                "DELETE FROM master_duplicate_findings WHERE import_id = ?",
                (import_id,),
            )
            connection.execute(
                "DELETE FROM master_import_number_warnings WHERE import_id = ?",
                (import_id,),
            )
            connection.execute(
                """
                UPDATE master_imports
                SET status = 'failed', progress_phase = 'failed',
                    error_code = ?, error_message = ?, updated_at = ?
                WHERE id = ?
                """,
                (code, message, time.time(), import_id),
            )

    def _process_import(
        self,
        import_id: str,
        body: MasterImportAnalyzeRequest,
        session_id: str,
    ) -> None:
        upload = self.registry.get_upload(body.uploadId, session_id)
        importer = importer_for(upload.path, upload.format)
        selected, mode = self.validation.choose(
            importer,
            requested_sheet=body.sheet,
            requested_mode=body.mode,
        )
        temporary_dir = Path(
            tempfile.mkdtemp(prefix="master-import-", dir=self.config.data_dir)
        )
        report_path = temporary_dir / "report.csv"
        last_progress = 0

        def report_progress(processed_rows: int) -> None:
            nonlocal last_progress
            if processed_rows > self.config.max_master_rows:
                raise AppError(
                    "MASTER_ROW_LIMIT",
                    (
                        "Мастер-файл содержит больше "
                        f"{self.config.max_master_rows:,} строк"
                    ).replace(",", " "),
                    status_code=413,
                )
            if processed_rows - last_progress >= 10_000:
                last_progress = processed_rows
                self._update_analysis_progress(
                    import_id,
                    phase="reading",
                    rows=processed_rows,
                )

        try:
            with ReportWriter(report_path) as report, MasterImportSpool() as spool:
                builder = MappingBuilder(spool, report)
                if mode == "formatted":
                    parser_stats = builder.build_formatted(
                        FormattedMappingImporter(importer).iterateRows(selected.name),
                        parser=MappingParser(
                            auto_detect=True,
                            allow_mixed_templates=True,
                            allow_number_whitespace=True,
                        ),
                        duplicate_a_callback=spool.remember_duplicate,
                        progress=report_progress,
                    )
                else:
                    a_column = (
                        selected.a_column
                        if body.mode == "auto" and selected.a_column is not None
                        else body.aColumn
                    )
                    b_column = (
                        selected.b_column
                        if body.mode == "auto" and selected.b_column is not None
                        else body.bColumn
                    )
                    parser_stats = builder.build_raw(
                        importer.iterateRows(selected.name),
                        a_column=a_column,
                        b_column=b_column,
                        replace_empty_b_with_a=True,
                        allow_number_whitespace=True,
                        duplicate_a_callback=spool.remember_duplicate,
                        progress=report_progress,
                    )
                parser_stats["preservedRows"] = spool.mapping_count()
                parser_stats["resultRows"] = spool.mapping_count()
                report_progress(int(parser_stats["inputRows"]))
                if parser_stats["uniqueA"] == 0:
                    raise AppError(
                        "NO_VALID_MAPPINGS",
                        "Файл не содержит корректных связок",
                    )
                self._persist_spooled_import(
                    import_id,
                    upload.name,
                    mode,
                    parser_stats,
                    spool,
                )
        finally:
            shutil.rmtree(temporary_dir, ignore_errors=True)

    def _persist_spooled_import(
        self,
        import_id: str,
        source_name: str,
        mode: str,
        parser_stats: dict[str, int],
        spool: MasterImportSpool,
    ) -> None:
        counts = {"new": 0, "unchanged": 0, "conflict": 0}
        persisted = 0
        now = time.time()
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TEMP TABLE IF NOT EXISTS matched_master_records (
                    record_id BIGINT PRIMARY KEY
                ) WITHOUT ROWID
                """
            )
            connection.execute(
                """
                UPDATE master_imports
                SET detected_mode = ?, progress_phase = 'comparing',
                    updated_at = ?
                WHERE id = ?
                """,
                (mode, now, import_id),
            )
            entries = spool.iter_mapping_entries()
            while True:
                batch: list[tuple[Any, int]] = []
                try:
                    for _ in range(MASTER_IMPORT_BATCH_SIZE):
                        batch.append(next(entries))
                except StopIteration:
                    pass
                if not batch:
                    break
                a_numbers = [mapping.aNumber for mapping, _ in batch]
                current_rows: dict[str, list[Any]] = {}
                if a_numbers:
                    unique_a = list(dict.fromkeys(a_numbers))
                    for row in connection.execute(
                        """
                        SELECT
                            record.id,
                            record.a_number,
                            record.b_numbers_json,
                            record.source_prefix,
                            record.comment,
                            record.version,
                            record.deleted_at,
                            record.sort_order
                        FROM master_records AS record
                        LEFT JOIN matched_master_records AS matched
                          ON matched.record_id = record.id
                        WHERE record.a_number = ANY(?)
                          AND matched.record_id IS NULL
                        ORDER BY
                            CASE WHEN record.deleted_at IS NULL THEN 0 ELSE 1 END,
                            record.sort_order,
                            record.id
                        """,
                        (unique_a,),
                    ):
                        current_rows.setdefault(str(row["a_number"]), []).append(row)
                item_rows: list[tuple[Any, ...]] = []
                warning_rows: list[tuple[Any, ...]] = []
                matched_record_ids: list[tuple[int]] = []
                for mapping, source_row in batch:
                    prefix = canonicalize_pani_region_prefix(
                        mapping.sourcePrefix or NO_REGION_PREFIX
                    )
                    incoming = {
                        "aNumber": mapping.aNumber,
                        "bNumbers": list(mapping.bNumbers),
                        "sourcePrefix": prefix,
                    }
                    b_json = _json(incoming["bNumbers"])
                    candidates = current_rows.get(mapping.aNumber, [])
                    current_row = _pick_compare_master_row(
                        candidates, b_json=b_json, prefix=prefix
                    )
                    if current_row is not None:
                        matched_record_ids.append((int(current_row["id"]),))
                    current = (
                        _snapshot(current_row)
                        if current_row is not None
                        and current_row["deleted_at"] is None
                        else None
                    )
                    if current is None:
                        status = "new"
                    elif (
                        current["aNumber"] == incoming["aNumber"]
                        and current["bNumbers"] == incoming["bNumbers"]
                        and current["sourcePrefix"] == incoming["sourcePrefix"]
                    ):
                        status = "unchanged"
                    else:
                        status = "conflict"
                    counts[status] += 1
                    item_rows.append(
                        (
                            int(import_id),
                            source_row,
                            mapping.aNumber,
                            _json(incoming),
                            b_json,
                            prefix,
                            (
                                int(current_row["id"])
                                if current_row is not None
                                else None
                            ),
                            _json(current) if current is not None else None,
                            status,
                        )
                    )
                    pending_warnings = _number_start_errors(
                        incoming,
                        source_row=source_row,
                        item_id="",
                    )
                    if pending_warnings:
                        warning_rows.append(
                            (
                                len(item_rows) - 1,
                                source_row,
                                pending_warnings,
                                status,
                            )
                        )
                if matched_record_ids:
                    connection.executemany(
                        """
                        INSERT OR IGNORE INTO matched_master_records(record_id)
                        VALUES (?)
                        """,
                        matched_record_ids,
                    )
                allocated_item_ids = self._allocate_ids(
                    connection, "master_import_items", len(item_rows)
                )
                connection.executemany(
                    """
                    INSERT INTO master_import_items(
                        id, import_id, source_row, a_number, incoming_json,
                        incoming_b_json, incoming_prefix, existing_record_id,
                        current_json, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (item_id, *row)
                        for item_id, row in zip(allocated_item_ids, item_rows)
                    ],
                )
                if warning_rows:
                    flat_warnings: list[tuple[Any, ...]] = []
                    for item_index, source_row, warnings, status in warning_rows:
                        item_id = allocated_item_ids[item_index]
                        for warning in warnings:
                            flat_warnings.append(
                                (
                                    int(import_id),
                                    item_id,
                                    source_row,
                                    warning["kind"],
                                    warning["number"],
                                    warning["aNumber"],
                                    status,
                                )
                            )
                    connection.executemany(
                        """
                        INSERT INTO master_import_number_warnings(
                            import_id, item_id, source_row, kind, number,
                            a_number, status
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        flat_warnings,
                    )
                persisted += len(batch)
                self._update_analysis_progress(
                    import_id,
                    phase="comparing",
                    rows=persisted,
                    connection=connection,
                )
                connection.commit()
                if len(batch) < MASTER_IMPORT_BATCH_SIZE:
                    break

            # Rename-match: только new-строки с уникальной B+prefix связкой.
            # Подпись заранее — чтобы попасть в индекс master_records_signature.
            if counts["new"] > 0:
                connection.executescript(
                    """
                    DROP TABLE IF EXISTS temp.unique_incoming_signatures;
                    DROP TABLE IF EXISTS temp.rename_matches;
                    CREATE TEMP TABLE unique_incoming_signatures (
                        incoming_b_json TEXT NOT NULL,
                        incoming_prefix TEXT NOT NULL,
                        signature TEXT NOT NULL
                    );
                    CREATE TEMP TABLE rename_matches (
                        item_id BIGINT PRIMARY KEY,
                        record_id BIGINT NOT NULL
                    );
                    """
                )
                connection.execute(
                    """
                    INSERT INTO unique_incoming_signatures(
                        incoming_b_json, incoming_prefix, signature
                    )
                    SELECT
                        incoming_b_json,
                        incoming_prefix,
                        master_b_signature(incoming_b_json, incoming_prefix)
                    FROM master_import_items
                    WHERE import_id = ?
                      AND status = 'new'
                      AND existing_record_id IS NULL
                    GROUP BY incoming_b_json, incoming_prefix
                    HAVING COUNT(*) = 1
                    """,
                    (import_id,),
                )
                connection.execute(
                    """
                    CREATE INDEX IF NOT EXISTS unique_incoming_signatures_sig
                        ON unique_incoming_signatures (signature, incoming_prefix)
                    """
                )
                connection.execute(
                    """
                    INSERT INTO rename_matches(item_id, record_id)
                    SELECT item.id, MIN(record.id)
                    FROM master_import_items AS item
                    JOIN unique_incoming_signatures AS signature
                      ON signature.incoming_b_json = item.incoming_b_json
                     AND signature.incoming_prefix = item.incoming_prefix
                    JOIN master_records AS record
                      ON record.deleted_at IS NULL
                     AND master_b_signature(
                            record.b_numbers_json, record.source_prefix
                         ) = signature.signature
                     AND record.source_prefix = signature.incoming_prefix
                     AND record.b_numbers_json = signature.incoming_b_json
                    LEFT JOIN master_import_items AS blocker
                      ON blocker.import_id = item.import_id
                     AND blocker.a_number = record.a_number
                    WHERE item.import_id = ?
                      AND item.status = 'new'
                      AND item.existing_record_id IS NULL
                      AND blocker.id IS NULL
                    GROUP BY item.id
                    HAVING COUNT(*) = 1
                    """,
                    (import_id,),
                )
                renamed = 0
                rename_cursor = connection.execute(
                    """
                    SELECT
                        matches.item_id,
                        item.incoming_json,
                        record.id,
                        record.a_number,
                        record.b_numbers_json,
                        record.source_prefix,
                        record.comment,
                        record.version,
                        record.deleted_at
                    FROM rename_matches AS matches
                    JOIN master_import_items AS item ON item.id = matches.item_id
                    JOIN master_records AS record ON record.id = matches.record_id
                    """
                )
                while True:
                    rename_batch = rename_cursor.fetchmany(MASTER_IMPORT_BATCH_SIZE)
                    if not rename_batch:
                        break
                    connection.executemany(
                        """
                        UPDATE master_import_items
                        SET existing_record_id = ?, current_json = ?,
                            status = 'conflict'
                        WHERE id = ?
                        """,
                        (
                            (
                                int(row["id"]),
                                _json(_snapshot(row)),
                                int(row["item_id"]),
                            )
                            for row in rename_batch
                        ),
                    )
                    connection.executemany(
                        """
                        UPDATE master_import_number_warnings
                        SET status = 'conflict'
                        WHERE import_id = ? AND item_id = ?
                        """,
                        (
                            (int(import_id), int(row["item_id"]))
                            for row in rename_batch
                        ),
                    )
                    renamed += len(rename_batch)
                    connection.commit()
                connection.commit()
                counts["new"] -= renamed
                counts["conflict"] += renamed
            else:
                renamed = 0
                connection.commit()

            duplicate_groups = spool.duplicate_group_count()
            duplicate_batch: list[tuple[Any, ...]] = []
            for a_number, source_rows in spool.iter_duplicate_findings():
                duplicate_batch.append(
                    (import_id, a_number, _json(source_rows), source_name, now)
                )
                if len(duplicate_batch) >= 500:
                    connection.executemany(
                        """
                        INSERT INTO master_duplicate_findings(
                            import_id, a_number, source_rows_json, source_file,
                            created_at
                        ) VALUES (?, ?, ?, ?, ?)
                        """,
                        duplicate_batch,
                    )
                    connection.commit()
                    duplicate_batch = []
            if duplicate_batch:
                connection.executemany(
                    """
                    INSERT INTO master_duplicate_findings(
                        import_id, a_number, source_rows_json, source_file,
                        created_at
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    duplicate_batch,
                )
                connection.commit()

            master_only = int(
                connection.execute(
                    """
                    SELECT COUNT(*) AS count
                    FROM master_records AS record
                    WHERE record.deleted_at IS NULL
                      AND NOT EXISTS (
                          SELECT 1 FROM master_import_items AS item
                          WHERE item.import_id = ?
                            AND item.a_number = record.a_number
                      )
                    """,
                    (import_id,),
                ).fetchone()["count"]
            )
            invalid_start_rows, invalid_start_numbers = (
                self._import_number_start_counts(connection, import_id)
            )
            persisted_rows = int(
                connection.execute(
                    """
                    SELECT COUNT(*) AS count
                    FROM master_import_items
                    WHERE import_id = ?
                    """,
                    (import_id,),
                ).fetchone()["count"]
            )
            expected_rows = int(parser_stats["preservedRows"])
            if persisted_rows != expected_rows:
                raise AppError(
                    "MASTER_IMPORT_ROW_MISMATCH",
                    (
                        "Проверка целостности импорта не пройдена: "
                        f"ожидалось {expected_rows} отдельных строк, "
                        f"сохранено {persisted_rows}"
                    ),
                )
            stats = {
                **counts,
                "sourceRows": int(parser_stats["inputRows"]),
                "uniqueA": int(parser_stats["uniqueA"]),
                "preservedRows": int(parser_stats["preservedRows"]),
                "totalB": int(parser_stats["totalB"]),
                "invalidRows": int(parser_stats["invalidRows"]),
                "skippedRows": int(parser_stats["skippedRows"]),
                "duplicateA": int(parser_stats["duplicateA"]),
                "duplicateGroups": duplicate_groups,
                "masterOnly": master_only,
                "invalidStartRows": invalid_start_rows,
                "invalidStartNumbers": invalid_start_numbers,
                "previewTruncated": counts["new"] > 200 or counts["conflict"] > 200,
            }
            connection.execute(
                """
                UPDATE master_imports
                SET status = 'analyzed', stats_json = ?,
                    progress_rows = ?, progress_phase = 'completed',
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    _json(stats),
                    int(parser_stats["inputRows"]),
                    time.time(),
                    import_id,
                ),
            )
            # Явно закрываем транзакцию анализа (не полагаемся только на __exit__).
            connection.commit()

    def list_import_items(
        self,
        import_id: str,
        session_id: str,
        *,
        status: str,
        offset: int,
        limit: int,
    ) -> dict[str, Any]:
        if status not in {"new", "conflict", "unchanged"}:
            raise AppError(
                "INVALID_IMPORT_STATUS",
                "Неизвестный тип строк слияния",
            )
        with self._connect() as connection:
            import_row = connection.execute(
                """
                SELECT status FROM master_imports
                WHERE id = ? AND session_id = ?
                """,
                (import_id, session_id),
            ).fetchone()
            if import_row is None:
                raise AppError(
                    "MASTER_IMPORT_NOT_FOUND",
                    "Анализ импорта не найден",
                    status_code=404,
                )
            if str(import_row["status"]) != "analyzed":
                raise AppError(
                    "MASTER_IMPORT_ALREADY_MERGED",
                    "Этот импорт уже был применён",
                    status_code=409,
                )
            total = int(
                connection.execute(
                    """
                    SELECT COUNT(*) AS count
                    FROM master_import_items
                    WHERE import_id = ? AND status = ?
                    """,
                    (import_id, status),
                ).fetchone()["count"]
            )
            rows = connection.execute(
                """
                SELECT * FROM master_import_items
                WHERE import_id = ? AND status = ?
                ORDER BY source_row, id
                LIMIT ? OFFSET ?
                """,
                (import_id, status, limit, offset),
            ).fetchall()
        return {
            "total": total,
            "offset": offset,
            "limit": limit,
            "items": [self._import_item_payload(row) for row in rows],
        }

    def _duplicate_entry_payloads(
        self,
        connection: sqlite3.Connection,
        import_id: str,
        a_number: str,
    ) -> list[dict[str, Any]]:
        rows = connection.execute(
            """
            SELECT source_row, incoming_json
            FROM master_import_items
            WHERE import_id = ? AND a_number = ?
            ORDER BY source_row, id
            """,
            (import_id, a_number),
        ).fetchall()
        entries: list[dict[str, Any]] = []
        for row in rows:
            incoming = json.loads(str(row["incoming_json"]))
            entries.append(
                {
                    "sourceRow": int(row["source_row"]),
                    "bNumbers": list(incoming.get("bNumbers") or []),
                }
            )
        return entries

    def list_import_duplicates(
        self,
        import_id: str,
        session_id: str,
        *,
        offset: int,
        limit: int,
    ) -> dict[str, Any]:
        with self._connect() as connection:
            import_row = connection.execute(
                """
                SELECT status FROM master_imports
                WHERE id = ? AND session_id = ?
                """,
                (import_id, session_id),
            ).fetchone()
            if import_row is None:
                raise AppError(
                    "MASTER_IMPORT_NOT_FOUND",
                    "Анализ импорта не найден",
                    status_code=404,
                )
            if str(import_row["status"]) != "analyzed":
                raise AppError(
                    "MASTER_IMPORT_ALREADY_MERGED",
                    "Этот импорт уже был применён",
                    status_code=409,
                )
            total = int(
                connection.execute(
                    """
                    SELECT COUNT(*) AS count
                    FROM master_duplicate_findings
                    WHERE import_id = ?
                    """,
                    (import_id,),
                ).fetchone()["count"]
            )
            rows = connection.execute(
                """
                SELECT a_number, source_rows_json
                FROM master_duplicate_findings
                WHERE import_id = ?
                ORDER BY a_number
                LIMIT ? OFFSET ?
                """,
                (import_id, limit, offset),
            ).fetchall()
        return {
            "total": total,
            "offset": offset,
            "limit": limit,
            "items": [
                {
                    "aNumber": str(row["a_number"]),
                    "sourceRows": json.loads(str(row["source_rows_json"])),
                    "entries": self._duplicate_entry_payloads(
                        connection,
                        import_id,
                        str(row["a_number"]),
                    ),
                }
                for row in rows
            ],
        }

    def update_import_item(
        self,
        import_id: str,
        item_id: str,
        body: MasterRecordRequest,
        session_id: str,
    ) -> dict[str, Any]:
        payload = self._normalize_record(body)
        # Comments are internal master metadata and are never imported from CSV.
        payload.pop("comment", None)
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            import_row = connection.execute(
                """
                SELECT * FROM master_imports
                WHERE id = ? AND session_id = ?
                """,
                (import_id, session_id),
            ).fetchone()
            if import_row is None:
                raise AppError(
                    "MASTER_IMPORT_NOT_FOUND",
                    "Анализ импорта не найден",
                    status_code=404,
                )
            if str(import_row["status"]) != "analyzed":
                raise AppError(
                    "MASTER_IMPORT_ALREADY_MERGED",
                    "Этот импорт уже был применён",
                    status_code=409,
                )
            item = connection.execute(
                """
                SELECT * FROM master_import_items
                WHERE id = ? AND import_id = ?
                """,
                (item_id, import_id),
            ).fetchone()
            if item is None:
                raise AppError(
                    "MASTER_IMPORT_ITEM_NOT_FOUND",
                    "Строка анализа не найдена",
                    status_code=404,
                )
            current_row = connection.execute(
                """
                SELECT record.*
                FROM master_records AS record
                WHERE record.a_number = ?
                  AND (
                      record.id = ?
                      OR NOT EXISTS (
                          SELECT 1
                          FROM master_import_items AS sibling
                          WHERE sibling.import_id = ?
                            AND sibling.id != ?
                            AND sibling.existing_record_id = record.id
                      )
                  )
                ORDER BY
                    CASE
                        WHEN record.deleted_at IS NULL
                         AND record.b_numbers_json = ?
                         AND record.source_prefix = ? THEN 0
                        WHEN record.deleted_at IS NULL THEN 1
                        ELSE 2
                    END,
                    record.sort_order,
                    record.id
                LIMIT 1
                """,
                (
                    payload["aNumber"],
                    item["existing_record_id"],
                    import_id,
                    item_id,
                    _json(payload["bNumbers"]),
                    payload["sourcePrefix"],
                ),
            ).fetchone()
            current = (
                _snapshot(current_row)
                if current_row is not None
                and current_row["deleted_at"] is None
                else None
            )
            if current is None:
                next_status = "new"
            elif (
                current["aNumber"] == payload["aNumber"]
                and current["bNumbers"] == payload["bNumbers"]
                and current["sourcePrefix"] == payload["sourcePrefix"]
            ):
                next_status = "unchanged"
            else:
                next_status = "conflict"

            old_status = str(item["status"])
            stats = json.loads(str(import_row["stats_json"]))
            if old_status != next_status:
                stats[old_status] = max(0, int(stats.get(old_status, 0)) - 1)
                stats[next_status] = int(stats.get(next_status, 0)) + 1
            connection.execute(
                """
                UPDATE master_import_items
                SET a_number = ?, incoming_json = ?, incoming_b_json = ?,
                    incoming_prefix = ?, existing_record_id = ?,
                    current_json = ?, status = ?
                WHERE id = ?
                """,
                    (
                        payload["aNumber"],
                        _json(payload),
                        _json(payload["bNumbers"]),
                        payload["sourcePrefix"],
                        (
                            int(current_row["id"])
                            if current_row is not None
                            else None
                        ),
                        _json(current) if current is not None else None,
                        next_status,
                        int(item_id),
                    ),
                )
            connection.execute(
                """
                DELETE FROM master_import_number_warnings
                WHERE import_id = ? AND item_id = ?
                """,
                (int(import_id), int(item_id)),
            )
            item_warnings = _number_start_errors(
                payload,
                source_row=int(item["source_row"]),
                item_id=str(item_id),
            )
            if item_warnings:
                connection.executemany(
                    """
                    INSERT INTO master_import_number_warnings(
                        import_id, item_id, source_row, kind, number,
                        a_number, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        (
                            int(import_id),
                            int(item_id),
                            int(item["source_row"]),
                            warning["kind"],
                            warning["number"],
                            warning["aNumber"],
                            next_status,
                        )
                        for warning in item_warnings
                    ),
                )
            number_start_errors = self._import_number_start_errors(
                connection,
                import_id,
            )
            invalid_start_rows, invalid_start_numbers = (
                self._import_number_start_counts(connection, import_id)
            )
            stats["invalidStartRows"] = invalid_start_rows
            stats["invalidStartNumbers"] = invalid_start_numbers
            connection.execute(
                "UPDATE master_imports SET stats_json = ? WHERE id = ?",
                (_json(stats), import_id),
            )
            updated = connection.execute(
                "SELECT * FROM master_import_items WHERE id = ?",
                (item_id,),
            ).fetchone()
        return {
            "item": self._import_item_payload(updated),
            "stats": stats,
            "numberStartErrors": number_start_errors[:500],
        }

    def queue_merge_import(
        self,
        import_id: str,
        body: MasterMergeRequest,
        session_id: str,
        *,
        actor: str,
    ) -> dict[str, Any]:
        """Start merge in background; client polls GET /imports/{id} until merged."""
        now = time.time()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            import_row = connection.execute(
                """
                SELECT * FROM master_imports
                WHERE id = ? AND session_id = ?
                """,
                (import_id, session_id),
            ).fetchone()
            if import_row is None:
                raise AppError(
                    "MASTER_IMPORT_NOT_FOUND",
                    "Анализ импорта не найден",
                    status_code=404,
                )
            status = str(import_row["status"])
            if status == "merging":
                return self._analysis_payload(connection, import_row)
            if status == "merged":
                return self._analysis_payload(connection, import_row)
            if status != "analyzed":
                raise AppError(
                    "MASTER_IMPORT_NOT_READY",
                    "Импорт ещё не готов к слиянию",
                    status_code=409,
                )
            current_revision = self._current_revision(connection)
            if current_revision != int(import_row["base_revision"]):
                raise AppError(
                    "MASTER_CHANGED",
                    "Мастер файл изменился после проверки. Запустите анализ заново.",
                    status_code=409,
                )
            claimed = connection.execute(
                """
                UPDATE master_imports
                SET status = 'merging',
                    progress_phase = 'merging',
                    error_code = NULL,
                    error_message = NULL,
                    updated_at = ?
                WHERE id = ? AND status = 'analyzed'
                """,
                (now, import_id),
            ).rowcount
            if claimed != 1:
                raise AppError(
                    "MASTER_IMPORT_ALREADY_MERGED",
                    "Этот импорт уже обрабатывается или применён",
                    status_code=409,
                )
            updated = connection.execute(
                "SELECT * FROM master_imports WHERE id = ?",
                (import_id,),
            ).fetchone()
            self._merge_cancel_event(import_id).clear()
            self._pending_merges[import_id] = (body, actor)
            payload = self._analysis_payload(connection, updated)
            connection.commit()
        self._analysis_executor.submit(
            self._run_merge_import,
            import_id,
            session_id,
        )
        return payload

    def _run_merge_import(self, import_id: str, session_id: str) -> None:
        pending = self._pending_merges.pop(import_id, None)
        if pending is None:
            # Cancelled before the worker started.
            self._mark_merge_cancelled(import_id)
            self._merge_cancellations.pop(import_id, None)
            return
        body, actor = pending
        try:
            self._raise_if_merge_cancelled(import_id)
            self.merge_import(import_id, body, session_id, actor=actor)
        except CancelledError:
            self._mark_merge_cancelled(import_id)
        except AppError as exc:
            with self._connect() as connection:
                connection.execute(
                    """
                    UPDATE master_imports
                    SET status = 'analyzed',
                        progress_phase = 'completed',
                        error_code = ?,
                        error_message = ?,
                        updated_at = ?
                    WHERE id = ? AND status = 'merging'
                    """,
                    (exc.code, exc.message, time.time(), import_id),
                )
        except Exception as exc:  # noqa: BLE001 — surface to UI, keep import retryable
            event = self._merge_cancellations.get(import_id)
            if event is not None and event.is_set():
                self._mark_merge_cancelled(import_id)
            else:
                with self._connect() as connection:
                    connection.execute(
                        """
                        UPDATE master_imports
                        SET status = 'analyzed',
                            progress_phase = 'completed',
                            error_code = 'MASTER_MERGE_FAILED',
                            error_message = ?,
                            updated_at = ?
                        WHERE id = ? AND status = 'merging'
                        """,
                        (str(exc)[:2000], time.time(), import_id),
                    )
        finally:
            self._merge_backends.pop(import_id, None)
            self._merge_cancellations.pop(import_id, None)

    @staticmethod
    def _rebuild_duplicate_counts(connection: sqlite3.Connection) -> None:
        """Пересчёт master_a_counts / master_exact_counts после bulk-записи без триггеров."""
        connection.execute("TRUNCATE master_a_counts")
        connection.execute(
            """
            INSERT INTO master_a_counts(a_number, active_count)
            SELECT a_number, COUNT(*)::INTEGER
            FROM master_records
            WHERE deleted_at IS NULL
            GROUP BY a_number
            """
        )
        connection.execute("TRUNCATE master_exact_counts")
        connection.execute(
            """
            INSERT INTO master_exact_counts(
                signature_hash, a_number, b_numbers_json, source_prefix,
                active_count
            )
            SELECT
                master_exact_signature(
                    a_number, b_numbers_json, source_prefix
                ),
                a_number,
                b_numbers_json,
                source_prefix,
                COUNT(*)::INTEGER
            FROM master_records
            WHERE deleted_at IS NULL
            GROUP BY a_number, b_numbers_json, source_prefix
            HAVING COUNT(*) > 1
            """
        )

    def merge_import(
        self,
        import_id: str,
        body: MasterMergeRequest,
        session_id: str,
        *,
        actor: str,
    ) -> dict[str, Any]:
        selected = set(body.replaceConflictItemIds)
        now = time.time()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._merge_backends[import_id] = connection.backend_pid
            self._raise_if_merge_cancelled(import_id)
            import_row = connection.execute(
                """
                SELECT * FROM master_imports
                WHERE id = ? AND session_id = ?
                """,
                (import_id, session_id),
            ).fetchone()
            if import_row is None:
                raise AppError(
                    "MASTER_IMPORT_NOT_FOUND",
                    "Анализ импорта не найден",
                    status_code=404,
                )
            if import_row["status"] not in {"analyzed", "merging"}:
                raise AppError(
                    "MASTER_IMPORT_ALREADY_MERGED",
                    "Этот импорт уже был применён",
                    status_code=409,
                )
            current_revision = self._current_revision(connection)
            if current_revision != int(import_row["base_revision"]):
                raise AppError(
                    "MASTER_CHANGED",
                    "Мастер файл изменился после проверки. Запустите анализ заново.",
                    status_code=409,
                )
            merge_table = "master_import_items"
            merged_duplicates = 0
            if body.mergeDuplicateANumbers:
                merge_table = "temp.master_merge_items"
                connection.executescript(
                    """
                    DROP TABLE IF EXISTS temp.master_merge_items;
                    CREATE TEMP TABLE master_merge_items (
                        id BIGINT PRIMARY KEY,
                        import_id BIGINT NOT NULL,
                        source_row INTEGER NOT NULL,
                        a_number TEXT NOT NULL,
                        incoming_json TEXT NOT NULL,
                        existing_record_id BIGINT,
                        current_json TEXT,
                        status TEXT NOT NULL,
                        member_ids_json TEXT NOT NULL
                    );
                    """
                )
                source_items = connection.execute(
                    """
                    SELECT * FROM master_import_items
                    WHERE import_id = ?
                    ORDER BY a_number, source_row, id
                    """,
                    (import_id,),
                )
                current_a: str | None = None
                grouped_rows: list[sqlite3.Row] = []

                def persist_group(rows: list[sqlite3.Row]) -> None:
                    nonlocal merged_duplicates
                    if not rows:
                        return
                    first = rows[0]
                    combined_b: list[str] = []
                    seen_b: set[str] = set()
                    for grouped_row in rows:
                        incoming_row = json.loads(
                            str(grouped_row["incoming_json"])
                        )
                        for b_number in incoming_row["bNumbers"]:
                            if b_number in seen_b:
                                continue
                            seen_b.add(b_number)
                            combined_b.append(b_number)
                    first_incoming = json.loads(str(first["incoming_json"]))
                    incoming = {
                        "aNumber": str(first["a_number"]),
                        "bNumbers": combined_b,
                        "sourcePrefix": first_incoming["sourcePrefix"],
                    }
                    existing = next(
                        (
                            row
                            for row in rows
                            if row["existing_record_id"] is not None
                        ),
                        None,
                    )
                    current = (
                        json.loads(str(existing["current_json"]))
                        if existing is not None
                        and existing["current_json"] is not None
                        else None
                    )
                    if existing is None or current is None:
                        status = "new"
                    elif (
                        current["aNumber"] == incoming["aNumber"]
                        and current["bNumbers"] == incoming["bNumbers"]
                        and current["sourcePrefix"]
                        == incoming["sourcePrefix"]
                    ):
                        status = "unchanged"
                    else:
                        status = "conflict"
                    connection.execute(
                        """
                        INSERT INTO master_merge_items(
                            id, import_id, source_row, a_number,
                            incoming_json, existing_record_id, current_json,
                            status, member_ids_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            str(first["id"]),
                            import_id,
                            min(int(row["source_row"]) for row in rows),
                            str(first["a_number"]),
                            _json(incoming),
                            (
                                str(existing["existing_record_id"])
                                if existing is not None
                                else None
                            ),
                            _json(current) if current is not None else None,
                            status,
                            _json([str(row["id"]) for row in rows]),
                        ),
                    )
                    merged_duplicates += len(rows) - 1

                for source_item in source_items:
                    a_number = str(source_item["a_number"])
                    if current_a is not None and a_number != current_a:
                        persist_group(grouped_rows)
                        grouped_rows = []
                    current_a = a_number
                    grouped_rows.append(source_item)
                persist_group(grouped_rows)
            conflict_total = int(
                connection.execute(
                    f"""
                    SELECT COUNT(*) AS count FROM {merge_table}
                    WHERE import_id = ? AND status = 'conflict'
                    """,
                    (import_id,),
                ).fetchone()["count"]
            )
            revision = current_revision + 1
            next_sort = int(
                connection.execute(
                    "SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM master_records"
                ).fetchone()["value"]
            )
            active_count = int(
                connection.execute(
                    """
                    SELECT COUNT(*) AS count FROM master_records
                    WHERE deleted_at IS NULL
                    """
                ).fetchone()["count"]
            )
            added = 0
            updated = 0
            applied_conflicts = 0
            sequence = 0
            merge_progress = 0
            member_json_sql = (
                ", member_ids_json" if body.mergeDuplicateANumbers else ""
            )
            items = connection.execute(
                f"""
                SELECT
                    id,
                    source_row,
                    status,
                    incoming_json,
                    existing_record_id
                    {member_json_sql}
                FROM {merge_table}
                WHERE import_id = ? AND status IN ('new', 'conflict')
                ORDER BY source_row, id
                """,
                (import_id,),
            )
            triggers_disabled = False
            try:
                connection.execute(
                    "ALTER TABLE master_records DISABLE TRIGGER USER"
                )
                triggers_disabled = True
            except Exception:  # noqa: BLE001
                triggers_disabled = False
            try:
                while True:
                    self._raise_if_merge_cancelled(import_id)
                    batch = items.fetchmany(MASTER_IMPORT_BATCH_SIZE)
                    if not batch:
                        break
                    existing_ids = [
                        int(item["existing_record_id"])
                        for item in batch
                        if item["existing_record_id"] is not None
                    ]
                    records_by_id: dict[str, Any] = {}
                    if existing_ids:
                        for row in connection.execute(
                            """
                            SELECT
                                id, a_number, b_numbers_json, source_prefix,
                                comment, version, deleted_at, sort_order
                            FROM master_records
                            WHERE id = ANY(?)
                            """,
                            (existing_ids,),
                        ):
                            records_by_id[str(row["id"])] = row

                    planned: list[dict[str, Any]] = []
                    insert_count = 0
                    for item in batch:
                        status = str(item["status"])
                        if status == "conflict":
                            if body.mergeDuplicateANumbers:
                                member_ids = json.loads(
                                    str(item["member_ids_json"])
                                )
                            else:
                                member_ids = [str(item["id"])]
                            replace = (
                                body.conflictStrategy == "replace_all"
                                or (
                                    body.conflictStrategy == "selected"
                                    and any(
                                        member_id in selected
                                        for member_id in member_ids
                                    )
                                )
                            )
                            if not replace:
                                continue
                            applied_conflicts += 1
                        incoming = json.loads(str(item["incoming_json"]))
                        record = (
                            records_by_id.get(str(item["existing_record_id"]))
                            if item["existing_record_id"] is not None
                            else None
                        )
                        if record is None:
                            insert_count += 1
                            planned.append(
                                {
                                    "kind": "insert",
                                    "item": item,
                                    "incoming": incoming,
                                }
                            )
                            continue
                        before = (
                            _snapshot(record)
                            if record["deleted_at"] is None
                            else None
                        )
                        merged_incoming = incoming
                        if (
                            before is not None
                            and before["aNumber"] == incoming["aNumber"]
                            and before["sourcePrefix"]
                            == incoming["sourcePrefix"]
                        ):
                            combined_b_numbers = list(before["bNumbers"])
                            seen_b_numbers = set(combined_b_numbers)
                            for b_number in incoming["bNumbers"]:
                                if b_number in seen_b_numbers:
                                    continue
                                seen_b_numbers.add(b_number)
                                combined_b_numbers.append(b_number)
                            merged_incoming = {
                                **incoming,
                                "bNumbers": combined_b_numbers,
                            }
                        if (
                            before is not None
                            and before["aNumber"] == merged_incoming["aNumber"]
                            and before["bNumbers"]
                            == merged_incoming["bNumbers"]
                            and before["sourcePrefix"]
                            == merged_incoming["sourcePrefix"]
                        ):
                            continue
                        planned.append(
                            {
                                "kind": "update",
                                "item": item,
                                "incoming": merged_incoming,
                                "record": record,
                                "before": before,
                            }
                        )

                    allocated_ids = self._allocate_ids(
                        connection, "master_records", insert_count
                    )
                    insert_id_iter = iter(allocated_ids)
                    insert_rows: list[tuple[Any, ...]] = []
                    update_rows: list[tuple[Any, ...]] = []
                    change_rows: list[tuple[Any, ...]] = []
                    item_record_links: list[tuple[int, int, int]] = []
                    line_by_sort = self._active_lines(
                        connection,
                        (
                            int(plan["record"]["sort_order"])
                            for plan in planned
                            if plan["kind"] == "update"
                            and plan.get("before") is not None
                        ),
                    )

                    for plan in planned:
                        item = plan["item"]
                        incoming = plan["incoming"]
                        if plan["kind"] == "insert":
                            sequence += 1
                            record_id = str(next(insert_id_iter))
                            insert_rows.append(
                                (
                                    int(record_id),
                                    incoming["aNumber"],
                                    _json(incoming["bNumbers"]),
                                    incoming["sourcePrefix"],
                                    next_sort,
                                    now,
                                    now,
                                    revision,
                                    revision,
                                )
                            )
                            active_count += 1
                            line_number = active_count
                            next_sort += 1
                            after = {
                                "id": record_id,
                                **incoming,
                                "comment": "",
                                "version": 1,
                            }
                            before = None
                            action = "added"
                            added += 1
                        else:
                            record = plan["record"]
                            before = plan["before"]
                            record_id = str(record["id"])
                            sequence += 1
                            version = int(record["version"]) + 1
                            update_rows.append(
                                (
                                    incoming["aNumber"],
                                    _json(incoming["bNumbers"]),
                                    incoming["sourcePrefix"],
                                    version,
                                    now,
                                    revision,
                                    int(record_id),
                                )
                            )
                            if before is None:
                                active_count += 1
                                line_number = active_count
                            else:
                                line_number = line_by_sort.get(
                                    int(record["sort_order"]),
                                    active_count,
                                )
                            after = {
                                "id": record_id,
                                **incoming,
                                "comment": str(record["comment"] or ""),
                                "version": version,
                            }
                            action = (
                                "restored" if before is None else "updated"
                            )
                            if before is None:
                                added += 1
                            else:
                                updated += 1
                        change_rows.append(
                            (
                                revision,
                                sequence,
                                int(record_id),
                                action,
                                line_number,
                                _json(before) if before is not None else None,
                                _json(after) if after is not None else None,
                                str(import_row["source_name"]),
                                int(item["source_row"]),
                                actor,
                                now,
                            )
                        )
                        if not body.mergeDuplicateANumbers:
                            item_record_links.append(
                                (
                                    int(record_id),
                                    int(import_id),
                                    int(item["id"]),
                                )
                            )

                    if insert_rows:
                        connection.executemany(
                            """
                            INSERT INTO master_records(
                                id, a_number, b_numbers_json, source_prefix,
                                sort_order, version, created_at, updated_at,
                                created_revision, updated_revision, deleted_at,
                                deleted_revision
                            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL)
                            """,
                            insert_rows,
                        )
                    if update_rows:
                        connection.executemany(
                            """
                            UPDATE master_records
                            SET a_number = ?, b_numbers_json = ?,
                                source_prefix = ?, version = ?, updated_at = ?,
                                updated_revision = ?, deleted_at = NULL,
                                deleted_revision = NULL
                            WHERE id = ?
                            """,
                            update_rows,
                        )
                    self._append_changes_many(connection, change_rows)
                    if item_record_links:
                        connection.executemany(
                            """
                            UPDATE master_import_items
                            SET existing_record_id = ?
                            WHERE import_id = ? AND id = ?
                            """,
                            item_record_links,
                        )
                    merge_progress += len(batch)
                    self._update_analysis_progress(
                        import_id,
                        phase="merging",
                        rows=merge_progress,
                        connection=connection,
                    )
                    self._raise_if_merge_cancelled(import_id)
            finally:
                try:
                    items.close()
                except Exception:  # noqa: BLE001
                    pass
                if triggers_disabled:
                    try:
                        # After pg_cancel the txn is aborted; rollback restores
                        # trigger state. Only re-enable while still in-trans.
                        if (
                            connection.transaction_status
                            == TransactionStatus.INTRANS
                        ):
                            connection.execute(
                                "ALTER TABLE master_records ENABLE TRIGGER USER"
                            )
                            if sequence > 0:
                                self._rebuild_duplicate_counts(connection)
                    except Exception:  # noqa: BLE001
                        pass

            self._raise_if_merge_cancelled(import_id)
            kept_conflicts = conflict_total - applied_conflicts
            import_stats = json.loads(str(import_row["stats_json"] or "{}"))
            separate_duplicate_rows = (
                0
                if body.mergeDuplicateANumbers
                else int(import_stats.get("duplicateA", 0))
            )
            if not body.mergeDuplicateANumbers:
                representation = connection.execute(
                    """
                    SELECT
                        COUNT(*) AS expected,
                        COUNT(DISTINCT item.existing_record_id) AS represented,
                        SUM(
                            CASE
                                WHEN item.existing_record_id IS NULL
                                  OR record.id IS NULL
                                  OR record.deleted_at IS NOT NULL
                                THEN 1 ELSE 0
                            END
                        ) AS missing
                    FROM master_import_items AS item
                    LEFT JOIN master_records AS record
                      ON record.id = item.existing_record_id
                    WHERE item.import_id = ?
                    """,
                    (import_id,),
                ).fetchone()
                expected = int(representation["expected"])
                represented = int(representation["represented"])
                missing = int(representation["missing"] or 0)
                if represented != expected or missing:
                    raise AppError(
                        "MASTER_MERGE_ROW_MISMATCH",
                        (
                            "Слияние отменено проверкой целостности: "
                            f"для {expected} входящих строк подтверждено "
                            f"только {represented} отдельных строк master"
                        ),
                    )
            if sequence == 0:
                result = {
                    "revision": current_revision,
                    "added": 0,
                    "updated": 0,
                    "keptConflicts": kept_conflicts,
                    "mergedDuplicates": merged_duplicates,
                    "separateDuplicateRows": separate_duplicate_rows,
                }
                import_stats["mergeResult"] = result
                connection.execute(
                    """
                    UPDATE master_imports
                    SET status = 'merged',
                        merged_at = ?,
                        merged_revision = ?,
                        stats_json = ?,
                        error_code = NULL,
                        error_message = NULL,
                        progress_phase = 'merged'
                    WHERE id = ?
                    """,
                    (now, current_revision, _json(import_stats), import_id),
                )
                self._raise_if_merge_cancelled(import_id)
                connection.commit()
                return result
            connection.execute(
                "UPDATE master_state SET current_revision = ? WHERE id = 1",
                (revision,),
            )
            result = {
                "revision": revision,
                "added": added,
                "updated": updated,
                "keptConflicts": kept_conflicts,
                "mergedDuplicates": merged_duplicates,
                "separateDuplicateRows": separate_duplicate_rows,
            }
            import_stats["mergeResult"] = result
            connection.execute(
                """
                UPDATE master_imports
                SET status = 'merged',
                    merged_at = ?,
                    merged_revision = ?,
                    stats_json = ?,
                    error_code = NULL,
                    error_message = NULL,
                    progress_phase = 'merged'
                WHERE id = ?
                """,
                (now, revision, _json(import_stats), import_id),
            )
            self._invalidate_list_stats_cache()
            self._raise_if_merge_cancelled(import_id)
            connection.commit()
            return result

    def create_record(
        self, body: MasterRecordRequest, session_id: str, *, actor: str
    ) -> dict[str, Any]:
        payload = self._normalize_record(body)
        now = time.time()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                """
                SELECT * FROM master_records
                WHERE a_number = ? AND deleted_at IS NOT NULL
                ORDER BY deleted_at DESC, sort_order, id
                LIMIT 1
                """,
                (payload["aNumber"],),
            ).fetchone()
            revision = self._current_revision(connection) + 1
            if existing is None:
                sort_order = int(
                    connection.execute(
                        "SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM master_records"
                    ).fetchone()["value"]
                )
                version = 1
                inserted = connection.execute(
                    """
                    INSERT INTO master_records(
                        a_number, b_numbers_json, source_prefix, comment,
                        sort_order, version, created_at, updated_at,
                        created_revision, updated_revision
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    RETURNING id
                    """,
                    (
                        payload["aNumber"],
                        _json(payload["bNumbers"]),
                        payload["sourcePrefix"],
                        payload["comment"],
                        sort_order,
                        version,
                        now,
                        now,
                        revision,
                        revision,
                    ),
                ).fetchone()
                record_id = str(inserted["id"])
                action = "added"
            else:
                record_id = str(existing["id"])
                sort_order = int(existing["sort_order"])
                version = int(existing["version"]) + 1
                connection.execute(
                    """
                    UPDATE master_records
                    SET b_numbers_json = ?, source_prefix = ?, comment = ?,
                        version = ?, updated_at = ?, updated_revision = ?,
                        deleted_at = NULL, deleted_revision = NULL
                    WHERE id = ?
                    """,
                    (
                        _json(payload["bNumbers"]),
                        payload["sourcePrefix"],
                        payload["comment"],
                        version,
                        now,
                        revision,
                        int(record_id),
                    ),
                )
                action = "restored"
            after = {"id": record_id, **payload, "version": version}
            self._append_change(
                connection,
                revision=revision,
                sequence=1,
                record_id=record_id,
                action=action,
                line_number=self._active_line(connection, sort_order),
                before=None,
                after=after,
                source_file=None,
                source_row=None,
                actor=actor,
                created_at=now,
            )
            connection.execute(
                "UPDATE master_state SET current_revision = ? WHERE id = 1",
                (revision,),
            )
            row = connection.execute(
                "SELECT * FROM master_records WHERE id = ?", (record_id,)
            ).fetchone()
            return {
                "revision": revision,
                "record": self._record_payload(
                    row, self._active_line(connection, sort_order)
                ),
            }

    def update_record(
        self,
        record_id: str,
        body: MasterRecordRequest,
        session_id: str,
        *,
        actor: str,
    ) -> dict[str, Any]:
        payload = self._normalize_record(body)
        now = time.time()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            record = connection.execute(
                """
                SELECT * FROM master_records
                WHERE id = ? AND deleted_at IS NULL
                """,
                (record_id,),
            ).fetchone()
            if record is None:
                raise AppError(
                    "MASTER_RECORD_NOT_FOUND",
                    "Строка исходной базы не найдена",
                    status_code=404,
                )
            if (
                body.expectedVersion is not None
                and int(record["version"]) != body.expectedVersion
            ):
                raise AppError(
                    "MASTER_RECORD_CHANGED",
                    "Строка уже была изменена. Обновите список и повторите.",
                    status_code=409,
                )
            before = _snapshot(record)
            if (
                before is not None
                and before["aNumber"] == payload["aNumber"]
                and before["bNumbers"] == payload["bNumbers"]
                and before["sourcePrefix"] == payload["sourcePrefix"]
                and before["comment"] == payload["comment"]
            ):
                return {
                    "revision": self._current_revision(connection),
                    "record": self._record_payload(
                        record,
                        self._active_line(connection, int(record["sort_order"])),
                    ),
                }
            revision = self._current_revision(connection) + 1
            version = int(record["version"]) + 1
            connection.execute(
                """
                UPDATE master_records
                SET a_number = ?, b_numbers_json = ?, source_prefix = ?,
                    comment = ?, version = ?, updated_at = ?,
                    updated_revision = ?
                WHERE id = ?
                """,
                (
                    payload["aNumber"],
                    _json(payload["bNumbers"]),
                    payload["sourcePrefix"],
                    payload["comment"],
                    version,
                    now,
                    revision,
                    record_id,
                ),
            )
            after = {"id": record_id, **payload, "version": version}
            line_number = self._active_line(
                connection, int(record["sort_order"])
            )
            self._append_change(
                connection,
                revision=revision,
                sequence=1,
                record_id=record_id,
                action="updated",
                line_number=line_number,
                before=before,
                after=after,
                source_file=None,
                source_row=None,
                actor=actor,
                created_at=now,
            )
            connection.execute(
                "UPDATE master_state SET current_revision = ? WHERE id = 1",
                (revision,),
            )
            updated = connection.execute(
                "SELECT * FROM master_records WHERE id = ?", (record_id,)
            ).fetchone()
            return {
                "revision": revision,
                "record": self._record_payload(updated, line_number),
            }

    def delete_record(
        self,
        record_id: str,
        expected_version: int | None,
        session_id: str,
        *,
        actor: str,
    ) -> dict[str, Any]:
        now = time.time()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            record = connection.execute(
                """
                SELECT * FROM master_records
                WHERE id = ? AND deleted_at IS NULL
                """,
                (record_id,),
            ).fetchone()
            if record is None:
                raise AppError(
                    "MASTER_RECORD_NOT_FOUND",
                    "Строка исходной базы не найдена",
                    status_code=404,
                )
            if (
                expected_version is not None
                and int(record["version"]) != expected_version
            ):
                raise AppError(
                    "MASTER_RECORD_CHANGED",
                    "Строка уже была изменена. Обновите список и повторите.",
                    status_code=409,
                )
            revision = self._current_revision(connection) + 1
            before = _snapshot(record)
            line_number = self._active_line(
                connection, int(record["sort_order"])
            )
            version = int(record["version"]) + 1
            connection.execute(
                """
                UPDATE master_records
                SET version = ?, updated_at = ?, updated_revision = ?,
                    deleted_at = ?, deleted_revision = ?
                WHERE id = ?
                """,
                (version, now, revision, now, revision, record_id),
            )
            self._append_change(
                connection,
                revision=revision,
                sequence=1,
                record_id=record_id,
                action="deleted",
                line_number=line_number,
                before=before,
                after=None,
                source_file=None,
                source_row=None,
                actor=actor,
                created_at=now,
            )
            connection.execute(
                "UPDATE master_state SET current_revision = ? WHERE id = 1",
                (revision,),
            )
            return {"revision": revision, "deletedId": record_id}

    @staticmethod
    def _normalize_batch_numbers(
        values: Iterable[str], *, field: str
    ) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for index, raw in enumerate(values, start=1):
            number = normalize_number(raw, source_row=index, field=field)
            if number and number not in seen:
                seen.add(number)
                normalized.append(number)
        if not normalized:
            raise AppError(
                f"INVALID_{field}_NUMBER",
                "Укажите хотя бы один номер",
            )
        return normalized

    def delete_records_by_a(
        self, a_numbers: Iterable[str], session_id: str, *, actor: str
    ) -> dict[str, Any]:
        targets = set(self._normalize_batch_numbers(a_numbers, field="A"))
        now = time.time()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            active_records = connection.execute(
                """
                SELECT * FROM master_records
                WHERE deleted_at IS NULL
                ORDER BY sort_order
                """
            ).fetchall()
            line_numbers = {
                str(record["id"]): index
                for index, record in enumerate(active_records, start=1)
            }
            records = [
                record
                for record in active_records
                if str(record["a_number"]) in targets
            ]
            current_revision = self._current_revision(connection)
            if not records:
                return {
                    "revision": current_revision,
                    "requested": len(targets),
                    "deleted": 0,
                    "notFound": len(targets),
                }
            revision = current_revision + 1
            for sequence, record in enumerate(records, start=1):
                record_id = str(record["id"])
                version = int(record["version"]) + 1
                connection.execute(
                    """
                    UPDATE master_records
                    SET version = ?, updated_at = ?, updated_revision = ?,
                        deleted_at = ?, deleted_revision = ?
                    WHERE id = ? AND deleted_at IS NULL
                    """,
                    (version, now, revision, now, revision, record_id),
                )
                self._append_change(
                    connection,
                    revision=revision,
                    sequence=sequence,
                    record_id=record_id,
                    action="deleted",
                    line_number=line_numbers[record_id],
                    before=_snapshot(record),
                    after=None,
                    source_file=None,
                    source_row=None,
                    actor=actor,
                    created_at=now,
                )
            connection.execute(
                "UPDATE master_state SET current_revision = ? WHERE id = 1",
                (revision,),
            )
            return {
                "revision": revision,
                "requested": len(targets),
                "deleted": len(records),
                "notFound": len(targets) - len(records),
            }

    def delete_exact_duplicate_extras(
        self,
        *,
        record_filter: MasterRecordFilterRequest,
        excluded_record_ids: Iterable[str],
        session_id: str,
        actor: str,
    ) -> dict[str, Any]:
        excluded_ids = {
            str(value).strip()
            for value in excluded_record_ids
            if str(value).strip()
        }
        now = time.time()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            stats = self._list_global_stats(connection)
            where, values = self._record_filter_sql(
                query=record_filter.query,
                parameter_groups=record_filter.parameterGroups,
                regions=record_filter.regions,
                duplicates_only=record_filter.duplicatesOnly,
                exact_duplicates_only=record_filter.exactDuplicatesOnly,
                exact_duplicate_extras_only=True,
                short_aon_only=record_filter.shortAonOnly,
                invalid_only=record_filter.invalidOnly,
                invalid_start_only=record_filter.invalidStartOnly,
                group_prefixes=stats.get("prefixesByGroup"),
                region_prefixes_by_number=stats.get("prefixesByRegion"),
            )
            if excluded_ids:
                placeholders = ",".join("?" for _ in excluded_ids)
                where += f" AND id NOT IN ({placeholders})"
                values.extend(sorted(excluded_ids))
            records = connection.execute(
                f"""
                SELECT master_records.*
                FROM (
                    SELECT active_master_records.*,
                           ROW_NUMBER() OVER (
                               ORDER BY active_master_records.sort_order,
                                        active_master_records.id
                           ) AS active_line_number
                    FROM master_records AS active_master_records
                    WHERE active_master_records.deleted_at IS NULL
                ) AS master_records
                WHERE {where}
                ORDER BY sort_order, id
                """,
                values,
            ).fetchall()
            current_revision = self._current_revision(connection)
            if not records:
                return {
                    "revision": current_revision,
                    "deleted": 0,
                    "keptOriginalGroups": 0,
                }
            revision = current_revision + 1
            groups = {
                (
                    str(record["a_number"]),
                    str(record["b_numbers_json"]),
                    str(record["source_prefix"]),
                )
                for record in records
            }
            for sequence, record in enumerate(records, start=1):
                record_id = str(record["id"])
                version = int(record["version"]) + 1
                connection.execute(
                    """
                    UPDATE master_records
                    SET version = ?, updated_at = ?, updated_revision = ?,
                        deleted_at = ?, deleted_revision = ?
                    WHERE id = ? AND deleted_at IS NULL
                    """,
                    (version, now, revision, now, revision, record_id),
                )
                self._append_change(
                    connection,
                    revision=revision,
                    sequence=sequence,
                    record_id=record_id,
                    action="deleted",
                    line_number=int(record["active_line_number"]),
                    before=_snapshot(record),
                    after=None,
                    source_file=None,
                    source_row=None,
                    actor=actor,
                    created_at=now,
                )
            connection.execute(
                "UPDATE master_state SET current_revision = ? WHERE id = 1",
                (revision,),
            )
            return {
                "revision": revision,
                "deleted": len(records),
                "keptOriginalGroups": len(groups),
            }

    def delete_b_numbers(
        self, b_numbers: Iterable[str], session_id: str, *, actor: str
    ) -> dict[str, Any]:
        return self._delete_b_numbers(
            b_numbers,
            session_id,
            actor=actor,
            selected_a_numbers=None,
        )

    def delete_b_numbers_for_a(
        self,
        a_numbers: Iterable[str],
        b_numbers: Iterable[str],
        session_id: str,
        *,
        actor: str,
    ) -> dict[str, Any]:
        selected_a_numbers = set(
            self._normalize_batch_numbers(a_numbers, field="A")
        )
        return self._delete_b_numbers(
            b_numbers,
            session_id,
            actor=actor,
            selected_a_numbers=selected_a_numbers,
        )

    def delete_b_numbers_for_selection(
        self,
        *,
        a_numbers: Iterable[str],
        record_ids: Iterable[str],
        excluded_record_ids: Iterable[str],
        record_filter: MasterRecordFilterRequest | None,
        b_numbers: Iterable[str],
        session_id: str,
        actor: str,
    ) -> dict[str, Any]:
        raw_a_numbers = tuple(a_numbers)
        selected_a_numbers = (
            set(self._normalize_batch_numbers(raw_a_numbers, field="A"))
            if raw_a_numbers
            else set()
        )
        selected_record_ids = {
            str(value).strip() for value in record_ids if str(value).strip()
        }
        excluded_ids = {
            str(value).strip()
            for value in excluded_record_ids
            if str(value).strip()
        }
        if (
            not selected_a_numbers
            and not selected_record_ids
            and record_filter is None
        ):
            raise AppError(
                "INVALID_RECORD_SELECTION",
                "Выберите хотя бы одну строку мастер-файла",
            )
        return self._delete_b_numbers(
            b_numbers,
            session_id,
            actor=actor,
            selected_a_numbers=selected_a_numbers,
            selected_record_ids=selected_record_ids,
            excluded_record_ids=excluded_ids,
            record_filter=record_filter,
        )

    def _delete_b_numbers(
        self,
        b_numbers: Iterable[str],
        session_id: str,
        *,
        actor: str,
        selected_a_numbers: set[str] | None,
        selected_record_ids: set[str] | None = None,
        excluded_record_ids: set[str] | None = None,
        record_filter: MasterRecordFilterRequest | None = None,
    ) -> dict[str, Any]:
        target_numbers = self._normalize_batch_numbers(b_numbers, field="B")
        targets = set(target_numbers)
        now = time.time()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            selection_clauses: list[str] = []
            selection_values: list[Any] = []
            if selected_a_numbers:
                placeholders = ",".join("?" for _ in selected_a_numbers)
                selection_clauses.append(f"a_number IN ({placeholders})")
                selection_values.extend(sorted(selected_a_numbers))
            if selected_record_ids:
                placeholders = ",".join("?" for _ in selected_record_ids)
                selection_clauses.append(f"id IN ({placeholders})")
                selection_values.extend(sorted(selected_record_ids))
            if record_filter is not None:
                stats = self._list_global_stats(connection)
                filtered_where, filtered_values = self._record_filter_sql(
                    query=record_filter.query,
                    parameter_groups=record_filter.parameterGroups,
                    regions=record_filter.regions,
                    duplicates_only=record_filter.duplicatesOnly,
                    exact_duplicates_only=record_filter.exactDuplicatesOnly,
                    exact_duplicate_extras_only=(
                        record_filter.exactDuplicateExtrasOnly
                    ),
                    short_aon_only=record_filter.shortAonOnly,
                    invalid_only=record_filter.invalidOnly,
                    invalid_start_only=record_filter.invalidStartOnly,
                    group_prefixes=stats.get("prefixesByGroup"),
                    region_prefixes_by_number=stats.get("prefixesByRegion"),
                )
                filtered_clause = f"({filtered_where})"
                if excluded_record_ids:
                    placeholders = ",".join(
                        "?" for _ in excluded_record_ids
                    )
                    filtered_clause += f" AND id NOT IN ({placeholders})"
                    filtered_values.extend(sorted(excluded_record_ids))
                selection_clauses.append(f"({filtered_clause})")
                selection_values.extend(filtered_values)
            selection_where = "deleted_at IS NULL"
            if selection_clauses:
                selection_where += f" AND ({' OR '.join(selection_clauses)})"
            active_records = connection.execute(
                f"""
                SELECT * FROM master_records
                WHERE {selection_where}
                ORDER BY sort_order
                """,
                selection_values,
            ).fetchall()
            matched_a_numbers = {
                str(record["a_number"])
                for record in active_records
            }
            matched_record_ids = {
                str(record["id"]) for record in active_records
            }
            not_found_records = (
                len((selected_a_numbers or set()) - matched_a_numbers)
                + len((selected_record_ids or set()) - matched_record_ids)
            )
            linked_targets: set[str] = set()
            updates: list[tuple[sqlite3.Row, list[str], int]] = []
            for record in active_records:
                current = json.loads(str(record["b_numbers_json"]))
                linked_targets.update(
                    number for number in current if number in targets
                )
                removed = sum(1 for number in current if number in targets)
                remaining = [number for number in current if number not in targets]
                if not remaining:
                    remaining = [str(record["a_number"])]
                if remaining == current:
                    continue
                updates.append((record, remaining, removed))
            current_revision = self._current_revision(connection)
            if not updates:
                return {
                    "revision": current_revision,
                    "requested": len(targets),
                    "updatedRecords": 0,
                    "removedAons": 0,
                    "requestedRecords": (
                        len(active_records) + not_found_records
                        if selected_a_numbers is not None
                        else None
                    ),
                    "notFoundRecords": not_found_records,
                    "notLinkedBNumbers": (
                        [
                            number
                            for number in target_numbers
                            if number not in linked_targets
                        ]
                        if selected_a_numbers is not None
                        else []
                    ),
                }
            revision = current_revision + 1
            removed_aons = 0
            for sequence, (record, remaining, removed) in enumerate(
                updates, start=1
            ):
                record_id = str(record["id"])
                version = int(record["version"]) + 1
                removed_aons += removed
                connection.execute(
                    """
                    UPDATE master_records
                    SET b_numbers_json = ?, version = ?, updated_at = ?,
                        updated_revision = ?
                    WHERE id = ? AND deleted_at IS NULL
                    """,
                    (_json(remaining), version, now, revision, record_id),
                )
                before = _snapshot(record)
                assert before is not None
                after = {
                    **before,
                    "bNumbers": remaining,
                    "version": version,
                }
                self._append_change(
                    connection,
                    revision=revision,
                    sequence=sequence,
                    record_id=record_id,
                    action="updated",
                    line_number=self._active_line(
                        connection, int(record["sort_order"])
                    ),
                    before=before,
                    after=after,
                    source_file=None,
                    source_row=None,
                    actor=actor,
                    created_at=now,
                )
            connection.execute(
                "UPDATE master_state SET current_revision = ? WHERE id = 1",
                (revision,),
            )
            return {
                "revision": revision,
                "requested": len(targets),
                "updatedRecords": len(updates),
                "removedAons": removed_aons,
                "requestedRecords": (
                    len(active_records) + not_found_records
                    if selected_a_numbers is not None
                    else None
                ),
                "notFoundRecords": not_found_records,
                "notLinkedBNumbers": (
                    [
                        number
                        for number in target_numbers
                        if number not in linked_targets
                    ]
                    if selected_a_numbers is not None
                    else []
                ),
            }

    def clear_records(self, session_id: str, *, actor: str) -> dict[str, Any]:
        """Remove every master row in one auditable revision.

        Full wipe does not soft-delete row-by-row (that rewrites the heap and
        held ACCESS EXCLUSIVE via DISABLE TRIGGER). TRUNCATE empties the table
        and counter caches; history gets a single ``cleared`` event.
        """
        del session_id
        now = time.time()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            active = int(self._list_global_stats(connection)["activeCount"])
            current_revision = self._current_revision(connection)
            if active == 0:
                return {"revision": current_revision, "deleted": 0}

            revision = current_revision + 1
            # One metadata truncate — no per-row UPDATE and no trigger storm.
            connection.execute(
                """
                TRUNCATE master_records, master_a_counts, master_exact_counts
                RESTART IDENTITY
                """
            )
            self._append_change(
                connection,
                revision=revision,
                sequence=1,
                record_id="0",
                action="cleared",
                line_number=None,
                before={
                    "clearedCount": active,
                    "aNumber": "",
                    "bNumbers": [],
                    "sourcePrefix": "",
                    "comment": "",
                    "version": 0,
                },
                after=None,
                source_file=None,
                source_row=None,
                actor=actor,
                created_at=now,
            )
            connection.execute(
                "UPDATE master_state SET current_revision = ? WHERE id = 1",
                (revision,),
            )
            self._invalidate_list_stats_cache()
            return {"revision": revision, "deleted": active}

    def clear_history_and_reset_version(
        self, session_id: str
    ) -> dict[str, Any]:
        """Turn the current active data into a clean T2-0 baseline."""

        del session_id
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            history_count = int(
                connection.execute(
                    "SELECT COUNT(*) AS count FROM master_changes"
                ).fetchone()["count"]
            )
            import_count = int(
                connection.execute(
                    "SELECT COUNT(*) AS count FROM master_imports"
                ).fetchone()["count"]
            )
            discarded_records = int(
                connection.execute(
                    """
                    SELECT COUNT(*) AS count FROM master_records
                    WHERE deleted_at IS NOT NULL
                    """
                ).fetchone()["count"]
            )
            active_records = int(
                connection.execute(
                    """
                    SELECT COUNT(*) AS count FROM master_records
                    WHERE deleted_at IS NULL
                    """
                ).fetchone()["count"]
            )
            connection.execute(
                "ALTER TABLE master_records DISABLE TRIGGER USER"
            )
            try:
                connection.execute("TRUNCATE master_changes")
                # items / findings / warnings — через CASCADE по FK.
                connection.execute("TRUNCATE master_imports CASCADE")
                if discarded_records:
                    connection.execute(
                        "DELETE FROM master_records WHERE deleted_at IS NOT NULL"
                    )
                if active_records:
                    connection.execute(
                        """
                        UPDATE master_records
                        SET version = 1,
                            created_revision = 0,
                            updated_revision = 0,
                            deleted_revision = NULL
                        WHERE deleted_at IS NULL
                        """
                    )
            finally:
                connection.execute(
                    "ALTER TABLE master_records ENABLE TRIGGER USER"
                )
            connection.execute(
                "UPDATE master_state SET current_revision = 0 WHERE id = 1"
            )
            self._invalidate_list_stats_cache()
            return {
                "revision": 0,
                "clearedChanges": history_count,
                "clearedImports": import_count,
                "activeRecords": active_records,
                "discardedDeletedRecords": discarded_records,
            }

    def export_csv(self, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection, destination.open(
            "w", encoding="utf-8", newline=""
        ) as target:
            writer = csv.writer(target, lineterminator="\r\n")
            writer.writerow([HEADER])
            rows = connection.execute(
                """
                SELECT * FROM master_records
                WHERE deleted_at IS NULL
                ORDER BY sort_order
                """
            )
            for row in rows:
                b_numbers = json.loads(str(row["b_numbers_json"]))
                if not b_numbers:
                    continue
                writer.writerow(
                    [
                        _logical_master_row(
                            str(row["a_number"]),
                            str(row["b_numbers_json"]),
                            str(row["source_prefix"]),
                        )
                    ]
                )
