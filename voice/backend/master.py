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
from .errors import AppError
from .importers import FormattedMappingImporter, importer_for
from .mapping import MappingBuilder, MappingParser, MappingSpool
from .models import (
    HEADER,
    NO_REGION_PREFIX,
    MasterImportAnalyzeRequest,
    MasterMergeRequest,
    MasterRecordRequest,
    PANI_REGION_PREFIX_PATTERN,
    TemplateSettings,
    canonicalize_pani_region_prefix,
)
from .reporting import ReportWriter
from .security import normalize_number
from .storage import Registry, opaque_id
from .validation import ValidationService


logger = logging.getLogger(__name__)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


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
    for b_number in payload["bNumbers"]:
        value = str(b_number)
        if not _number_starts_with_seven(value):
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
        self.database_path = registry.database_path
        self._lock = threading.RLock()
        self._analysis_executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="master-analysis",
        )
        self._initialize()
        self._resume_interrupted_analyses()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS master_state (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    current_revision INTEGER NOT NULL
                );
                INSERT OR IGNORE INTO master_state(id, current_revision)
                VALUES (1, 0);

                CREATE TABLE IF NOT EXISTS master_records (
                    id TEXT PRIMARY KEY,
                    a_number TEXT NOT NULL UNIQUE,
                    b_numbers_json TEXT NOT NULL,
                    source_prefix TEXT NOT NULL,
                    comment TEXT NOT NULL DEFAULT '',
                    sort_order INTEGER NOT NULL,
                    version INTEGER NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    created_revision INTEGER NOT NULL,
                    updated_revision INTEGER NOT NULL,
                    deleted_at REAL,
                    deleted_revision INTEGER
                );
                CREATE INDEX IF NOT EXISTS master_records_active_order
                    ON master_records(deleted_at, sort_order);
                CREATE INDEX IF NOT EXISTS master_records_updated
                    ON master_records(updated_at DESC);

                CREATE TABLE IF NOT EXISTS master_changes (
                    id TEXT PRIMARY KEY,
                    revision INTEGER NOT NULL,
                    sequence INTEGER NOT NULL,
                    record_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    line_number INTEGER,
                    before_json TEXT,
                    after_json TEXT,
                    source_file TEXT,
                    source_row INTEGER,
                    actor TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS master_changes_revision
                    ON master_changes(revision DESC, sequence DESC);
                CREATE INDEX IF NOT EXISTS master_changes_record
                    ON master_changes(record_id, revision DESC);
                CREATE INDEX IF NOT EXISTS master_changes_created_at
                    ON master_changes(created_at DESC);

                CREATE TABLE IF NOT EXISTS master_imports (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    upload_id TEXT NOT NULL,
                    source_name TEXT NOT NULL,
                    detected_mode TEXT NOT NULL,
                    base_revision INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    stats_json TEXT NOT NULL,
                    request_json TEXT NOT NULL DEFAULT '{}',
                    warnings_json TEXT NOT NULL DEFAULT '{}',
                    progress_rows INTEGER NOT NULL DEFAULT 0,
                    progress_phase TEXT NOT NULL DEFAULT 'queued',
                    error_code TEXT,
                    error_message TEXT,
                    updated_at REAL,
                    created_at REAL NOT NULL,
                    merged_at REAL,
                    merged_revision INTEGER
                );
                CREATE INDEX IF NOT EXISTS master_imports_owner
                    ON master_imports(id, session_id);
                CREATE INDEX IF NOT EXISTS master_imports_active_owner
                    ON master_imports(session_id, status, created_at DESC);

                CREATE TABLE IF NOT EXISTS master_duplicate_findings (
                    import_id TEXT NOT NULL,
                    a_number TEXT NOT NULL,
                    source_rows_json TEXT NOT NULL,
                    source_file TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    PRIMARY KEY(import_id, a_number),
                    FOREIGN KEY(import_id) REFERENCES master_imports(id)
                        ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS master_duplicate_findings_a
                    ON master_duplicate_findings(a_number, import_id);

                CREATE TABLE IF NOT EXISTS master_import_items (
                    id TEXT PRIMARY KEY,
                    import_id TEXT NOT NULL,
                    source_row INTEGER NOT NULL,
                    a_number TEXT NOT NULL,
                    incoming_json TEXT NOT NULL,
                    incoming_b_json TEXT NOT NULL DEFAULT '[]',
                    incoming_prefix TEXT NOT NULL DEFAULT '',
                    existing_record_id TEXT,
                    current_json TEXT,
                    status TEXT NOT NULL,
                    FOREIGN KEY(import_id) REFERENCES master_imports(id)
                        ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS master_import_items_status
                    ON master_import_items(import_id, status, source_row);
                CREATE INDEX IF NOT EXISTS master_import_items_a
                    ON master_import_items(import_id, a_number);
                CREATE TABLE IF NOT EXISTS master_import_number_warnings (
                    import_id TEXT NOT NULL,
                    item_id TEXT NOT NULL,
                    source_row INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    number TEXT NOT NULL,
                    a_number TEXT NOT NULL,
                    status TEXT NOT NULL,
                    FOREIGN KEY(import_id) REFERENCES master_imports(id)
                        ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS master_import_warnings_order
                    ON master_import_number_warnings(import_id, source_row);
                CREATE INDEX IF NOT EXISTS master_import_warnings_item
                    ON master_import_number_warnings(import_id, item_id);
                """
            )
            record_columns = {
                str(row["name"])
                for row in connection.execute("PRAGMA table_info(master_records)")
            }
            if "comment" not in record_columns:
                connection.execute(
                    "ALTER TABLE master_records ADD COLUMN comment TEXT NOT NULL DEFAULT ''"
                )
            import_columns = {
                str(row["name"])
                for row in connection.execute("PRAGMA table_info(master_imports)")
            }
            import_migrations = {
                "request_json": "TEXT NOT NULL DEFAULT '{}'",
                "warnings_json": "TEXT NOT NULL DEFAULT '{}'",
                "progress_rows": "INTEGER NOT NULL DEFAULT 0",
                "progress_phase": "TEXT NOT NULL DEFAULT 'queued'",
                "error_code": "TEXT",
                "error_message": "TEXT",
                "updated_at": "REAL",
            }
            for column, definition in import_migrations.items():
                if column not in import_columns:
                    connection.execute(
                        f"ALTER TABLE master_imports ADD COLUMN {column} {definition}"
                    )
            item_columns = {
                str(row["name"])
                for row in connection.execute(
                    "PRAGMA table_info(master_import_items)"
                )
            }
            if "incoming_b_json" not in item_columns:
                connection.execute(
                    "ALTER TABLE master_import_items "
                    "ADD COLUMN incoming_b_json TEXT NOT NULL DEFAULT '[]'"
                )
            if "incoming_prefix" not in item_columns:
                connection.execute(
                    "ALTER TABLE master_import_items "
                    "ADD COLUMN incoming_prefix TEXT NOT NULL DEFAULT ''"
                )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS master_records_signature "
                "ON master_records(deleted_at, b_numbers_json, source_prefix)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS master_import_items_a "
                "ON master_import_items(import_id, a_number)"
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS master_import_items_signature "
                "ON master_import_items(import_id, incoming_b_json, incoming_prefix)"
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
    def _record_payload(row: sqlite3.Row, line_number: int) -> dict[str, Any]:
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
                id, revision, sequence, record_id, action, line_number,
                before_json, after_json, source_file, source_row, actor,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                opaque_id(),
                revision,
                sequence,
                record_id,
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
        invalid_only: bool = False,
        invalid_start_only: bool = False,
    ) -> dict[str, Any]:
        normalized_tokens = _query_tokens(query)
        selected_parameter_groups = tuple(
            dict.fromkeys(value for value in parameter_groups if value)
        )
        selected_regions = tuple(dict.fromkeys(int(value) for value in regions))
        if any(value < 1 or value > 84 for value in selected_regions):
            raise AppError(
                "INVALID_REGION",
                "Номер региона должен быть от 1 до 84",
            )
        order_by = {
            "base": "sort_order",
            "parameter_asc": "source_prefix COLLATE NOCASE ASC, sort_order",
            "parameter_desc": "source_prefix COLLATE NOCASE DESC, sort_order",
        }.get(sort)
        if order_by is None:
            raise AppError("INVALID_SORT", "Неизвестный порядок сортировки")

        with self._connect() as connection:
            latest_duplicate_import = connection.execute(
                """
                SELECT id
                FROM master_imports
                WHERE status = 'merged'
                ORDER BY merged_at DESC, created_at DESC
                LIMIT 1
                """
            ).fetchone()
            duplicate_import_id = (
                str(latest_duplicate_import["id"])
                if latest_duplicate_import is not None
                else None
            )

            clauses = ["deleted_at IS NULL"]
            values: list[Any] = []
            if normalized_tokens:
                query_clauses: list[str] = []
                for token in normalized_tokens:
                    like = f"%{token}%"
                    query_clauses.append(
                        """
                        (
                            a_number LIKE ?
                            OR EXISTS (
                                SELECT 1
                                FROM json_each(b_numbers_json) AS searched_aon
                                WHERE CAST(searched_aon.value AS TEXT) LIKE ?
                            )
                            OR id LIKE ?
                        )
                        """
                    )
                    values.extend([like, like, like])
                clauses.append(f"({' OR '.join(query_clauses)})")
            if selected_parameter_groups or selected_regions:
                parameter_clauses: list[str] = []
                parameter_values: list[str] = []
                region_prefixes = [
                    prefix
                    for number in range(1, 85)
                    for prefix in (
                        f"null/$ & null&D{number}$&",
                        f"null/$ & null&{number}$&",
                    )
                ]
                for group in selected_parameter_groups:
                    if group == "default":
                        parameter_clauses.append("source_prefix = ?")
                        parameter_values.append(NO_REGION_PREFIX)
                    elif group == "pani":
                        parameter_clauses.append(
                            """
                            (
                                source_prefix GLOB ?
                                OR source_prefix GLOB ?
                            )
                            """
                        )
                        parameter_values.extend(
                            [
                                "[0-9]*& null/$ & null/$ &",
                                "+[0-9]*& null/$ & null/$ &",
                            ]
                        )
                    elif group == "pani_region":
                        parameter_clauses.append(
                            """
                            (
                                source_prefix GLOB ?
                                OR source_prefix GLOB ?
                                OR source_prefix GLOB ?
                                OR source_prefix GLOB ?
                            )
                            """
                        )
                        parameter_values.extend(
                            [
                                "[0-9]*& null&D[0-9]*$&",
                                "[0-9]*& null&[0-9]*$&",
                                "[0-9]*& D[0-9]*$&null&",
                                "[0-9]*& [0-9]*$&null&",
                            ]
                        )
                    elif group == "region":
                        placeholders = ",".join(
                            "?" for _ in region_prefixes
                        )
                        parameter_clauses.append(
                            f"source_prefix IN ({placeholders})"
                        )
                        parameter_values.extend(region_prefixes)
                    elif group == "custom":
                        region_placeholders = ",".join(
                            "?" for _ in region_prefixes
                        )
                        parameter_clauses.append(
                            f"""
                            (
                                source_prefix <> ?
                                AND source_prefix NOT GLOB ?
                                AND source_prefix NOT GLOB ?
                                AND source_prefix NOT GLOB ?
                                AND source_prefix NOT GLOB ?
                                AND source_prefix NOT GLOB ?
                                AND source_prefix NOT GLOB ?
                                AND source_prefix NOT IN ({region_placeholders})
                            )
                            """
                        )
                        parameter_values.extend(
                            [
                                NO_REGION_PREFIX,
                                "[0-9]*& null/$ & null/$ &",
                                "+[0-9]*& null/$ & null/$ &",
                                "[0-9]*& null&D[0-9]*$&",
                                "[0-9]*& null&[0-9]*$&",
                                "[0-9]*& D[0-9]*$&null&",
                                "[0-9]*& [0-9]*$&null&",
                                *region_prefixes,
                            ]
                        )
                    else:
                        raise AppError(
                            "INVALID_PARAMETER_GROUP",
                            "Неизвестная группа параметров",
                        )
                if selected_regions:
                    selected_region_prefixes = [
                        prefix
                        for number in selected_regions
                        for prefix in (
                            f"null/$ & null&D{number}$&",
                            f"null/$ & null&{number}$&",
                        )
                    ]
                    placeholders = ",".join(
                        "?" for _ in selected_region_prefixes
                    )
                    combined_region_patterns = [
                        pattern
                        for number in selected_regions
                        for pattern in (
                            f"[0-9]*& null&D{number}$&",
                            f"[0-9]*& null&{number}$&",
                            f"[0-9]*& D{number}$&null&",
                            f"[0-9]*& {number}$&null&",
                        )
                    ]
                    combined_clauses = " OR ".join(
                        "source_prefix GLOB ?"
                        for _ in combined_region_patterns
                    )
                    parameter_clauses.append(
                        f"(source_prefix IN ({placeholders}) OR {combined_clauses})"
                    )
                    parameter_values.extend(
                        [*selected_region_prefixes, *combined_region_patterns]
                    )
                clauses.append(f"({' OR '.join(parameter_clauses)})")
                values.extend(parameter_values)
            if duplicates_only:
                if duplicate_import_id is None:
                    clauses.append("0 = 1")
                else:
                    clauses.append(
                        """
                        EXISTS (
                            SELECT 1
                            FROM master_duplicate_findings AS duplicate
                            WHERE duplicate.import_id = ?
                              AND duplicate.a_number = master_records.a_number
                        )
                        """
                    )
                    values.append(duplicate_import_id)
            if invalid_only:
                clauses.append(
                    """
                    (
                        length(a_number) <> 11
                        OR EXISTS (
                            SELECT 1
                            FROM json_each(b_numbers_json) AS invalid_aon
                            WHERE length(CAST(invalid_aon.value AS TEXT)) <> 11
                        )
                    )
                    """
                )
            if invalid_start_only:
                clauses.append(
                    """
                    (
                        substr(a_number, 1, 1) <> '7'
                        OR EXISTS (
                            SELECT 1
                            FROM json_each(b_numbers_json) AS invalid_start_aon
                            WHERE substr(CAST(invalid_start_aon.value AS TEXT), 1, 1) <> '7'
                        )
                    )
                    """
                )
            where = " AND ".join(clauses)

            total = int(
                connection.execute(
                    f"SELECT COUNT(*) AS count FROM master_records WHERE {where}",
                    values,
                ).fetchone()["count"]
            )
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
                        OR EXISTS (
                            SELECT 1
                            FROM json_each(b_numbers_json) AS invalid_aon
                            WHERE length(CAST(invalid_aon.value AS TEXT)) <> 11
                        )
                      )
                    """
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
                        OR EXISTS (
                            SELECT 1
                            FROM json_each(b_numbers_json) AS invalid_start_aon
                            WHERE substr(CAST(invalid_start_aon.value AS TEXT), 1, 1) <> '7'
                        )
                      )
                    """
                ).fetchone()["count"]
            )
            grouped_parameters: dict[str, dict[str, Any]] = {}
            region_counts = {number: 0 for number in range(1, 85)}
            for row in connection.execute(
                    """
                    SELECT source_prefix, COUNT(*) AS count
                    FROM master_records
                    WHERE deleted_at IS NULL
                    GROUP BY source_prefix
                    ORDER BY count DESC, source_prefix COLLATE NOCASE
                    """
                ):
                group_id, label = _parameter_group(
                    str(row["source_prefix"])
                )
                group = grouped_parameters.setdefault(
                    group_id,
                    {"id": group_id, "label": label, "count": 0},
                )
                group["count"] += int(row["count"])
                region_number = _region_number(str(row["source_prefix"]))
                if region_number is not None:
                    region_counts[region_number] += int(row["count"])
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
                    group_order.get(
                        str(item["id"]),
                        4,
                    ),
                    str(item["label"]),
                ),
            )
            duplicate_findings: dict[str, sqlite3.Row] = {}
            duplicate_count = 0
            if duplicate_import_id is not None:
                duplicate_findings = {
                    str(row["a_number"]): row
                    for row in connection.execute(
                        """
                        SELECT a_number, source_rows_json, source_file
                        FROM master_duplicate_findings
                        WHERE import_id = ?
                        """,
                        (duplicate_import_id,),
                    )
                }
                duplicate_count = int(
                    connection.execute(
                        """
                        SELECT COUNT(*) AS count
                        FROM master_records AS record
                        JOIN master_duplicate_findings AS duplicate
                          ON duplicate.a_number = record.a_number
                        WHERE record.deleted_at IS NULL
                          AND duplicate.import_id = ?
                        """,
                        (duplicate_import_id,),
                    ).fetchone()["count"]
                )
            rows = connection.execute(
                f"""
                SELECT *
                FROM master_records
                WHERE {where}
                ORDER BY {order_by}
                LIMIT ? OFFSET ?
                """,
                [*values, limit, offset],
            ).fetchall()
            items: list[dict[str, Any]] = []
            for row in rows:
                item = self._record_payload(
                    row,
                    self._active_line(connection, int(row["sort_order"])),
                )
                duplicate = duplicate_findings.get(item["aNumber"])
                if duplicate is not None:
                    item.update(
                        {
                            "isDuplicate": True,
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
                items.append(item)
            return {
                "revision": self._current_revision(connection),
                "total": total,
                "activeCount": active,
                "totalB": total_b,
                "historyCount": history_count,
                "invalidANumberCount": invalid_a_count,
                "invalidBNumberCount": invalid_b_count,
                "invalidRecordCount": invalid_record_count,
                "invalidStartANumberCount": invalid_start_a_count,
                "invalidStartBNumberCount": invalid_start_b_count,
                "invalidStartRecordCount": invalid_start_record_count,
                "parameterOptions": parameter_options,
                "regionOptions": [
                    {"value": number, "count": region_counts[number]}
                    for number in range(1, 85)
                ],
                "duplicateCount": duplicate_count,
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
                    record_id LIKE ?
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

    def shutdown(self) -> None:
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
            import_id = opaque_id()
            connection.execute(
                """
                INSERT INTO master_imports(
                    id, session_id, upload_id, source_name, detected_mode,
                    base_revision, status, stats_json, request_json,
                    warnings_json, progress_rows, progress_phase, updated_at,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'queued', '{}', ?, '{}', 0,
                          'queued', ?, ?)
                """,
                (
                    import_id,
                    session_id,
                    body.uploadId,
                    upload.name,
                    body.mode,
                    self._current_revision(connection),
                    body.model_dump_json(),
                    now,
                    now,
                ),
            )
        return import_id

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
                WHERE session_id = ? AND status IN ('queued', 'analyzing')
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
        return payload

    def _update_analysis_progress(
        self,
        import_id: str,
        *,
        phase: str,
        rows: int,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE master_imports
                SET progress_phase = ?, progress_rows = ?, updated_at = ?
                WHERE id = ? AND status IN ('queued', 'analyzing')
                """,
                (phase, rows, time.time(), import_id),
            )

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
        except Exception:
            logger.exception("Master import analysis %s failed", import_id)
            self._fail_import(
                import_id,
                "MASTER_IMPORT_FAILED",
                "Не удалось проверить файл. Повторите загрузку.",
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
        spool_path = temporary_dir / "spool.sqlite3"
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
            with ReportWriter(report_path) as report, MappingSpool(
                spool_path
            ) as spool:
                spool.connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS duplicate_source_rows (
                        a_number TEXT NOT NULL,
                        source_row INTEGER NOT NULL,
                        PRIMARY KEY(a_number, source_row)
                    ) WITHOUT ROWID
                    """
                )

                def remember_duplicate(
                    a_number: str,
                    first_source_row: int,
                    duplicate_source_row: int,
                ) -> None:
                    spool.connection.executemany(
                        """
                        INSERT OR IGNORE INTO duplicate_source_rows(
                            a_number, source_row
                        ) VALUES (?, ?)
                        """,
                        (
                            (a_number, first_source_row),
                            (a_number, duplicate_source_row),
                        ),
                    )

                builder = MappingBuilder(spool, report)
                if mode == "formatted":
                    parser_stats = builder.build_formatted(
                        FormattedMappingImporter(importer).iterateRows(selected.name),
                        parser=MappingParser(
                            auto_detect=True,
                            allow_mixed_templates=True,
                            allow_number_whitespace=True,
                        ),
                        duplicate_a_callback=remember_duplicate,
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
                        progress=report_progress,
                    )
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
        spool: MappingSpool,
    ) -> None:
        counts = {"new": 0, "unchanged": 0, "conflict": 0}
        persisted = 0
        now = time.time()
        with self._connect() as connection:
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
                    for _ in range(500):
                        batch.append(next(entries))
                except StopIteration:
                    pass
                if not batch:
                    break
                a_numbers = [mapping.aNumber for mapping, _ in batch]
                placeholders = ",".join("?" for _ in a_numbers)
                current_rows = {
                    str(row["a_number"]): row
                    for row in connection.execute(
                        f"SELECT * FROM master_records "
                        f"WHERE a_number IN ({placeholders})",
                        a_numbers,
                    )
                }
                item_rows: list[tuple[Any, ...]] = []
                warning_rows: list[tuple[Any, ...]] = []
                for mapping, source_row in batch:
                    prefix = canonicalize_pani_region_prefix(
                        mapping.sourcePrefix or NO_REGION_PREFIX
                    )
                    incoming = {
                        "aNumber": mapping.aNumber,
                        "bNumbers": list(mapping.bNumbers),
                        "sourcePrefix": prefix,
                    }
                    current_row = current_rows.get(mapping.aNumber)
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
                    item_id = opaque_id()
                    b_json = _json(incoming["bNumbers"])
                    item_rows.append(
                        (
                            item_id,
                            import_id,
                            source_row,
                            mapping.aNumber,
                            _json(incoming),
                            b_json,
                            prefix,
                            (
                                str(current_row["id"])
                                if current_row is not None
                                else None
                            ),
                            _json(current) if current is not None else None,
                            status,
                        )
                    )
                    for warning in _number_start_errors(
                        incoming,
                        source_row=source_row,
                        item_id=item_id,
                    ):
                        warning_rows.append(
                            (
                                import_id,
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
                    INSERT INTO master_import_items(
                        id, import_id, source_row, a_number, incoming_json,
                        incoming_b_json, incoming_prefix, existing_record_id,
                        current_json, status
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    item_rows,
                )
                if warning_rows:
                    connection.executemany(
                        """
                        INSERT INTO master_import_number_warnings(
                            import_id, item_id, source_row, kind, number,
                            a_number, status
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        warning_rows,
                    )
                connection.commit()
                persisted += len(batch)
                self._update_analysis_progress(
                    import_id,
                    phase="comparing",
                    rows=persisted,
                )
                if len(batch) < 500:
                    break

            connection.executescript(
                """
                DROP TABLE IF EXISTS temp.unique_incoming_signatures;
                DROP TABLE IF EXISTS temp.rename_matches;
                CREATE TEMP TABLE unique_incoming_signatures (
                    incoming_b_json TEXT NOT NULL,
                    incoming_prefix TEXT NOT NULL,
                    PRIMARY KEY(incoming_b_json, incoming_prefix)
                ) WITHOUT ROWID;
                CREATE TEMP TABLE rename_matches (
                    item_id TEXT PRIMARY KEY,
                    record_id TEXT NOT NULL
                ) WITHOUT ROWID;
                """
            )
            connection.execute(
                """
                INSERT INTO unique_incoming_signatures(
                    incoming_b_json, incoming_prefix
                )
                SELECT incoming_b_json, incoming_prefix
                FROM master_import_items
                WHERE import_id = ?
                GROUP BY incoming_b_json, incoming_prefix
                HAVING COUNT(*) = 1
                """,
                (import_id,),
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
                  ON record.b_numbers_json = item.incoming_b_json
                 AND record.source_prefix = item.incoming_prefix
                 AND record.deleted_at IS NULL
                LEFT JOIN master_import_items AS blocker
                  ON blocker.import_id = item.import_id
                 AND blocker.a_number = record.a_number
                WHERE item.import_id = ?
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
                SELECT matches.item_id, item.incoming_json, record.*
                FROM rename_matches AS matches
                JOIN master_import_items AS item ON item.id = matches.item_id
                JOIN master_records AS record ON record.id = matches.record_id
                """
            )
            while True:
                rename_batch = rename_cursor.fetchmany(500)
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
                            str(row["id"]),
                            _json(_snapshot(row)),
                            str(row["item_id"]),
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
                    ((import_id, str(row["item_id"])) for row in rename_batch),
                )
                renamed += len(rename_batch)
                connection.commit()
            # The rename scan may legitimately return no rows. End its read
            # snapshot before writing duplicate findings so a concurrent lock
            # status poll cannot make SQLite reject a read-to-write upgrade.
            connection.commit()
            counts["new"] -= renamed
            counts["conflict"] += renamed

            duplicate_groups = int(
                spool.connection.execute(
                    "SELECT COUNT(DISTINCT a_number) FROM duplicate_source_rows"
                ).fetchone()[0]
            )
            duplicate_cursor = spool.connection.execute(
                """
                SELECT DISTINCT a_number
                FROM duplicate_source_rows
                ORDER BY a_number
                """
            )
            duplicate_batch: list[tuple[Any, ...]] = []
            for duplicate_row in duplicate_cursor:
                a_number = str(duplicate_row[0])
                source_rows = [
                    int(row[0])
                    for row in spool.connection.execute(
                        """
                        SELECT source_row FROM duplicate_source_rows
                        WHERE a_number = ? ORDER BY source_row LIMIT 500
                        """,
                        (a_number,),
                    )
                ]
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
            stats = {
                **counts,
                "sourceRows": int(parser_stats["inputRows"]),
                "uniqueA": int(parser_stats["uniqueA"]),
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
            duplicate = connection.execute(
                """
                SELECT source_row FROM master_import_items
                WHERE import_id = ? AND a_number = ? AND id != ?
                LIMIT 1
                """,
                (import_id, payload["aNumber"], item_id),
            ).fetchone()
            if duplicate is not None:
                raise AppError(
                    "DUPLICATE_IMPORT_A",
                    (
                        f"Опорный номер {payload['aNumber']} уже используется "
                        f"в строке CSV {int(duplicate['source_row'])}"
                    ),
                    status_code=409,
                )

            current_row = connection.execute(
                """
                SELECT * FROM master_records
                WHERE a_number = ?
                """,
                (payload["aNumber"],),
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
                        str(current_row["id"])
                        if current_row is not None
                        else None
                    ),
                    _json(current) if current is not None else None,
                    next_status,
                    item_id,
                ),
            )
            connection.execute(
                """
                DELETE FROM master_import_number_warnings
                WHERE import_id = ? AND item_id = ?
                """,
                (import_id, item_id),
            )
            item_warnings = _number_start_errors(
                payload,
                source_row=int(item["source_row"]),
                item_id=item_id,
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
                            import_id,
                            item_id,
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

    def merge_import(
        self, import_id: str, body: MasterMergeRequest, session_id: str
    ) -> dict[str, Any]:
        selected = set(body.replaceConflictItemIds)
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
            if import_row["status"] != "analyzed":
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
            conflict_total = int(
                connection.execute(
                    """
                    SELECT COUNT(*) AS count FROM master_import_items
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
            items = connection.execute(
                """
                SELECT * FROM master_import_items
                WHERE import_id = ? AND status IN ('new', 'conflict')
                ORDER BY source_row, id
                """,
                (import_id,),
            )
            while True:
                batch = items.fetchmany(500)
                if not batch:
                    break
                for item in batch:
                    status = str(item["status"])
                    if status == "conflict":
                        replace = (
                            body.conflictStrategy == "replace_all"
                            or (
                                body.conflictStrategy == "selected"
                                and str(item["id"]) in selected
                            )
                        )
                        if not replace:
                            continue
                        applied_conflicts += 1
                    sequence += 1
                    incoming = json.loads(str(item["incoming_json"]))
                    record = (
                        connection.execute(
                            "SELECT * FROM master_records WHERE id = ?",
                            (item["existing_record_id"],),
                        ).fetchone()
                        if item["existing_record_id"] is not None
                        else connection.execute(
                            "SELECT * FROM master_records WHERE a_number = ?",
                            (incoming["aNumber"],),
                        ).fetchone()
                    )
                    if record is None:
                        record_id = opaque_id()
                        connection.execute(
                            """
                            INSERT INTO master_records(
                                id, a_number, b_numbers_json, source_prefix,
                                sort_order, version, created_at, updated_at,
                                created_revision, updated_revision, deleted_at,
                                deleted_revision
                            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL)
                            """,
                            (
                                record_id,
                                incoming["aNumber"],
                                _json(incoming["bNumbers"]),
                                incoming["sourcePrefix"],
                                next_sort,
                                now,
                                now,
                                revision,
                                revision,
                            ),
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
                        record_id = str(record["id"])
                        before = (
                            _snapshot(record)
                            if record["deleted_at"] is None
                            else None
                        )
                        version = int(record["version"]) + 1
                        connection.execute(
                            """
                            UPDATE master_records
                            SET a_number = ?, b_numbers_json = ?,
                                source_prefix = ?, version = ?, updated_at = ?,
                                updated_revision = ?, deleted_at = NULL,
                                deleted_revision = NULL
                            WHERE id = ?
                            """,
                            (
                                incoming["aNumber"],
                                _json(incoming["bNumbers"]),
                                incoming["sourcePrefix"],
                                version,
                                now,
                                revision,
                                record_id,
                            ),
                        )
                        if before is None:
                            active_count += 1
                        line_number = self._active_line(
                            connection, int(record["sort_order"])
                        )
                        after = {
                            "id": record_id,
                            **incoming,
                            "comment": str(record["comment"] or ""),
                            "version": version,
                        }
                        action = "restored" if before is None else "updated"
                        if before is None:
                            added += 1
                        else:
                            updated += 1
                    self._append_change(
                        connection,
                        revision=revision,
                        sequence=sequence,
                        record_id=record_id,
                        action=action,
                        line_number=line_number,
                        before=before,
                        after=after,
                        source_file=str(import_row["source_name"]),
                        source_row=int(item["source_row"]),
                        actor=session_id,
                        created_at=now,
                    )

            kept_conflicts = conflict_total - applied_conflicts
            if sequence == 0:
                connection.execute(
                    """
                    UPDATE master_imports
                    SET status = 'merged', merged_at = ?, merged_revision = ?
                    WHERE id = ?
                    """,
                    (now, current_revision, import_id),
                )
                return {
                    "revision": current_revision,
                    "added": 0,
                    "updated": 0,
                    "keptConflicts": kept_conflicts,
                }
            connection.execute(
                "UPDATE master_state SET current_revision = ? WHERE id = 1",
                (revision,),
            )
            connection.execute(
                """
                UPDATE master_imports
                SET status = 'merged', merged_at = ?, merged_revision = ?
                WHERE id = ?
                """,
                (now, revision, import_id),
            )
            return {
                "revision": revision,
                "added": added,
                "updated": updated,
                "keptConflicts": kept_conflicts,
            }

    def create_record(
        self, body: MasterRecordRequest, session_id: str
    ) -> dict[str, Any]:
        payload = self._normalize_record(body)
        now = time.time()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT * FROM master_records WHERE a_number = ?",
                (payload["aNumber"],),
            ).fetchone()
            if existing is not None and existing["deleted_at"] is None:
                raise AppError(
                    "MASTER_A_EXISTS",
                    "Такая связка уже есть в исходной базе",
                    status_code=409,
                )
            revision = self._current_revision(connection) + 1
            if existing is None:
                record_id = opaque_id()
                sort_order = int(
                    connection.execute(
                        "SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM master_records"
                    ).fetchone()["value"]
                )
                version = 1
                connection.execute(
                    """
                    INSERT INTO master_records(
                        id, a_number, b_numbers_json, source_prefix, comment,
                        sort_order, version, created_at, updated_at,
                        created_revision, updated_revision
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record_id,
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
                )
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
                        record_id,
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
                actor=session_id,
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
        self, record_id: str, body: MasterRecordRequest, session_id: str
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
            duplicate = connection.execute(
                """
                SELECT id FROM master_records
                WHERE a_number = ? AND id <> ?
                """,
                (payload["aNumber"], record_id),
            ).fetchone()
            if duplicate is not None:
                raise AppError(
                    "MASTER_A_EXISTS",
                    "Связка с таким опорным номером уже существует",
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
                actor=session_id,
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
        self, record_id: str, expected_version: int | None, session_id: str
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
                actor=session_id,
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
        self, a_numbers: Iterable[str], session_id: str
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
                    actor=session_id,
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

    def delete_b_numbers(
        self, b_numbers: Iterable[str], session_id: str
    ) -> dict[str, Any]:
        return self._delete_b_numbers(
            b_numbers,
            session_id,
            selected_a_numbers=None,
        )

    def delete_b_numbers_for_a(
        self,
        a_numbers: Iterable[str],
        b_numbers: Iterable[str],
        session_id: str,
    ) -> dict[str, Any]:
        selected_a_numbers = set(
            self._normalize_batch_numbers(a_numbers, field="A")
        )
        return self._delete_b_numbers(
            b_numbers,
            session_id,
            selected_a_numbers=selected_a_numbers,
        )

    def _delete_b_numbers(
        self,
        b_numbers: Iterable[str],
        session_id: str,
        *,
        selected_a_numbers: set[str] | None,
    ) -> dict[str, Any]:
        target_numbers = self._normalize_batch_numbers(b_numbers, field="B")
        targets = set(target_numbers)
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
            matched_a_numbers = {
                str(record["a_number"])
                for record in active_records
                if selected_a_numbers is None
                or str(record["a_number"]) in selected_a_numbers
            }
            linked_targets: set[str] = set()
            updates: list[tuple[sqlite3.Row, list[str], int]] = []
            for record in active_records:
                if (
                    selected_a_numbers is not None
                    and str(record["a_number"]) not in selected_a_numbers
                ):
                    continue
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
                        len(selected_a_numbers)
                        if selected_a_numbers is not None
                        else None
                    ),
                    "notFoundRecords": (
                        len(selected_a_numbers - matched_a_numbers)
                        if selected_a_numbers is not None
                        else 0
                    ),
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
                    actor=session_id,
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
                    len(selected_a_numbers)
                    if selected_a_numbers is not None
                    else None
                ),
                "notFoundRecords": (
                    len(selected_a_numbers - matched_a_numbers)
                    if selected_a_numbers is not None
                    else 0
                ),
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

    def clear_records(self, session_id: str) -> dict[str, Any]:
        """Soft-delete every active record in one auditable revision."""
        now = time.time()
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            records = connection.execute(
                """
                SELECT * FROM master_records
                WHERE deleted_at IS NULL
                ORDER BY sort_order
                """
            ).fetchall()
            current_revision = self._current_revision(connection)
            if not records:
                return {"revision": current_revision, "deleted": 0}

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
                    line_number=sequence,
                    before=_snapshot(record),
                    after=None,
                    source_file=None,
                    source_row=None,
                    actor=session_id,
                    created_at=now,
                )
            connection.execute(
                "UPDATE master_state SET current_revision = ? WHERE id = 1",
                (revision,),
            )
            return {"revision": revision, "deleted": len(records)}

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
            connection.execute("DELETE FROM master_changes")
            # Import items and duplicate findings are part of the review journal
            # and are removed through their ON DELETE CASCADE relationships.
            connection.execute("DELETE FROM master_imports")
            connection.execute(
                "DELETE FROM master_records WHERE deleted_at IS NOT NULL"
            )
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
            connection.execute(
                "UPDATE master_state SET current_revision = 0 WHERE id = 1"
            )
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
                first = f"4:4,1,{b_numbers[0]}"
                rest = "".join(f";4,1,{number}" for number in b_numbers[1:])
                prefix = canonicalize_pani_region_prefix(
                    str(row["source_prefix"])
                )
                terminator = (
                    ";" if PANI_REGION_PREFIX_PATTERN.fullmatch(prefix) else ""
                )
                writer.writerow(
                    [f"{prefix}{row['a_number']}={first}{rest}{terminator}"]
                )
