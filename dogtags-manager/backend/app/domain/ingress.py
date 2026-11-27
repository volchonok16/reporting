"""Strict HUB ingress; data-record ordinals exclude the header and begin at one."""
import csv
from dataclasses import dataclass
from uuid import UUID, uuid5

import pyarrow as pa

from app.domain.csv_limits import ensure_csv_field_capacity
from app.domain.source_inspection import HUB_CONTRACT

HUB_COLUMNS = tuple(HUB_CONTRACT["columns"])
RECORD_SCHEMA = pa.schema([
    ("record_id", pa.string()), ("ordinal", pa.int64()),
    ("line_start", pa.int64()), ("line_end", pa.int64()),
    ("raw_cells", pa.list_(pa.string())), ("effective_cells", pa.list_(pa.string())),
    *[(name, pa.string()) for name in HUB_COLUMNS],
    ("page_index", pa.int64()),
])


def source_record_id(source_id, ordinal):
    if ordinal < 1:
        raise ValueError("Data-record ordinals begin at one.")
    return uuid5(UUID(str(source_id)), f"csv-record:{ordinal}")


def physical_lines(path, encoding):
    """Decode one physical line at a time so a later decode failure cannot erase its prefix."""
    with path.open("rb") as stream:
        pending = bytearray()
        position = 0
        while chunk := stream.read(65536):
            pending.extend(chunk)
            start = 0
            while position < len(pending):
                byte = pending[position]
                if byte not in (10, 13):
                    position += 1
                    continue
                if byte == 13 and position + 1 == len(pending):
                    break  # A CRLF may cross the chunk boundary.
                end = position + 1
                if byte == 13 and pending[end] == 10:
                    end += 1
                yield bytes(pending[start:end]).decode(encoding, errors="strict")
                start = position = end
            del pending[:start]
            position -= start
        if pending:
            yield bytes(pending).decode(encoding, errors="strict")


@dataclass
class SourceRecord:
    record_id: str
    ordinal: int
    line_start: int
    line_end: int
    raw_cells: list[str]
    values: dict[str, str]
    issues: list[dict]
    mapping: dict[str, int] | None = None

    def as_arrow_row(self, effective=None):
        effective = self.values if effective is None else effective
        cells = list(self.raw_cells)
        if self.mapping is not None:
            for field, column in self.mapping.items():
                if column < len(cells):
                    cells[column] = effective[field]
        elif len(cells) == len(HUB_COLUMNS):
            cells = [effective[name] for name in HUB_COLUMNS]
        return {"record_id": self.record_id, "ordinal": self.ordinal, "line_start": self.line_start,
                "line_end": self.line_end, "raw_cells": self.raw_cells, "effective_cells": cells,
                **effective, "page_index": self.ordinal}


class ParsedSource:
    def __init__(self, path, encoding, source_id):
        if encoding not in HUB_CONTRACT["encodings"]:
            raise ValueError("An explicit supported encoding is required.")
        self.path, self.encoding, self.source_id = path, encoding, source_id
        self.summary = {}

    def records(self):
        self.summary = {"columns": None, "schema_supported": False, "parsed_records": 0,
                        "records_count": None, "unknown_remainder": False, "file_errors": []}
        # A single field may occupy the entire accepted upload; never truncate it.
        ensure_csv_field_capacity(self.path.stat().st_size)
        reader = csv.reader(physical_lines(self.path, self.encoding), delimiter=";", strict=True)
        line_start = 1
        try:
            header = next(reader, None)
            self.summary["columns"] = header
            supported = header == list(HUB_COLUMNS)
            self.summary["schema_supported"] = supported
            if not supported:
                self.summary["file_errors"].append({"code": "unsupported_schema", "field": "",
                    "message": "Колонки не соответствуют HUB v1; исходные ячейки сохранены.",
                    "line_start": 1, "line_end": reader.line_num})
            ordinal = 0
            while True:
                line_start = reader.line_num + 1
                cells = next(reader, None)
                if cells is None:
                    break
                ordinal += 1
                issues = []
                if len(cells) != len(HUB_COLUMNS):
                    issues.append({"field": "", "code": "row_shape",
                                   "message": "Число ячеек отличается от заголовка; все ячейки сохранены."})
                if not supported:
                    issues.append({"field": "", "code": "unsupported_schema",
                                   "message": "Схема источника требует явного разбора."})
                values = {name: cells[i] if supported and i < len(cells) else ""
                          for i, name in enumerate(HUB_COLUMNS)}
                self.summary["parsed_records"] = ordinal
                yield SourceRecord(str(source_record_id(self.source_id, ordinal)), ordinal, line_start,
                                   reader.line_num, cells, values, issues)
            self.summary["records_count"] = ordinal
            if not ordinal:
                self.summary["file_errors"].append({"field": "", "code": "source_empty",
                    "message": "В источнике нет записей; пустой комплект не допускается.",
                    "line_start": line_start, "line_end": reader.line_num})
        except (UnicodeError, csv.Error) as error:
            self.summary["unknown_remainder"] = True
            self.summary["file_errors"].append({"field": "", "code": (
                "source_encoding_error" if isinstance(error, UnicodeError) else "source_csv_syntax_error"),
                "message": "Разбор файла прерван; число записей в остатке неизвестно.",
                "line_start": line_start, "line_end": reader.line_num or None})


def parse_source(path, encoding, source_id):
    return ParsedSource(path, encoding, source_id)
