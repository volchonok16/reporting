from __future__ import annotations

import csv
import io
import math
import os
import re
import stat
import zipfile
from pathlib import Path
from typing import Any

from .config import Settings
from .errors import AppError


ZIP_MAGIC = b"PK\x03\x04"
OLE_MAGIC = bytes.fromhex("D0CF11E0A1B11AE1")
SUPPORTED_EXTENSIONS = {".csv": "csv", ".xlsx": "xlsx", ".xls": "xls", ".xlsb": "xlsb"}
NUMBER_RE = re.compile(r"^\+?[0-9]+$")


def safe_display_name(filename: str | None) -> str:
    value = os.path.basename((filename or "upload").replace("\\", "/")).strip()
    value = "".join(char for char in value if char >= " " and char != "\x7f")
    return value[:255] or "upload"


def validate_session_id(value: str | None) -> str:
    if value is None or not value.strip():
        raise AppError(
            "MISSING_SESSION_ID",
            "Заголовок X-Session-ID обязателен",
            status_code=400,
        )
    result = value.strip()
    if len(result) > 128 or any(ord(char) < 33 or ord(char) == 127 for char in result):
        raise AppError(
            "INVALID_SESSION_ID",
            "Некорректный X-Session-ID",
            status_code=400,
        )
    return result


def mask_number(value: Any) -> str:
    text = str(value or "").strip()
    sign = "+" if text.startswith("+") else ""
    digits = "".join(char for char in text if char.isdigit())
    if not digits:
        return "***"
    if len(digits) <= 4:
        return f"{sign}{'*' * len(digits)}"
    return f"{sign}{digits[:2]}{'*' * min(8, len(digits) - 4)}{digits[-2:]}"


def csv_injection_safe(value: Any) -> str:
    text = "" if value is None else str(value)
    if text.startswith(("=", "+", "-", "@")):
        return "'" + text
    return text


def normalize_number(
    value: Any,
    *,
    source_row: int,
    field: str,
    require_seven: bool = False,
    allow_whitespace_error: bool = False,
) -> str:
    code = f"INVALID_{field}_NUMBER"
    if value is None:
        return ""
    if isinstance(value, bool):
        raise AppError(code, f"В строке {source_row} некорректный {field}-номер", source_row=source_row)
    if isinstance(value, int):
        text = str(value)
    elif isinstance(value, float):
        if not math.isfinite(value) or value < 0 or not value.is_integer():
            raise AppError(code, f"В строке {source_row} некорректный {field}-номер", source_row=source_row)
        text = format(value, ".0f")
    else:
        text = str(value)
    if not text.strip():
        return ""
    if any(char.isspace() for char in text):
        compact = "".join(char for char in text if not char.isspace())
        if allow_whitespace_error and NUMBER_RE.fullmatch(compact):
            return text
        number_kind = "опорном номере" if field == "A" else "АОН"
        raise AppError(
            f"INVALID_{field}_NUMBER_WHITESPACE",
            (
                f"В строке {source_row} в {number_kind} обнаружены пробелы. "
                "Номер не должен содержать пробелы"
            ),
            source_row=source_row,
        )
    if text.startswith("="):
        raise AppError(
            "FORMULA_CELL",
            f"В строке {source_row} формула не может использоваться как {field}-номер",
            source_row=source_row,
        )
    if not NUMBER_RE.fullmatch(text):
        raise AppError(code, f"В строке {source_row} некорректный {field}-номер", source_row=source_row)
    normalized = text.removeprefix("+")
    if require_seven and not normalized.startswith("7"):
        number_kind = "Опорный номер" if field == "A" else "АОН"
        raise AppError(
            f"INVALID_{field}_NUMBER_START",
            (
                f"В строке {source_row} {number_kind.lower()} {normalized} "
                "должен начинаться с 7"
            ),
            source_row=source_row,
        )
    return text


def _validate_archive(path: Path, settings: Settings) -> str:
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            if not infos or len(infos) > settings.max_archive_members:
                raise AppError("UNSAFE_ARCHIVE", "Недопустимое число файлов в книге")
            total_uncompressed = 0
            total_compressed = 0
            names: set[str] = set()
            for info in infos:
                normalized = info.filename.replace("\\", "/")
                if (
                    normalized.startswith("/")
                    or normalized.startswith("../")
                    or "/../" in normalized
                    or "\x00" in normalized
                ):
                    raise AppError("UNSAFE_ARCHIVE", "Небезопасная структура книги")
                unix_mode = info.external_attr >> 16
                if unix_mode and stat.S_ISLNK(unix_mode):
                    raise AppError("UNSAFE_ARCHIVE", "Символические ссылки в книге запрещены")
                if info.flag_bits & 0x1:
                    raise AppError("ENCRYPTED_FILE", "Зашифрованные книги не поддерживаются")
                total_uncompressed += info.file_size
                total_compressed += info.compress_size
                if total_uncompressed > settings.max_uncompressed_bytes:
                    raise AppError("ZIP_BOMB", "Распакованный размер книги превышает лимит")
                if info.file_size > 0 and info.compress_size == 0:
                    raise AppError("ZIP_BOMB", "Недопустимый коэффициент сжатия книги")
                if (
                    info.compress_size > 0
                    and info.file_size / info.compress_size > settings.max_compression_ratio
                ):
                    raise AppError("ZIP_BOMB", "Недопустимый коэффициент сжатия книги")
                names.add(normalized)
            if (
                total_compressed > 0
                and total_uncompressed / total_compressed > settings.max_compression_ratio
            ):
                raise AppError("ZIP_BOMB", "Недопустимый коэффициент сжатия книги")
            if "xl/workbook.bin" in names:
                return "xlsb"
            if "xl/workbook.xml" in names:
                return "xlsx"
    except AppError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        raise AppError("CORRUPT_FILE", "Книга повреждена или имеет неверный формат") from exc
    raise AppError("UNSUPPORTED_FILE", "ZIP-файл не является поддерживаемой книгой Excel")


def _validate_csv(path: Path) -> None:
    sample = path.read_bytes()[:256 * 1024]
    if not sample:
        raise AppError("EMPTY_FILE", "Файл пуст")
    if b"\x00" in sample:
        raise AppError("UNSUPPORTED_FILE", "Бинарный файл не является CSV")
    decoded: str | None = None
    for encoding in ("utf-8-sig", "utf-8", "cp1251"):
        try:
            decoded = sample.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if decoded is None:
        raise AppError("INVALID_ENCODING", "CSV должен быть в UTF-8 или Windows-1251")
    try:
        next(csv.reader(io.StringIO(decoded)))
    except (csv.Error, StopIteration) as exc:
        raise AppError("CORRUPT_FILE", "CSV поврежден или пуст") from exc


def detect_file_format(path: Path, original_name: str, settings: Settings) -> str:
    with path.open("rb") as source:
        magic = source.read(8)
    if magic.startswith(ZIP_MAGIC):
        detected = _validate_archive(path, settings)
    elif magic.startswith(OLE_MAGIC):
        detected = "xls"
        try:
            import xlrd

            # Validate from bytes because private uploads intentionally have
            # extensionless opaque paths and some BIFF workbooks are rejected
            # by xlrd's filename-oriented path branch.
            workbook = xlrd.open_workbook(
                file_contents=path.read_bytes(), on_demand=True
            )
            if not workbook.sheet_names():
                raise AppError("EMPTY_FILE", "Книга не содержит листов")
            workbook.release_resources()
        except AppError:
            raise
        except Exception as exc:
            raise AppError("CORRUPT_FILE", "Файл XLS поврежден или не поддерживается") from exc
    else:
        _validate_csv(path)
        detected = "csv"

    extension = Path(original_name).suffix.lower()
    expected = SUPPORTED_EXTENSIONS.get(extension)
    if expected is None:
        raise AppError(
            "UNSUPPORTED_EXTENSION",
            "Поддерживаются только XLSX, XLS, XLSB и CSV",
        )
    if expected != detected:
        raise AppError(
            "FORMAT_MISMATCH",
            "Расширение файла не соответствует его содержимому",
        )
    return detected
