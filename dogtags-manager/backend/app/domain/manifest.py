"""Canonical manifest and filenames contain immutable revision data only."""
import hashlib
import json
import re
from pathlib import Path
from zoneinfo import ZoneInfo

from app.domain.operations import canonical_digest
from app.domain.projections import OUTPUT_CONTRACT
from app.domain.output_spec import CONTRACTS, MANIFEST_VERSION as OPERATION_MANIFEST_VERSION, revision_spec
from app.domain.serialization import PACKING_VERSION

MANIFEST_VERSION = "hub-artifact-manifest-v1"
COMPONENTS = ("partner", "operation", "request", "revision", "stage")


def capture_filename_components(case_id, revision_id, sequence, source_filename):
    return {"source_filename": source_filename, "partner": "RTK-HUB", "operation": "MARKING",
            "request": str(case_id), "revision": f"r{sequence}-{revision_id}", "stage": "PREPARED"}


def export_filename(revision, role, *, formed_at=None):
    spec = revision_spec(revision)
    if role not in (*spec["roles"], "ZIP") or revision.export_timestamp.tzinfo is None:
        raise ValueError("A supported role and captured UTC timestamp are required.")
    if getattr(revision, 'settings', {}).get('filename_policy') == 'short-output-v1':
        if formed_at is None or formed_at.tzinfo is None:
            raise ValueError('Short names require the bundle formation timestamp.')
        partner = revision.filename_components.get('partner')
        if not isinstance(partner, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,64}', partner):
            raise ValueError('Unsupported filename partner.')
        token = role
        if role == 'ERRORS':
            source_role = (revision.settings['repair_role'] if spec['operation'] == 'REPAIR' else
                           'DELETE' if spec['operation'] == 'DELETE' else 'SOURCE')
            token = source_role + '_ERRORS'
        if role == 'ZIP':
            token = 'FILES'
        stamp = formed_at.astimezone(ZoneInfo(revision.export_timezone)).strftime('%d.%m.%y')
        return '_'.join([partner.replace('-', '_'), token, stamp]) + ('.zip' if role == 'ZIP' else '.csv')
    components = [revision.filename_components.get(key) for key in COMPONENTS]
    if any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9-]+", value) for value in components):
        raise ValueError("The immutable revision has incomplete or unsafe filename components.")
    stamp = revision.export_timestamp.astimezone(ZoneInfo(revision.export_timezone)).strftime("%Y-%m-%dT%H-%M-%S%z")
    filename = "_".join([stamp, *components, role]) + (".zip" if role == "ZIP" else ".csv")
    if len(filename) > 240:
        raise ValueError("The captured export filename is too long.")
    return filename


def canonical_manifest_bytes(manifest):
    return json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def implementation_hash(version, names, contract):
    directory = Path(__file__).parent
    return canonical_digest({"version": version, "contract": contract,
                             "implementation": {name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
                                                for name in names}})


def file_metadata(obj):
    result = {"role": obj.role, "name": obj.download_filename, "size_bytes": obj.size_bytes, "sha256": obj.sha256}
    if obj.row_count is not None:
        result["row_count"] = obj.row_count
    return result


def build_manifest(revision, source, checked, files, zip_file, *, spec=None, formed_at=None):
    spec = spec or revision_spec(revision)
    if tuple(obj.role for obj in files) != tuple(spec["roles"]):
        raise ValueError("A manifest requires the operation’s exact ordered CSVs.")
    rule_files = ["validation.py", "canonical.py", "reconciliation.py"]
    rule_contract = {"output": OUTPUT_CONTRACT["files"]}
    if revision.rules_version == 'published-rules-v1':
        from app.domain.rules import checked_config
        snapshot = revision.settings['rules_snapshot']
        checked_config(snapshot)
        rule_files.append('rules.py')
        rule_contract['published_config_digest'] = snapshot['digest']
    manifest = {"version": MANIFEST_VERSION, "revision_id": str(revision.id),
            "source": {"asset_id": str(source.id), "sha256": source.sha256, "size_bytes": source.size_bytes,
                       "encoding": source.encoding},
            "config_hash": revision.config_hash,
            "rules": {"version": revision.rules_version, "sha256": implementation_hash(
                revision.rules_version, rule_files, rule_contract)},
            "serializer": {"version": revision.serializer_version, "sha256": implementation_hash(
                revision.serializer_version, ["serialization.py", "projections.py"], OUTPUT_CONTRACT)},
            "counts": checked["counts"], "reconciliation": checked["reconciliation"],
            "csv": [file_metadata(obj) for obj in files],
            "zip": {**file_metadata(zip_file), "packing_version": PACKING_VERSION}}

    if revision.rules_version == 'published-rules-v1':
        manifest['rules']['publication'] = {'version': snapshot['version'], 'digest': snapshot['digest']}
        manifest['source']['assessment_id'] = str(revision.assessment_id)
    if revision.settings.get('output_spec'):
        manifest['version'] = OPERATION_MANIFEST_VERSION
        manifest['output_spec'] = spec
        if spec['operation'] == 'DELETE':
            manifest['rules']['sha256'] = implementation_hash(revision.rules_version,
                ['delete.py', 'corrections.py'], CONTRACTS['DELETE'])
        if spec['operation'] == 'CHANGE':
            manifest['delete_scope'] = revision.settings['delete_scope']
        contract = CONTRACTS if spec['operation'] in ('CHANGE', 'REPAIR') else CONTRACTS[spec['operation']]
        if spec['operation'] == 'REPAIR':
            from app.domain.output_spec import file_definition
            contract = {**contract, 'ERRORS': file_definition('ERRORS', 'REPAIR'), 'repair': spec}
            manifest['rules']['sha256'] = implementation_hash(revision.rules_version,
                ['repair.py', 'validation.py', 'corrections.py'], contract)
        if spec.get('version') == 'source-output-v1':
            from app.domain.output_spec import file_definition
            contract = {**contract, 'source_preparation': spec, 'ERRORS': file_definition('ERRORS', spec['operation'])}
            manifest['rules']['sha256'] = implementation_hash(revision.rules_version,
                ['canonical.py' if spec['operation'] == 'ADD' else 'delete.py',
                 'source_errors.py', 'validation.py', 'corrections.py',
                 *(['whitemav.py'] if spec['operation'] == 'WHITEMAV' else [])], contract)
        manifest['serializer']['sha256'] = implementation_hash(revision.serializer_version,
            ['serialization.py', 'projections.py', 'output_spec.py'], contract)
    if revision.settings.get('retry'):
        manifest['retry'] = revision.settings['retry']
    if revision.settings.get('filename_policy') == 'short-output-v1':
        if formed_at is None or formed_at.tzinfo is None:
            raise ValueError('Short names require the bundle formation timestamp.')
        manifest['naming'] = {'version': 'short-output-v1',
                             'formed_on': formed_at.astimezone(ZoneInfo(revision.export_timezone)).date().isoformat(),
                             'timezone': revision.export_timezone,
                             'partner': revision.filename_components['partner'].replace('-', '_')}
    return manifest
