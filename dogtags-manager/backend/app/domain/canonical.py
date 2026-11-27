"""Worker-callable disk pipeline. HTTP handlers never run global validation here."""
import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from app.domain.corrections import effective_values, overlay_index
from app.domain.ingress import HUB_COLUMNS, RECORD_SCHEMA, parse_source
from app.domain.reconciliation import reconcile
from app.domain.row_selections import excluded_records, install_exclusions, verify_selection
from app.domain.validation import validate_record
from app.domain.rules import Normalizer, profile_for, operator_value
from app.storage.local import StagedObject, StorageFailure
from app.storage.pages import publish_pages

DATASET_VERSION = "hub-canonical-v1"
ROLES = {"raw": "raw", "effective": "effective", "records": "records", "issues": "issues",
         "lineage": "lineage", "CLIENTS": "clients", "DOGTAGS": "dogtags", "NUMBERS": "numbers"}
NORMALIZATION_SCHEMA = pa.schema([('record_id', pa.string()), ('ordinal', pa.int64()),
                                  ('page_index', pa.int64()), ('field', pa.string()),
                                  ('before', pa.string()), ('after', pa.string()), ('rule_id', pa.string()),
                                  ('rule_version', pa.string()), ('rule_digest', pa.string())])
ISSUE_SCHEMA = pa.schema([("record_id", pa.string()), ("ordinal", pa.int64()), ("field", pa.string()),
                         ("code", pa.string()), ("message", pa.string()), ("scope", pa.string())])


def connection(path=":memory:", *, memory_limit="1GiB", threads=1, temp_directory=None):
    options = {"memory_limit": memory_limit, "threads": str(threads)}
    if temp_directory:
        options["temp_directory"] = str(temp_directory)
    return duckdb.connect(str(path), config=options)


def sql_path(path):
    return "'" + str(path).replace("'", "''") + "'"


def write_rows(writer, rows, schema):
    if rows:
        writer.write_table(pa.Table.from_pylist(rows, schema=schema))


def add_assignment_flag_warnings(db, candidates='candidates'):
    db.execute(f"""INSERT INTO issues SELECT e.record_id,e.ordinal,'MSISDN','assignment_key_conflict',
        'В строках с одинаковыми ИНН и номером различаются флаги IS_MAV или IS_KSS. Проверьте назначения; выгрузка разрешена.',
        'warning' FROM {candidates} e JOIN
        (SELECT INN,MSISDN FROM {candidates} GROUP BY INN,MSISDN
         HAVING count(DISTINCT (IS_MAV,IS_KSS)) > 1) c USING (INN,MSISDN)""")


def profile_values(profile, settings):
    snapshot = settings.get('rules_snapshot')
    if settings.get('operation') == 'WHITEMAV':
        from app.domain.whitemav import PROFILE
        if profile != PROFILE or settings.get('profile_overrides'):
            raise ValueError('WhiteMAV requires its fixed profile.')
        return {k: PROFILE[k] for k in ('SPREADING', 'INTERNAL_OPERATOR_NAME')}
    if snapshot:
        if profile != profile_for(snapshot, profile.get('partner')):
            raise ValueError('Profile differs from its pinned published rules.')
    elif profile.get('id') != 'hub-v1':
        raise ValueError('A versioned profile requires its pinned rules snapshot.')
    overrides = settings.get("profile_overrides", {})
    values = {field: overrides.get(field, {}).get("after", profile.get(field, ""))
              for field in ("SPREADING", "INTERNAL_OPERATOR_NAME")}
    if (values["SPREADING"] not in ("0", "1")
            or not isinstance(values["INTERNAL_OPERATOR_NAME"], str)):
        raise ValueError("A valid HUB profile snapshot is required.")
    values["INTERNAL_OPERATOR_NAME"] = operator_value(values["INTERNAL_OPERATOR_NAME"])
    return values


@dataclass
class CanonicalDataset:
    directory: Path
    summary: dict
    memory_limit: str = "1GiB"
    threads: int = 1

    @property
    def roles(self):
        return dataset_roles(self.summary['dataset_version'])

    def page(self, role, *, after=0, limit=50, record_id=None):
        if role not in self.roles or not 1 <= limit <= 500 or after < 0:
            raise ValueError("Unsupported dataset page.")
        path = self.directory / f"{self.roles[role]}.parquet"
        return parquet_page(path, role, after=after, limit=limit, record_id=record_id,
                            memory_limit=self.memory_limit, threads=self.threads,
                            record_fields=tuple(self.summary.get('record_fields') or
                                (('MSISDN',) if self.summary.get('operation') == 'DELETE' else HUB_COLUMNS)))

    def batches(self, role, batch_size=1000):
        if role not in self.roles:
            raise ValueError("Unknown dataset role.")
        yield from pq.ParquetFile(self.directory / f"{self.roles[role]}.parquet").iter_batches(batch_size=batch_size)


def parquet_page(path, role, *, after=0, limit=50, record_id=None, memory_limit="1GiB", threads=1, record_fields=HUB_COLUMNS):
    with connection(memory_limit=memory_limit, threads=threads) as db:
        db.read_parquet(str(path)).create_view("paged")
        # page_index is immutable and independent of field edits; projections retain source order.
        where, arguments = "page_index > ?", [after]
        if record_id:
            if role not in {"records", "issues", "lineage", "raw", "effective"}:
                raise ValueError("Record scoping is unavailable for this projection.")
            where += " AND record_id = ?"
            arguments.append(record_id)
        rows = db.execute(f"SELECT * FROM paged WHERE {where} ORDER BY page_index LIMIT ?",
                          [*arguments, limit + 1]).to_arrow_table().to_pylist()
    items = rows[:limit]
    for row in items:
        if role == "records":
            row["effective"] = {field: row.pop(field) for field in record_fields}
        row.pop("effective_cells", None)
    return {"items": items, "next_cursor": items[-1]["page_index"] if len(rows) > limit else None}


def build_dataset(path, encoding, source_asset_id, output_directory, profile_snapshot, *, settings=None,
                  correction_overlay=None, chunk_rows=1000, memory_limit="1GiB", threads=1, parsed_source=None, active_ordinals=None):
    """Create one attempt's immutable Parquet details, all dispositions and coverage.

    Returns checks, never PREPARED: U5 serialization and U6 fenced publication still have to succeed.
    """
    if chunk_rows < 1 or threads < 1:
        raise ValueError("Positive chunk/thread settings are required.")
    directory = Path(output_directory)
    directory.mkdir(parents=True, exist_ok=False)
    settings, correction_overlay = settings or {}, correction_overlay or []
    from app.domain.output_spec import source_separation
    separate_errors = source_separation(settings)
    profile = profile_values(profile_snapshot, settings)
    parsed = parsed_source or parse_source(Path(path), encoding, source_asset_id)
    excluded = excluded_records(settings, source_asset_id, parsed)
    seen_exclusions = set()
    indexed = overlay_index(correction_overlay, source_asset_id,
                            mapping_digest=getattr(parsed, 'mapping_digest', None))
    raw_rows, effective_rows, issue_rows = [], [], []
    snapshot = settings.get('rules_snapshot')
    normalizer = Normalizer(snapshot, settings.get('partner_flags')) if snapshot else None
    normalization_rows, normalization_count = [], 0
    normalization_writer = pq.ParquetWriter(directory / 'normalizations.parquet', NORMALIZATION_SCHEMA)
    seen_corrections = set()
    with (pq.ParquetWriter(directory / "raw.parquet", RECORD_SCHEMA) as raw_writer,
          pq.ParquetWriter(directory / "effective.parquet", RECORD_SCHEMA) as effective_writer,
          pq.ParquetWriter(directory / "issues.parquet", ISSUE_SCHEMA) as issue_writer,
          normalization_writer as rule_writer):
        for record in parsed.records():
            verify_selection(record, excluded, seen_exclusions)
            changes = indexed.get(record.ordinal, [])
            if changes:
                if any(not issue.get('field') for issue in record.issues):
                    raise ValueError("Cell corrections cannot repair a source schema or row shape.")
                seen_corrections.add(record.ordinal)
            automatic_changes = []
            effective = effective_values(record, changes, normalizer=normalizer, bulk_steps=indexed.bulk_steps,
                                         normalization_log=automatic_changes)
            corrected_fields = {change['field'] for change in changes} | set(settings.get('partner_flags', {})) | indexed.bulk_label_fields
            remaining_issues = [issue for issue in record.issues if issue.get('field') not in corrected_fields]
            applied = normalizer.apply(record.values)[1] if normalizer else []
            for change in [*applied, *automatic_changes]:
                normalization_count += 1
                normalization_rows.append({'record_id': record.record_id, 'ordinal': record.ordinal,
                                           'page_index': normalization_count, **change})
            raw_rows.append(record.as_arrow_row())
            effective_rows.append(record.as_arrow_row(effective))
            for issue in [*remaining_issues, *validate_record(effective)]:
                issue_rows.append({"record_id": record.record_id, "ordinal": record.ordinal,
                                   "scope": "cell", **issue})
            if separate_errors:
                for field, value in effective.items():
                    try:
                        value.encode('cp1251', errors='strict')
                    except UnicodeEncodeError:
                        issue_rows.append({'record_id': record.record_id, 'ordinal': record.ordinal,
                            'scope': 'cell', 'field': field, 'code': 'output_encoding_error',
                            'message': 'Значение не представимо в Windows-1251; исходные символы сохранены в файле ошибок.'})
            if len(raw_rows) >= chunk_rows:
                write_rows(raw_writer, raw_rows, RECORD_SCHEMA)
                write_rows(effective_writer, effective_rows, RECORD_SCHEMA)
                write_rows(issue_writer, issue_rows, ISSUE_SCHEMA)
                raw_rows, effective_rows, issue_rows = [], [], []
                if rule_writer:
                    write_rows(rule_writer, normalization_rows, NORMALIZATION_SCHEMA)
                    normalization_rows = []
        if rule_writer:
            write_rows(rule_writer, normalization_rows, NORMALIZATION_SCHEMA)
        write_rows(raw_writer, raw_rows, RECORD_SCHEMA)
        write_rows(effective_writer, effective_rows, RECORD_SCHEMA)
        write_rows(issue_writer, issue_rows, ISSUE_SCHEMA)
    if seen_corrections != set(indexed):
        raise ValueError("Correction points to a source record that was not parsed.")
    if seen_exclusions != set(excluded):
        raise ValueError('Excluded row was not parsed.')
    work_path = directory / "work.duckdb"
    with connection(work_path, memory_limit=memory_limit, threads=threads,
                    temp_directory=directory / ".spill") as db:
        install_exclusions(db, excluded)
        db.execute("CREATE TABLE effective AS SELECT * FROM read_parquet(?)", [str(directory / "effective.parquet")])
        db.execute("ALTER TABLE effective ADD COLUMN SPREADING VARCHAR")
        db.execute("ALTER TABLE effective ADD COLUMN INTERNAL_OPERATOR_NAME VARCHAR")
        db.execute("UPDATE effective SET SPREADING=?, INTERNAL_OPERATOR_NAME=?",
                   [profile["SPREADING"], profile["INTERNAL_OPERATOR_NAME"]])
        db.execute("CREATE TABLE issues AS SELECT * FROM read_parquet(?)", [str(directory / "issues.parquet")])
        if active_ordinals is not None:
            db.read_parquet(str(active_ordinals)).create_view('retry_eligible')
            db.execute('ALTER TABLE effective RENAME TO all_effective')
            db.execute('CREATE TABLE effective AS SELECT * FROM all_effective WHERE ordinal IN '
                       '(SELECT page_index FROM retry_eligible)')
            db.execute('DELETE FROM issues WHERE ordinal NOT IN (SELECT page_index FROM retry_eligible)')
        # Scientific-text INN excludes the whole row.
        # Structural damage still blocks; excluded rows cannot conflict with valid assignments.
        db.execute("""CREATE TABLE scientific_exclusions AS SELECT DISTINCT record_id FROM issues i
            WHERE code='inn_scientific' AND NOT EXISTS
            (SELECT 1 FROM issues structural WHERE structural.record_id=i.record_id AND structural.field='')""")
        candidate_guard = (' AND record_id NOT IN (SELECT record_id FROM issues)' if separate_errors else '')
        candidate_kind = 'TABLE' if separate_errors else 'VIEW'
        db.execute(f"""CREATE {candidate_kind} candidates AS SELECT * FROM effective
            WHERE record_id NOT IN (SELECT record_id FROM scientific_exclusions)
            AND ordinal NOT IN (SELECT ordinal FROM manual_exclusions)""" + candidate_guard)
        global_rules = [
            ("msisdn_assignment_conflict", "MSISDN", "Один MSISDN назначен разным ИНН; требуется решение.",
             "MSISDN", "count(DISTINCT INN) > 1"),
        ]
        for code, field, message, keys, having in global_rules:
            db.execute(f"""INSERT INTO issues SELECT e.record_id,e.ordinal,?,?,?,'global' FROM candidates e
                JOIN (SELECT {keys} FROM candidates GROUP BY {keys} HAVING {having}) c USING ({keys})""",
                       [field, code, message])
        eligible_partition = ',record_id IN (SELECT record_id FROM issues)' if separate_errors else ''
        db.execute(f"""CREATE TABLE grouped AS SELECT *,
            min(ordinal) OVER (PARTITION BY INN,MAV_LABEL_NAME,MAV_LABEL_LATIN,MSISDN,IS_MAV,IS_KSS,
                SPREADING,INTERNAL_OPERATOR_NAME,ordinal IN (SELECT ordinal FROM manual_exclusions){eligible_partition}) AS representative_ordinal,
            min(ordinal) OVER (PARTITION BY effective_cells,ordinal IN (SELECT ordinal FROM manual_exclusions)) AS raw_representative_ordinal
            FROM effective""")
        db.execute("""CREATE TABLE records AS SELECT g.* EXCLUDE (raw_representative_ordinal,page_index),
            g.ordinal AS page_index,
            CASE WHEN g.ordinal IN (SELECT ordinal FROM manual_exclusions) THEN 'excluded_manual'
                WHEN g.record_id IN (SELECT record_id FROM scientific_exclusions) THEN 'excluded_scientific_inn'
                WHEN EXISTS (SELECT 1 FROM issues i WHERE i.record_id=g.record_id AND i.scope='global')
                THEN 'conflict'
                WHEN EXISTS (SELECT 1 FROM issues i WHERE i.record_id=g.record_id) THEN 'excluded_error'
                WHEN g.ordinal <> g.representative_ordinal THEN 'exact_duplicate' ELSE 'included' END AS disposition,
            CASE WHEN g.ordinal <> g.representative_ordinal THEN
                CASE WHEN g.ordinal <> g.raw_representative_ordinal THEN 'raw_exact' ELSE 'numbers_exact' END
                ELSE '' END AS duplicate_kind,
            r.record_id AS representative_id
            FROM grouped g JOIN effective r ON r.ordinal=g.representative_ordinal""")
        if active_ordinals is not None:
            db.execute("""INSERT INTO records BY NAME SELECT *,ordinal AS representative_ordinal,
                'agreed_skip' AS disposition,'' AS duplicate_kind,record_id AS representative_id
                FROM all_effective WHERE ordinal NOT IN (SELECT page_index FROM retry_eligible)""")
        db.execute("""CREATE TABLE clients AS SELECT ''::VARCHAR AS COMPANY_NAME,''::VARCHAR AS COMPANY_CONTRACT,
            ''::VARCHAR AS MAV_OPERATOR_NAME,INN,min(ordinal) AS page_index FROM records
            WHERE disposition='included' GROUP BY INN""")
        db.execute("""CREATE TABLE dogtags AS SELECT INN,MAV_LABEL_NAME AS MAV_LABEL,MAV_LABEL_LATIN,
            '1'::VARCHAR AS IS_ACTIVE,min(ordinal) AS page_index FROM records
            WHERE disposition='included' GROUP BY INN,MAV_LABEL_NAME,MAV_LABEL_LATIN""")
        db.execute("""CREATE TABLE numbers AS SELECT INN,MAV_LABEL_NAME,MSISDN,IS_MAV,IS_KSS,
            SPREADING,INTERNAL_OPERATOR_NAME,min(ordinal) AS page_index FROM records WHERE disposition='included'
            GROUP BY INN,MAV_LABEL_NAME,MSISDN,IS_MAV,IS_KSS,SPREADING,INTERNAL_OPERATOR_NAME""")
        db.execute("""CREATE TABLE lineage AS SELECT r.record_id,r.ordinal AS page_index,r.ordinal,r.representative_id,
            r.disposition,r.duplicate_kind,CASE WHEN r.disposition IN ('included','exact_duplicate') THEN r.INN
            ELSE '' END AS client_inn,CASE WHEN r.disposition IN ('included','exact_duplicate') THEN r.INN
            ELSE '' END AS dogtag_inn,CASE WHEN r.disposition IN ('included','exact_duplicate') THEN source.record_id
            ELSE '' END AS number_record_id FROM records r LEFT JOIN numbers n ON
                (r.INN,r.MAV_LABEL_NAME,r.MSISDN,r.IS_MAV,r.IS_KSS,r.SPREADING,r.INTERNAL_OPERATOR_NAME)=
                (n.INN,n.MAV_LABEL_NAME,n.MSISDN,n.IS_MAV,n.IS_KSS,n.SPREADING,n.INTERNAL_OPERATOR_NAME)
            LEFT JOIN effective source ON source.ordinal=n.page_index""")
        from app.domain.label_warnings import add_label_case_warnings, add_label_latin_warnings
        add_label_case_warnings(db)
        add_label_latin_warnings(db)
        add_assignment_flag_warnings(db)
        from app.domain.msisdn_warnings import add_msisdn_cleanup_warnings
        add_msisdn_cleanup_warnings(db, directory, indexed)
        db.execute("ALTER TABLE issues ADD COLUMN page_index BIGINT")
        db.execute("""UPDATE issues SET page_index=ordered.idx FROM (SELECT rowid,
            row_number() OVER (ORDER BY ordinal,scope,field,code) AS idx FROM issues) ordered
            WHERE issues.rowid=ordered.rowid""")
        for table in ("records", "clients", "dogtags", "numbers", "lineage", "issues"):
            db.execute(f"COPY (SELECT * FROM {table} ORDER BY page_index) TO "
                       f"{sql_path(directory / f'{table}.parquet')} (FORMAT PARQUET)")
        counts = {role: db.execute(f"SELECT count(*) FROM {ROLES[role]}").fetchone()[0]
                  for role in ("CLIENTS", "DOGTAGS", "NUMBERS")}
        dispositions = dict(db.execute("SELECT disposition,count(*) FROM records GROUP BY disposition").fetchall())
        issue_counts = dict(db.execute("SELECT code,count(*) FROM issues WHERE code<>'label_contains_latin' GROUP BY code").fetchall())
        blocking_issues = db.execute("""SELECT count(*) FROM issues JOIN records USING(record_id)
            WHERE scope<>'warning' AND disposition NOT IN ('excluded_scientific_inn','excluded_manual')""").fetchone()[0]
        structural_issues = db.execute("SELECT count(*) FROM issues WHERE coalesce(field,'')='' ").fetchone()[0]
        reconciliation = reconcile(db, directory)
        if separate_errors:
            from app.domain.source_errors import create_source_errors, reconcile_source_errors
            create_source_errors(db, directory, (*HUB_COLUMNS, 'SPREADING', 'INTERNAL_OPERATOR_NAME'))
            counts['ERRORS'] = db.execute('SELECT count(*) FROM errors').fetchone()[0]
            counts = {role: count for role, count in counts.items() if count}
            reconciliation = reconcile_source_errors(db, directory, reconciliation)
    work_path.unlink()
    summary = {"dataset_version": 'hub-canonical-v2' if parsed_source or snapshot else DATASET_VERSION,
               "source_asset_id": str(source_asset_id), **parsed.summary,
               "counts": counts, "dispositions": dispositions, "issue_counts": issue_counts,
               "reconciliation": reconciliation,
               "blocking": bool(parsed.summary["file_errors"] or blocking_issues or not reconciliation["complete"]
                                or (dispositions.get('excluded_scientific_inn') and not counts.get('NUMBERS')))}
    summary['normalization_count'] = normalization_count
    if snapshot:
        summary['rules_version'] = snapshot['version']
        summary['rules_digest'] = snapshot['digest']
    if separate_errors:
        from app.domain.output_spec import source_spec
        if summary.get('error_source'):
            summary['error_source'] = {**summary['error_source'], 'diagnostic_column': 'Ошибка', 'utf8_bom': True}
        summary['dataset_version'] = 'source-add-canonical-v1'
        summary['operation'] = 'ADD'
        summary['record_fields'] = list(HUB_COLUMNS)
        summary['output_spec'] = source_spec('ADD', list(counts) or None)
        summary['blocking'] = bool(parsed.summary['file_errors'] or parsed.summary.get('unknown_remainder')
                                   or structural_issues or not reconciliation['complete'] or not counts)
    (directory / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    return CanonicalDataset(directory, summary, memory_limit, threads)


def publish_dataset(dataset, storage):
    """Publish immutable Parquet objects, then their index. U6 owns the guarded DB reference."""
    objects, pages = {}, {}
    for role, name in dataset.roles.items():
        path = dataset.directory / f"{name}.parquet"
        with path.open("rb") as stream:
            os.fsync(stream.fileno())  # ParquetWriter closed; make bytes durable before immutable links.
        digest, size = file_digest(path)
        objects[role] = {"key": storage.publish(StagedObject(path, digest, size)),
                         "sha256": digest, "size_bytes": size}
        if dataset.summary['dataset_version'] != DATASET_VERSION:
            rows = (row for batch in dataset.batches(role, batch_size=1000) for row in batch.to_pylist())
            pages[role] = publish_pages(rows, dataset.directory, storage, role=role)
    index = {"dataset_version": dataset.summary['dataset_version'], "summary": dataset.summary, "objects": objects}
    if pages:
        index['pages'] = pages
    from app.domain.review_sort import sorted_records
    rows = sorted_records(dataset.directory / 'records.parquet', dataset.directory / 'issues.parquet',
                          memory_limit=dataset.memory_limit, threads=dataset.threads)
    index['review_errors_first'] = publish_pages(rows, dataset.directory, storage, role='records-errors-first')
    normalization_path = dataset.directory / 'normalizations.parquet'
    if normalization_path.exists():
        with normalization_path.open('rb') as stream:
            os.fsync(stream.fileno())
        digest, size = file_digest(normalization_path)
        index['normalizations'] = {'key': storage.publish(StagedObject(normalization_path, digest, size)),
                                   'sha256': digest, 'size_bytes': size}
        rows = (row for batch in pq.ParquetFile(normalization_path).iter_batches(batch_size=1000)
                for row in batch.to_pylist())
        index['normalization_pages'] = publish_pages(rows, dataset.directory, storage, role='normalizations')
    path = dataset.directory / "index.json"
    with path.open("xb") as stream:
        stream.write(json.dumps(index, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())
        stream.flush()
        os.fsync(stream.fileno())
    digest, size = file_digest(path)
    return storage.publish(StagedObject(path, digest, size))


def file_digest(path):
    digest, size = hashlib.sha256(), 0
    with path.open("rb") as stream:
        while chunk := stream.read(65536):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def read_dataset_index(storage, key):
    path = storage.path_for_key(key)
    try:
        with path.open("rb") as stream:
            data = stream.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024 or hashlib.sha256(data).hexdigest() != key.split("/")[-1]:
            raise StorageFailure()
        index = json.loads(data)
        roles = dataset_roles(index['dataset_version'])
        if set(index['objects']) != set(roles):
            raise StorageFailure()
        if index['dataset_version'] != DATASET_VERSION and set(index['pages']) != set(roles):
            raise StorageFailure()
        return index
    except (OSError, ValueError, KeyError, TypeError):
        raise StorageFailure() from None


def dataset_roles(version):
    if version == 'source-whitemav-canonical-v1':
        from app.domain.delete import DELETE_ROLES
        return {**{k: v for k, v in DELETE_ROLES.items() if k != 'DELETE'}, 'NUMBERS': 'numbers', 'ERRORS': 'errors'}
    if version in ('source-add-canonical-v1', 'source-delete-canonical-v1'):
        from app.domain.delete import DELETE_ROLES
        base = ROLES if version == 'source-add-canonical-v1' else DELETE_ROLES
        return {**base, 'ERRORS': 'errors'}
    if version in ('repair-canonical-v1', 'repair-canonical-v2'):
        from app.domain.repair import REPAIR_ROLES
        return {role: name for role, name in REPAIR_ROLES.items() if version == 'repair-canonical-v2' or role != 'ERROR_OTHER_OPERATOR'}
    if version in (DATASET_VERSION, 'hub-canonical-v2'):
        return ROLES
    from app.domain.retries import RETRY_VERSION, retry_roles
    if version in (RETRY_VERSION, RETRY_VERSION + '-delete'):
        return retry_roles(version)
    from app.domain.delete import DELETE_ROLES, DELETE_VERSION
    if version == DELETE_VERSION:
        return DELETE_ROLES
    from app.domain.change import CHANGE_ROLES, CHANGE_VERSION
    if version == CHANGE_VERSION:
        return CHANGE_ROLES
    raise ValueError('Unsupported dataset version.')
