"""Versioned, strict CSV roundtrip and reproducible three-member ZIP packaging."""
import csv
from codecs import BOM_UTF8
import hashlib
import io
import os
from dataclasses import dataclass
from itertools import zip_longest
from pathlib import Path
from zipfile import ZIP_STORED, BadZipFile, ZipFile, ZipInfo

from app.domain.canonical import file_digest
from app.domain.csv_limits import ensure_csv_field_capacity
from app.domain.ingress import source_record_id
from app.domain.projections import projection_entries, projection_rows
from app.domain.output_spec import dataset_file_definition, output_spec

PACKING_VERSION = "zip-stored-fixed-v1"
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
ZIP_ATTRIBUTES = 0o100644 << 16


class SerializationFailure(Exception):
    def __init__(self, diagnostics):
        self.diagnostics = diagnostics
        super().__init__("Output bytes cannot be released exactly; review the addressed field.")


@dataclass(frozen=True)
class SerializedFile:
    path: Path
    role: str
    download_filename: str
    sha256: str
    size_bytes: int
    row_count: int | None = None


def csv_bytes(values, encoding='cp1251'):
    stream = io.StringIO(newline="")
    csv.writer(stream, delimiter=";", lineterminator="\r\n").writerow(values)
    return stream.getvalue().encode(encoding, errors="strict")


def csv_header_bytes(definition):
    encoding = definition.get('encoding', 'cp1251')
    return (BOM_UTF8 if definition.get('utf8_bom') and encoding == 'utf-8' else b'') + csv_bytes(
        definition['columns'], encoding)


def csv_read_encoding(definition):
    encoding = definition.get('encoding', 'cp1251')
    return 'utf-8-sig' if definition.get('utf8_bom') and encoding == 'utf-8' else encoding


def encoding_check(dataset, role, values, row_number, ordinal):
    encoding = dataset_file_definition(dataset, role).get('encoding', 'cp1251')
    for field, value in zip(dataset_file_definition(dataset, role)["columns"], values, strict=True):
        try:
            value.encode(encoding, errors="strict")
        except UnicodeEncodeError:
            setting = field in {"SPREADING", "INTERNAL_OPERATOR_NAME", "COMPANY_NAME",
                                "COMPANY_CONTRACT", "MAV_OPERATOR_NAME"}
            diagnostic = {"code": "output_encoding_error", "role": role, "row": row_number,
                          "field": "MAV_LABEL_NAME" if field == "MAV_LABEL" else field,
                          "scope": "revision_setting" if setting else "source_cell"}
            if not setting:
                record_id = str(source_record_id(dataset.summary["source_asset_id"], ordinal))
                if dataset.summary["dataset_version"] != "hub-canonical-v1":
                    record_id = dataset.page("records", after=ordinal - 1, limit=1)["items"][0]["record_id"]
                diagnostic.update(ordinal=ordinal, record_id=record_id)
            raise SerializationFailure([diagnostic]) from None


def write_csv(dataset, role, path):
    path = Path(path)
    digest, size, count = hashlib.sha256(), 0, 0
    encoding = dataset_file_definition(dataset, role).get('encoding', 'cp1251')
    with path.open("xb") as stream:
        header = csv_header_bytes(dataset_file_definition(dataset, role))
        stream.write(header)
        digest.update(header)
        size += len(header)
        for count, (values, ordinal) in enumerate(projection_entries(dataset, role), start=1):
            encoding_check(dataset, role, values, count, ordinal)
            encoded = csv_bytes(values, encoding)
            stream.write(encoded)
            digest.update(encoded)
            size += len(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    result = SerializedFile(path, role, path.name, digest.hexdigest(), size, count)
    verify_csv(dataset, result)
    return result


def verify_csv(dataset, obj):
    """Compare rows to the independent snapshot and bytes to its canonical encoding."""
    try:
        ensure_csv_field_capacity(obj.size_bytes)
        definition = dataset_file_definition(dataset, obj.role)
        expected_header = definition['columns']
        encoding = definition.get('encoding', 'cp1251')
        digest, size, count = hashlib.sha256(), 0, 0
        encoded = csv_header_bytes(definition)
        digest.update(encoded)
        size += len(encoded)
        with obj.path.open("r", encoding=csv_read_encoding(definition), errors="strict", newline="") as stream:
            reader = csv.reader(stream, delimiter=";", strict=True)
            if next(reader, None) != expected_header:
                raise ValueError()
            for count, (expected, actual) in enumerate(zip_longest(projection_rows(dataset, obj.role), reader), 1):
                if expected != actual:
                    raise ValueError()
                encoded = csv_bytes(expected, encoding)
                digest.update(encoded)
                size += len(encoded)
        actual_hash, actual_size = file_digest(obj.path)
        if (actual_hash != digest.hexdigest() or actual_hash != obj.sha256 or size != actual_size
                or actual_size != obj.size_bytes or count != obj.row_count):
            raise ValueError()
    except (OSError, UnicodeError, csv.Error, ValueError):
        raise SerializationFailure([{"code": "output_roundtrip_error", "role": obj.role}]) from None


def write_zip(files, path, *, operation='ADD', spec=None):
    if tuple(obj.role for obj in files) != tuple((spec or output_spec(operation))['archive_roles']):
        raise ValueError("The ZIP requires the operation’s exact ordered CSVs.")
    path = Path(path)
    with ZipFile(path, "x", compression=ZIP_STORED, allowZip64=True) as archive:
        for obj in files:
            info = ZipInfo(obj.download_filename, date_time=ZIP_TIME)
            info.create_system, info.external_attr = 3, ZIP_ATTRIBUTES
            info.compress_type, info.create_version, info.extract_version = ZIP_STORED, 20, 20
            info.file_size = obj.size_bytes
            with obj.path.open("rb") as source, archive.open(info, "w") as target:
                while chunk := source.read(65536):
                    target.write(chunk)
    with path.open("rb") as stream:
        os.fsync(stream.fileno())
    verify_zip(files, path)
    digest, size = file_digest(path)
    return SerializedFile(path, "ZIP", path.name, digest, size)


def verify_zip(files, path):
    try:
        with ZipFile(path) as archive:
            if archive.namelist() != [obj.download_filename for obj in files] or archive.comment:
                raise ValueError()
            for obj, info in zip(files, archive.infolist(), strict=True):
                if (info.date_time != ZIP_TIME or info.compress_type != ZIP_STORED or info.create_system != 3
                        or info.external_attr != ZIP_ATTRIBUTES or info.file_size != obj.size_bytes
                        or info.comment):
                    raise ValueError()
                digest, size = hashlib.sha256(), 0
                with archive.open(info) as stream:
                    while chunk := stream.read(65536):
                        digest.update(chunk)
                        size += len(chunk)
                if digest.hexdigest() != obj.sha256 or size != obj.size_bytes:
                    raise ValueError()
    except (OSError, ValueError, BadZipFile):
        raise SerializationFailure([{"code": "zip_roundtrip_error", "role": "ZIP"}]) from None
