"""Metadata inspection only. Canonical rows and validation belong to U4."""
import csv
import json
from pathlib import Path

from app.domain.csv_limits import ensure_csv_field_capacity

CONTRACT_ROOT = Path(__file__).resolve().parents[3] / "contracts"
HUB_CONTRACT = json.loads((CONTRACT_ROOT / "hub-v1.json").read_text())


def inspect_source(path, encoding, max_bytes):
    ensure_csv_field_capacity(max_bytes)
    columns, records = None, 0
    try:
        with path.open("r", encoding=encoding, errors="strict", newline="") as stream:
            reader = csv.reader(stream, delimiter=";", strict=True)
            columns = next(reader, None)
            for row in reader:
                records += 1
        errors = []
        if columns != HUB_CONTRACT["columns"]:
            errors.append({"code": "unsupported_schema", "message": "Колонки не соответствуют HUB v1."})
        return {"columns": columns, "records_count": records, "errors": errors,
                "schema_supported": not errors, "contract_version": HUB_CONTRACT["version"]}
    except UnicodeError:
        code, message = "source_encoding_error", "Файл не читается в выбранной кодировке."
    except csv.Error:
        code, message = "source_csv_syntax_error", "Синтаксис CSV повреждён; количество записей неизвестно."
    return {"columns": columns, "records_count": None, "schema_supported": False,
            "contract_version": HUB_CONTRACT["version"], "errors": [{"code": code, "message": message}]}
