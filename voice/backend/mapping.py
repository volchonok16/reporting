from __future__ import annotations

import csv
import os
import sqlite3
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import AppError, CancelledError
from .importers import RowRecord, row_value
from .models import (
    CsvSettings,
    HEADER,
    LEGACY_PANI_REGION_PREFIX_PATTERN,
    ManualMapping,
    Mapping,
    MappingFormatOverride,
    PANI_PREFIX_PATTERN,
    PANI_REGION_PREFIX_PATTERN,
    TemplateSettings,
    canonicalize_pani_region_prefix,
    resolved_first_b_marker,
)
from .reporting import ReportWriter
from .security import normalize_number


ProgressCallback = Callable[[int], None]
CancelCallback = Callable[[], bool]


@dataclass(frozen=True, slots=True)
class ParsedMapping:
    a_number: str
    b_numbers: tuple[str, ...]
    source_prefix: str
    linked_a_number: str | None


def linked_a_from_prefix(prefix: str) -> str | None:
    """Return the optional A-number stored in the first prefix field."""

    candidate = prefix.split("&", 1)[0].strip().removeprefix("+")
    if candidate and candidate.isascii() and candidate.isdigit():
        return candidate
    return None


class MappingSpool:
    """Per-job SQLite state preserving first-seen order without unbounded RAM."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=OFF")
        self.connection.execute("PRAGMA temp_store=MEMORY")
        self.connection.execute("PRAGMA cache_size=-65536")
        self.connection.execute("PRAGMA locking_mode=EXCLUSIVE")
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS mappings (
                a_number TEXT PRIMARY KEY,
                first_sequence INTEGER NOT NULL,
                source_row INTEGER NOT NULL,
                source_prefix TEXT,
                linked_a_number TEXT
            );
            CREATE TABLE IF NOT EXISTS rows (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                a_number TEXT NOT NULL,
                b_number TEXT NOT NULL,
                source_row INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS rows_a_sequence
                ON rows(a_number, sequence);
            CREATE INDEX IF NOT EXISTS rows_b_a
                ON rows(b_number, a_number);
            CREATE TABLE IF NOT EXISTS seen_b (
                a_number TEXT NOT NULL,
                b_number TEXT NOT NULL,
                PRIMARY KEY (a_number, b_number)
            ) WITHOUT ROWID;
            """
        )
        self.connection.commit()
        latest = self.connection.execute(
            "SELECT COALESCE(MAX(first_sequence), 0) FROM mappings"
        ).fetchone()[0]
        self._first_sequence = int(latest) + 1

    def add_a(
        self,
        a_number: str,
        source_row: int,
        *,
        source_prefix: str | None = None,
        linked_a_number: str | None = None,
    ) -> bool:
        """Keep an A-number in first-seen order even when it has no B yet."""

        cursor = self.connection.execute(
            """
            INSERT OR IGNORE INTO mappings(
                a_number,
                first_sequence,
                source_row,
                source_prefix,
                linked_a_number
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                a_number,
                self._first_sequence,
                source_row,
                source_prefix,
                linked_a_number,
            ),
        )
        new_a = cursor.rowcount == 1
        if new_a:
            self._first_sequence += 1
        return new_a

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
        new_a = self.add_a(
            a_number,
            source_row,
            source_prefix=source_prefix,
            linked_a_number=linked_a_number,
        )

        duplicate = False
        if not keep_duplicate:
            seen_cursor = self.connection.execute(
                "INSERT OR IGNORE INTO seen_b(a_number, b_number) VALUES (?, ?)",
                (a_number, b_number),
            )
            duplicate = seen_cursor.rowcount == 0
        if not duplicate:
            self.connection.execute(
                "INSERT INTO rows(a_number, b_number, source_row) VALUES (?, ?, ?)",
                (a_number, b_number, source_row),
            )
        return new_a, duplicate

    def commit(self) -> None:
        self.connection.commit()

    def counts(self) -> tuple[int, int]:
        a_count = self.connection.execute("SELECT COUNT(*) FROM mappings").fetchone()[0]
        b_count = self.connection.execute("SELECT COUNT(*) FROM rows").fetchone()[0]
        return int(a_count), int(b_count)

    def contains_a(self, a_number: str) -> bool:
        return (
            self.connection.execute(
                "SELECT 1 FROM mappings WHERE a_number = ?", (a_number,)
            ).fetchone()
            is not None
        )

    def source_row_for_a(self, a_number: str) -> int | None:
        row = self.connection.execute(
            "SELECT source_row FROM mappings WHERE a_number = ?",
            (a_number,),
        ).fetchone()
        return int(row[0]) if row is not None else None

    def delete_a(self, a_number: str) -> int:
        row_count = self.connection.execute(
            "SELECT COUNT(*) FROM rows WHERE a_number = ?", (a_number,)
        ).fetchone()[0]
        self.connection.execute("DELETE FROM rows WHERE a_number = ?", (a_number,))
        self.connection.execute("DELETE FROM seen_b WHERE a_number = ?", (a_number,))
        self.connection.execute("DELETE FROM mappings WHERE a_number = ?", (a_number,))
        return int(row_count)

    def rename_a(self, old_a_number: str, new_a_number: str) -> bool:
        """Rename an A-number in-place while preserving its source order."""

        if old_a_number == new_a_number:
            return self.contains_a(old_a_number)
        if not self.contains_a(old_a_number):
            return False
        if self.contains_a(new_a_number):
            raise AppError(
                "A_RENAME_CONFLICT",
                f"Опорный номер {new_a_number} уже существует в файле",
            )
        self.connection.execute(
            "UPDATE mappings SET a_number = ? WHERE a_number = ?",
            (new_a_number, old_a_number),
        )
        self.connection.execute(
            """
            UPDATE rows
            SET a_number = ?,
                b_number = CASE WHEN b_number = ? THEN ? ELSE b_number END
            WHERE a_number = ?
            """,
            (new_a_number, old_a_number, new_a_number, old_a_number),
        )
        self.connection.execute(
            "DELETE FROM seen_b WHERE a_number = ?",
            (old_a_number,),
        )
        self.connection.execute(
            """
            INSERT OR IGNORE INTO seen_b(a_number, b_number)
            SELECT ?, b_number FROM rows WHERE a_number = ?
            """,
            (new_a_number, new_a_number),
        )
        return True

    def delete_b(self, a_number: str, b_number: str) -> int:
        cursor = self.connection.execute(
            "DELETE FROM rows WHERE a_number = ? AND b_number = ?",
            (a_number, b_number),
        )
        self.connection.execute(
            "DELETE FROM seen_b WHERE a_number = ? AND b_number = ?",
            (a_number, b_number),
        )
        return int(cursor.rowcount)

    def a_numbers_for_b(self, b_number: str) -> list[str]:
        return [
            str(row[0])
            for row in self.connection.execute(
                """
                SELECT DISTINCT a_number
                FROM rows
                WHERE b_number = ?
                ORDER BY a_number
                """,
                (b_number,),
            )
        ]

    def delete_b_everywhere(self, b_number: str) -> int:
        cursor = self.connection.execute(
            "DELETE FROM rows WHERE b_number = ?",
            (b_number,),
        )
        self.connection.execute(
            "DELETE FROM seen_b WHERE b_number = ?",
            (b_number,),
        )
        return int(cursor.rowcount)

    def b_count(self, a_number: str) -> int:
        return int(
            self.connection.execute(
                "SELECT COUNT(*) FROM rows WHERE a_number = ?", (a_number,)
            ).fetchone()[0]
        )

    def iter_mappings(self) -> Iterator[Mapping]:
        for mapping, _source_row in self.iter_mapping_entries():
            yield mapping

    def iter_mapping_entries(self) -> Iterator[tuple[Mapping, int]]:
        """Yield grouped mappings and their first source row in bounded memory."""

        cursor = self.connection.execute(
            """
            SELECT
                m.a_number,
                m.first_sequence,
                m.source_row,
                m.source_prefix,
                r.b_number
            FROM mappings AS m
            JOIN rows AS r ON r.a_number = m.a_number
            ORDER BY m.first_sequence, r.sequence
            """
        )
        current_a: str | None = None
        current_order = 0
        current_source_row = 0
        current_prefix: str | None = None
        b_numbers: list[str] = []
        for a_number, first_order, source_row, source_prefix, b_number in cursor:
            if current_a is not None and a_number != current_a:
                yield (
                    Mapping(
                        aNumber=current_a,
                        bNumbers=b_numbers,
                        firstSeenOrder=current_order,
                        sourcePrefix=current_prefix,
                    ),
                    current_source_row,
                )
                b_numbers = []
            current_a = str(a_number)
            current_order = int(first_order)
            current_source_row = int(source_row)
            current_prefix = (
                str(source_prefix) if source_prefix is not None else None
            )
            b_numbers.append(str(b_number))
        if current_a is not None:
            yield (
                Mapping(
                    aNumber=current_a,
                    bNumbers=b_numbers,
                    firstSeenOrder=current_order,
                    sourcePrefix=current_prefix,
                ),
                current_source_row,
            )

    def close(self) -> None:
        self.connection.commit()
        self.connection.close()

    def __enter__(self) -> "MappingSpool":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


def _header_token(value: Any) -> str:
    return (
        str(value or "")
        .strip()
        .lower()
        .replace("_", "")
        .replace("-", "")
        .replace(" ", "")
        .replace("№", "номер")
    )


A_HEADER_TOKENS = {
    "a",
    "aномер",
    "anumber",
    "основнойномер",
    "основной",
    "аномер",
}
B_HEADER_TOKENS = {
    "b",
    "bномер",
    "bnumber",
    "номерротации",
    "ротация",
    "бномер",
}


def is_raw_header(row: RowRecord, a_column: int, b_column: int) -> bool:
    a_token = _header_token(row_value(row.values, a_column))
    b_token = _header_token(row_value(row.values, b_column))
    return a_token in A_HEADER_TOKENS and b_token in B_HEADER_TOKENS


def _cancel_if_requested(cancelled: CancelCallback | None) -> None:
    if cancelled is not None and cancelled():
        raise CancelledError


class MappingBuilder:
    def __init__(self, spool: MappingSpool, report: ReportWriter):
        self.spool = spool
        self.report = report

    @staticmethod
    def _stats() -> dict[str, int]:
        return {
            "inputRows": 0,
            "uniqueA": 0,
            "totalB": 0,
            "emptyBReplaced": 0,
            "duplicateA": 0,
            "duplicateBRemoved": 0,
            "invalidRows": 0,
            "skippedRows": 0,
            "resultRows": 0,
        }

    def build_raw(
        self,
        rows: Iterable[RowRecord],
        *,
        a_column: int,
        b_column: int,
        keep_duplicate_b: bool = False,
        replace_empty_b_with_a: bool = True,
        allow_number_whitespace: bool = False,
        duplicate_a_callback: Callable[[str, int, int], None] | None = None,
        progress: ProgressCallback | None = None,
        cancelled: CancelCallback | None = None,
    ) -> dict[str, int]:
        stats = self._stats()
        header_pending = True
        for row in rows:
            _cancel_if_requested(cancelled)
            raw_a = row_value(row.values, a_column)
            raw_b = row_value(row.values, b_column)
            row_is_empty = (raw_a is None or not str(raw_a).strip()) and (
                raw_b is None or not str(raw_b).strip()
            )
            if header_pending:
                if row_is_empty:
                    stats["inputRows"] += 1
                    stats["skippedRows"] += 1
                    self.report.add(
                        source_row=row.source_row,
                        code="SKIPPED_EMPTY_ROW",
                        message="Пустая строка пропущена",
                    )
                    continue
                header_pending = False
                if is_raw_header(row, a_column, b_column) or (
                    _header_token(raw_a) in A_HEADER_TOKENS
                    and (raw_b is None or not str(raw_b).strip())
                ):
                    continue
            stats["inputRows"] += 1
            if row_is_empty:
                stats["skippedRows"] += 1
                self.report.add(
                    source_row=row.source_row,
                    code="SKIPPED_EMPTY_ROW",
                    message="Пустая строка пропущена",
                )
                continue
            try:
                a_number = normalize_number(
                    raw_a,
                    source_row=row.source_row,
                    field="A",
                    allow_whitespace_error=allow_number_whitespace,
                )
                if not a_number:
                    raise AppError(
                        "INVALID_A_NUMBER",
                        f"В строке {row.source_row} отсутствует A-номер",
                        source_row=row.source_row,
                    )
                first_source_row = self.spool.source_row_for_a(a_number)
                b_number = normalize_number(
                    raw_b,
                    source_row=row.source_row,
                    field="B",
                    allow_whitespace_error=allow_number_whitespace,
                )
                if not b_number:
                    stats["emptyBReplaced"] += 1
                    if replace_empty_b_with_a:
                        b_number = a_number
                    else:
                        new_a = self.spool.add_a(a_number, row.source_row)
                        duplicate = False
                if b_number:
                    new_a, duplicate = self.spool.add(
                        a_number,
                        b_number,
                        row.source_row,
                        keep_duplicate=keep_duplicate_b,
                    )
                if not new_a:
                    stats["duplicateA"] += 1
                    if (
                        duplicate_a_callback is not None
                        and first_source_row is not None
                    ):
                        duplicate_a_callback(
                            a_number,
                            first_source_row,
                            row.source_row,
                        )
                    if bool(
                        getattr(self.spool, "preserve_duplicate_a", False)
                    ):
                        self.report.add(
                            source_row=row.source_row,
                            code="DUPLICATE_A_PRESERVED",
                            message="Повторная строка A сохранена отдельно",
                            a_number=a_number,
                        )
                if duplicate:
                    stats["duplicateBRemoved"] += 1
                    self.report.add(
                        source_row=row.source_row,
                        code="DUPLICATE_B_REMOVED",
                        message="Повторный B-номер удален",
                        a_number=a_number,
                        b_number=b_number,
                    )
            except AppError as exc:
                stats["invalidRows"] += 1
                self.report.add(
                    source_row=row.source_row,
                    code=exc.code,
                    message=exc.message,
                    a_number=raw_a,
                    b_number=raw_b,
                )
            if stats["inputRows"] % 10_000 == 0:
                self.spool.commit()
                if progress is not None:
                    progress(stats["inputRows"])
        self.spool.commit()
        stats["uniqueA"], stats["totalB"] = self.spool.counts()
        stats["resultRows"] = stats["uniqueA"]
        return stats

    def build_formatted(
        self,
        rows: Iterable[RowRecord],
        *,
        parser: "MappingParser",
        keep_duplicate_b: bool = False,
        duplicate_a_callback: Callable[[str, int, int], None] | None = None,
        progress: ProgressCallback | None = None,
        cancelled: CancelCallback | None = None,
    ) -> dict[str, int]:
        stats = self._stats()
        for row in rows:
            _cancel_if_requested(cancelled)
            raw_value = next(
                (
                    value
                    for value in row.values
                    if value is not None and str(value).strip()
                ),
                None,
            )
            if raw_value is None:
                stats["inputRows"] += 1
                stats["skippedRows"] += 1
                self.report.add(
                    source_row=row.source_row,
                    code="SKIPPED_EMPTY_ROW",
                    message="Пустая строка пропущена",
                )
                continue
            text = str(raw_value)
            if text == HEADER:
                continue
            stats["inputRows"] += 1
            try:
                parsed = parser.parse(text, source_row=row.source_row)
                first_source_row = self.spool.source_row_for_a(parsed.a_number)
                if first_source_row is not None:
                    stats["duplicateA"] += 1
                    if duplicate_a_callback is not None:
                        duplicate_a_callback(
                            parsed.a_number,
                            first_source_row,
                            row.source_row,
                        )
                    preserve_duplicate_a = bool(
                        getattr(self.spool, "preserve_duplicate_a", False)
                    )
                    self.report.add(
                        source_row=row.source_row,
                        code=(
                            "DUPLICATE_A_PRESERVED"
                            if preserve_duplicate_a
                            else "DUPLICATE_A_MERGED"
                        ),
                        message=(
                            "Повторная строка A сохранена отдельно"
                            if preserve_duplicate_a
                            else "Повторная строка A объединена с первой"
                        ),
                        a_number=parsed.a_number,
                    )
                for b_number in parsed.b_numbers:
                    _new_a, duplicate_b = self.spool.add(
                        parsed.a_number,
                        b_number,
                        row.source_row,
                        keep_duplicate=keep_duplicate_b,
                        source_prefix=parsed.source_prefix,
                        linked_a_number=parsed.linked_a_number,
                    )
                    if duplicate_b:
                        stats["duplicateBRemoved"] += 1
                        self.report.add(
                            source_row=row.source_row,
                            code="DUPLICATE_B_REMOVED",
                            message="Повторный B-номер удален",
                            a_number=parsed.a_number,
                            b_number=b_number,
                        )
            except AppError as exc:
                stats["invalidRows"] += 1
                self.report.add(
                    source_row=row.source_row,
                    code=exc.code,
                    message=exc.message,
                )
            if stats["inputRows"] % 10_000 == 0:
                self.spool.commit()
                if progress is not None:
                    progress(stats["inputRows"])
        self.spool.commit()
        stats["uniqueA"], stats["totalB"] = self.spool.counts()
        stats["resultRows"] = stats["uniqueA"]
        return stats


class MappingParser:
    def __init__(
        self,
        template: TemplateSettings | None = None,
        *,
        auto_detect: bool = False,
        allow_mixed_templates: bool = False,
        allow_number_whitespace: bool = False,
    ):
        self.template = template or TemplateSettings()
        self.auto_detect = auto_detect
        self.allow_mixed_templates = allow_mixed_templates
        self.allow_number_whitespace = allow_number_whitespace
        self.detected_template: TemplateSettings | None = None
        self._detected_next_marker_explicit = False

    def parse(self, value: str, *, source_row: int = 0) -> ParsedMapping:
        text = str(value)
        error = lambda code, message: AppError(  # noqa: E731
            code, message, source_row=source_row or None
        )
        if text != text.strip() and not self.allow_number_whitespace:
            raise error("INVALID_FORMATTED_ROW", "В готовой строке есть лишние пробелы")
        template = self.template
        if self.auto_detect:
            equals_at = text.find("=")
            if equals_at < 0 or text.find("=", equals_at + 1) >= 0:
                raise error(
                    "INVALID_FORMATTED_ROW",
                    "Готовая строка должна содержать один знак =",
                )
            prefix_end = text.rfind("&", 0, equals_at)
            if prefix_end < 0:
                raise error("INVALID_PREFIX", "Некорректный параметр готовой строки")
            prefix = text[: prefix_end + 1]
            rotation = text[equals_at + 1 :]
            normalized_rotation = (
                rotation[:-1]
                if rotation.endswith(";")
                else rotation
            )
            parts = normalized_rotation.split(";")
            if not parts or any(not part for part in parts):
                raise error(
                    "INVALID_B_NUMBER",
                    "Готовая строка содержит пустой B-номер",
                )
            first_tokens = parts[0].split(",")
            if len(first_tokens) != 3 or any(not token for token in first_tokens):
                raise error("INVALID_FIRST_B", "Некорректный маркер первого B-номера")
            first_marker, weight, _first_b = first_tokens
            next_marker = (
                first_marker.split(":", 1)[0]
                if ":" in first_marker
                else first_marker
            )
            for part in parts[1:]:
                tokens = part.split(",")
                if len(tokens) != 3 or any(not token for token in tokens):
                    raise error(
                        "INVALID_FORMATTED_ROW",
                        "Некорректный разделитель следующего B-номера",
                    )
                marker, next_weight, _b_number = tokens
                if next_weight != weight:
                    raise error(
                        "MIXED_TEMPLATE",
                        "В строке используются разные веса B-номеров",
                    )
                if next_marker != marker and len(parts) > 1:
                    if next_marker == first_marker.split(":", 1)[0]:
                        next_marker = marker
                    else:
                        raise error(
                            "MIXED_TEMPLATE",
                            "В строке используются разные маркеры B-номеров",
                        )
            try:
                row_template = TemplateSettings(
                    prefix=prefix,
                    firstBMarker=first_marker,
                    nextBMarker=next_marker,
                    weight=weight,
                )
            except ValueError as exc:
                raise error(
                    "INVALID_PREFIX",
                    (
                        "PANI должен состоять ровно из 11 цифр"
                        if (
                            PANI_PREFIX_PATTERN.fullmatch(prefix)
                            or PANI_REGION_PREFIX_PATTERN.fullmatch(prefix)
                            or LEGACY_PANI_REGION_PREFIX_PATTERN.fullmatch(prefix)
                        )
                        else "Некорректный параметр готовой строки"
                    ),
                ) from exc
            next_marker_explicit = len(parts) > 1
            if self.detected_template is None:
                self.detected_template = row_template
                self._detected_next_marker_explicit = next_marker_explicit
            else:
                detected = self.detected_template
                if (
                    detected.first_b_marker != row_template.first_b_marker
                    or detected.weight != row_template.weight
                ) and not self.allow_mixed_templates:
                    raise error(
                        "MIXED_TEMPLATE",
                        "Строки файла используют разные параметры шаблона",
                    )
                if next_marker_explicit:
                    if (
                        self._detected_next_marker_explicit
                        and detected.next_b_marker
                        != row_template.next_b_marker
                    ) and not self.allow_mixed_templates:
                        raise error(
                            "MIXED_TEMPLATE",
                            "Строки файла используют разные параметры шаблона",
                        )
                    if not self._detected_next_marker_explicit:
                        self.detected_template = TemplateSettings(
                            prefix=detected.resolved_prefix,
                            firstBMarker=detected.first_b_marker,
                            nextBMarker=row_template.next_b_marker,
                            weight=detected.weight,
                        )
                    self._detected_next_marker_explicit = True
            template = row_template
        resolved_prefix = template.resolved_prefix
        if not text.startswith(resolved_prefix):
            raise error("INVALID_PREFIX", "Некорректный параметр готовой строки")
        payload = text[len(resolved_prefix) :]
        if payload.count("=") != 1:
            raise error("INVALID_FORMATTED_ROW", "Готовая строка должна содержать один знак =")
        raw_a, rotation = payload.split("=", 1)
        if rotation.endswith(";"):
            rotation = rotation[:-1]
        a_number = normalize_number(
            raw_a,
            source_row=source_row,
            field="A",
            allow_whitespace_error=self.allow_number_whitespace,
        )
        if not a_number:
            raise error("INVALID_A_NUMBER", "В готовой строке отсутствует A-номер")
        first_prefix = f"{template.first_b_marker},{template.weight},"
        if not rotation.startswith(first_prefix):
            raise error("INVALID_FIRST_B", "Некорректный маркер первого B-номера")
        b_payload = rotation[len(first_prefix) :]
        next_separator = (
            f";{template.next_b_marker},{template.weight},"
        )
        raw_b_numbers = b_payload.split(next_separator)
        if not raw_b_numbers or any(not value for value in raw_b_numbers):
            raise error("INVALID_B_NUMBER", "Готовая строка содержит пустой B-номер")
        b_numbers = tuple(
            normalize_number(
                raw_b,
                source_row=source_row,
                field="B",
                allow_whitespace_error=self.allow_number_whitespace,
            )
            for raw_b in raw_b_numbers
        )
        if any(not value for value in b_numbers):
            raise error("INVALID_B_NUMBER", "Готовая строка содержит пустой B-номер")
        return ParsedMapping(
            a_number=a_number,
            b_numbers=b_numbers,
            source_prefix=resolved_prefix,
            linked_a_number=linked_a_from_prefix(resolved_prefix),
        )


class MappingSerializer:
    def __init__(
        self,
        csv_settings: CsvSettings | None = None,
        template: TemplateSettings | None = None,
        mapping_formats: Iterable[MappingFormatOverride] = (),
    ):
        self.csv_settings = csv_settings or CsvSettings()
        self.template = template or TemplateSettings()
        self.mapping_prefixes = {
            item.aNumber: item.prefix for item in mapping_formats
        }

    def logical_row(self, mapping: Mapping) -> str:
        if not mapping.bNumbers:
            raise AppError("EMPTY_MAPPING", "Связка без B не может быть сериализована")
        first_b_marker = resolved_first_b_marker(
            mapping.bNumbers,
            self.template.first_b_marker,
        )
        first = (
            f"{first_b_marker},{self.template.weight},"
            f"{mapping.bNumbers[0]}"
        )
        rest = "".join(
            f";{self.template.next_b_marker},{self.template.weight},{b_number}"
            for b_number in mapping.bNumbers[1:]
        )
        prefix = self.mapping_prefixes.get(
            mapping.aNumber,
            mapping.sourcePrefix or self.template.resolved_prefix,
        )
        prefix = canonicalize_pani_region_prefix(prefix)
        return f"{prefix}{mapping.aNumber}={first}{rest}"

    def write(
        self,
        mappings: Iterable[Mapping],
        destination: Path,
        *,
        cancelled: CancelCallback | None = None,
    ) -> tuple[int, int]:
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.tmp")
        encoding = "utf-8-sig" if self.csv_settings.bom else "utf-8"
        line_ending = "\r\n" if self.csv_settings.line_ending == "CRLF" else "\n"
        count = 0
        try:
            with temporary.open("w", encoding=encoding, newline="") as target:
                writer = csv.writer(
                    target,
                    delimiter=self.csv_settings.delimiter,
                    quotechar='"',
                    quoting=csv.QUOTE_MINIMAL,
                    lineterminator=line_ending,
                )
                writer.writerow([HEADER])
                for mapping in mappings:
                    _cancel_if_requested(cancelled)
                    writer.writerow([self.logical_row(mapping)])
                    count += 1
            os.replace(temporary, destination)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
        return count, destination.stat().st_size

    def preview(self, mappings: Iterable[Mapping], limit: int = 20) -> list[str]:
        result: list[str] = [HEADER]
        for mapping in mappings:
            if len(result) > limit:
                break
            result.append(self.logical_row(mapping))
        return result


class AddMappingsService:
    def apply(
        self,
        spool: MappingSpool,
        additions: Iterable[ManualMapping],
        report: ReportWriter,
    ) -> dict[str, int]:
        addition_items = list(additions)
        if not addition_items:
            return {}
        requested_mappings = 0
        requested_b = 0
        added_a = 0
        added_b = 0
        duplicate_b = 0
        for mapping_index, mapping in enumerate(addition_items, start=1):
            a_number = normalize_number(
                mapping.aNumber,
                source_row=mapping_index,
                field="A",
                allow_whitespace_error=True,
            )
            if not a_number:
                raise AppError(
                    "INVALID_A_NUMBER",
                    "В ручной связке отсутствует A-номер",
                    source_row=mapping_index,
                )
            requested_mappings += 1
            a_existed = spool.contains_a(a_number)
            for raw_b in mapping.bNumbers:
                requested_b += 1
                b_number = normalize_number(
                    raw_b,
                    source_row=mapping_index,
                    field="B",
                    allow_whitespace_error=True,
                )
                if not b_number:
                    raise AppError(
                        "INVALID_B_NUMBER",
                        "В ручной связке отсутствует B-номер",
                        source_row=mapping_index,
                    )
                new_a, duplicate = spool.add(
                    a_number,
                    b_number,
                    0,
                    keep_duplicate=False,
                )
                if new_a:
                    added_a += 1
                if duplicate:
                    duplicate_b += 1
                    report.add(
                        code="MANUAL_B_ALREADY_EXISTS",
                        message="Добавляемый B уже присутствует в связке",
                        a_number=a_number,
                        b_number=b_number,
                    )
                else:
                    added_b += 1
            if a_existed and spool.b_count(a_number) > 0:
                report.add(
                    code="MANUAL_A_MERGED",
                    message="Добавленные B объединены с существующей связкой A",
                    a_number=a_number,
                )
        spool.commit()
        return {
            "manualMappings": requested_mappings,
            "manualRequestedB": requested_b,
            "manualAddedA": added_a,
            "manualAddedB": added_b,
            "manualDuplicateB": duplicate_b,
        }


class DeleteAService:
    def apply(
        self,
        spool: MappingSpool,
        commands: Iterable[Any],
        report: ReportWriter,
    ) -> dict[str, int]:
        requested: list[str] = []
        seen: set[str] = set()
        for index, raw in enumerate(commands, start=1):
            number = normalize_number(
                raw,
                source_row=index,
                field="A",
                allow_whitespace_error=True,
            )
            if number and number not in seen:
                seen.add(number)
                requested.append(number)
        deleted = 0
        not_found = 0
        for a_number in requested:
            if not spool.contains_a(a_number):
                not_found += 1
                report.add(
                    code="A_NOT_FOUND",
                    message="A-номер не найден",
                    a_number=a_number,
                )
                continue
            spool.delete_a(a_number)
            deleted += 1
        spool.commit()
        remaining, _ = spool.counts()
        return {
            "requestedA": len(requested),
            "foundA": deleted,
            "deletedRows": deleted,
            "notFoundA": not_found,
            "remainingMappings": remaining,
        }


class DeleteBService:
    def apply(
        self,
        spool: MappingSpool,
        commands: Iterable[tuple[Any, Iterable[Any]]],
        report: ReportWriter,
    ) -> dict[str, int]:
        processed_a = 0
        deleted_b = 0
        missing_b = 0
        deleted_empty_a = 0
        changed_rows = 0
        normalized_commands: dict[str, list[str]] = {}
        for command_index, (raw_a, raw_bs) in enumerate(commands, start=1):
            a_number = normalize_number(
                raw_a,
                source_row=command_index,
                field="A",
                allow_whitespace_error=True,
            )
            bucket = normalized_commands.setdefault(a_number, [])
            already = set(bucket)
            for raw_b in raw_bs:
                b_number = normalize_number(
                    raw_b,
                    source_row=command_index,
                    field="B",
                    allow_whitespace_error=True,
                )
                if b_number not in already:
                    bucket.append(b_number)
                    already.add(b_number)

        for a_number, b_numbers in normalized_commands.items():
            processed_a += 1
            if not spool.contains_a(a_number):
                report.add(
                    code="A_NOT_FOUND",
                    message="A-номер не найден",
                    a_number=a_number,
                )
                missing_b += len(b_numbers)
                continue
            row_changed = False
            for b_number in b_numbers:
                removed = spool.delete_b(a_number, b_number)
                if removed:
                    deleted_b += removed
                    row_changed = True
                else:
                    missing_b += 1
                    report.add(
                        code="B_NOT_FOUND",
                        message="B-номер не найден в указанной связке",
                        a_number=a_number,
                        b_number=b_number,
                    )
            if row_changed:
                changed_rows += 1
            if spool.b_count(a_number) == 0:
                spool.delete_a(a_number)
                deleted_empty_a += 1
                report.add(
                    code="EMPTY_MAPPING_DELETED",
                    message="После удаления последнего АОН связка удалена целиком",
                    a_number=a_number,
                )
        spool.commit()
        return {
            "processedA": processed_a,
            "deletedB": deleted_b,
            "notFoundB": missing_b,
            "deletedEmptyA": deleted_empty_a,
            "changedRows": changed_rows,
        }

    def apply_everywhere(
        self,
        spool: MappingSpool,
        numbers: Iterable[Any],
        report: ReportWriter,
    ) -> dict[str, int]:
        requested: list[str] = []
        seen: set[str] = set()
        for index, raw_number in enumerate(numbers, start=1):
            b_number = normalize_number(
                raw_number,
                source_row=index,
                field="B",
            )
            if b_number and b_number not in seen:
                requested.append(b_number)
                seen.add(b_number)

        deleted_b = 0
        not_found_b = 0
        changed_a: set[str] = set()
        deleted_empty_a = 0
        for b_number in requested:
            affected_a = spool.a_numbers_for_b(b_number)
            if not affected_a:
                not_found_b += 1
                report.add(
                    code="B_NOT_FOUND_GLOBALLY",
                    message="B-номер не найден ни в одной связке A",
                    b_number=b_number,
                )
                continue
            deleted_b += spool.delete_b_everywhere(b_number)
            changed_a.update(affected_a)
            for a_number in affected_a:
                report.add(
                    code="B_REMOVED_GLOBALLY",
                    message="B-номер удалён из найденной связки A",
                    a_number=a_number,
                    b_number=b_number,
                )

        for a_number in sorted(changed_a):
            if spool.contains_a(a_number) and spool.b_count(a_number) == 0:
                spool.delete_a(a_number)
                deleted_empty_a += 1
                report.add(
                    code="EMPTY_MAPPING_DELETED",
                    message="После удаления последнего АОН связка удалена целиком",
                    a_number=a_number,
                )
        spool.commit()
        return {
            "requestedGlobalB": len(requested),
            "deletedGlobalB": deleted_b,
            "notFoundGlobalB": not_found_b,
            "globalChangedA": len(changed_a),
            "globalDeletedEmptyA": deleted_empty_a,
        }
