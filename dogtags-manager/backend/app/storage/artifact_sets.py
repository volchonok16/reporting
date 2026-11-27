"""Durable complete bundles; the worker owns head/generation checks and DB commit."""
import os
import csv
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select

from app.domain.canonical import file_digest
from app.domain.manifest import build_manifest, canonical_manifest_bytes, export_filename, file_metadata
from app.domain.operations import canonical_digest
from app.domain.projections import OUTPUT_CONTRACT, ProjectionFailure, verify_projections
from app.domain.output_spec import MANIFEST_VERSION, dataset_operation, dataset_spec, manifest_spec, revision_spec
from app.domain.serialization import SerializationFailure, SerializedFile, verify_zip, write_csv, write_zip
from app.storage.output_pages import publish_output_pages, verify_output_pages
from app.models import Artifact, ArtifactSet, utcnow
from app.storage.local import StagedObject, StorageFailure


@dataclass(frozen=True)
class PublishedArtifact:
    role: str
    download_filename: str
    sha256: str
    size_bytes: int
    storage_key: str
    row_count: int | None = None


@dataclass(frozen=True)
class VerifiedBundle:
    manifest: dict
    manifest_hash: str
    manifest_key: str
    artifacts: tuple[PublishedArtifact, ...]


def publish_artifact_bundle(dataset, revision, source, storage, staging_directory):
    """No DB rows or result state are written, including after an interrupted publication."""
    if (dataset.summary["source_asset_id"] != str(source.id) or revision.source_asset_id != source.id
            or revision.serializer_version != OUTPUT_CONTRACT["serialization"]["version"]):
        raise ProjectionFailure([{"code": "revision_snapshot_mismatch"}])
    from app.domain.output_spec import source_separation, source_spec
    partial = source_separation(revision.settings)
    spec = dataset_spec(dataset) if revision.settings.get('retry') or revision.settings.get('operation') == 'REPAIR' or partial else revision_spec(revision)
    if revision.settings.get('operation') == 'REPAIR':
        from app.domain.output_spec import repair_spec
        if spec != repair_spec(revision.settings['repair_role'], spec['roles'], version=spec['version']):
            raise ProjectionFailure([{'code': 'revision_snapshot_mismatch'}])
    if partial and spec != source_spec(revision.settings['operation'], spec['roles']):
        raise ProjectionFailure([{'code': 'revision_snapshot_mismatch'}])
    if dataset_operation(dataset) != spec['operation']:
        raise ProjectionFailure([{'code': 'revision_operation_mismatch'}])
    checked = verify_projections(dataset)
    directory = Path(staging_directory)
    directory.mkdir(parents=True, exist_ok=False)
    formed_at = utcnow()
    try:
        files = [write_csv(dataset, role, directory / export_filename(revision, role, formed_at=formed_at)) for role in spec['roles']]
        zip_file = write_zip(files, directory / export_filename(revision, "ZIP", formed_at=formed_at), operation=spec["operation"], spec=spec)
    except SerializationFailure as error:
        for diagnostic in error.diagnostics:
            diagnostic["revision_id"] = str(revision.id)
        raise
    manifest = build_manifest(revision, source, checked, files, zip_file, spec=spec, formed_at=formed_at)
    if any(role in spec['roles'] for role in ('ERRORS', 'ERROR_OTHER_OPERATOR')) and dataset.summary.get('error_source'):
        manifest['error_source'] = dataset.summary['error_source']
    if manifest['version'] == MANIFEST_VERSION:
        manifest['previews'] = publish_output_pages(files, directory, storage, spec['operation'], dataset=dataset)
    manifest_path = directory / 'manifest.json'
    with manifest_path.open("xb") as stream:
        stream.write(canonical_manifest_bytes(manifest))
        stream.flush()
        os.fsync(stream.fileno())
    digest, size = file_digest(manifest_path)
    if digest != canonical_digest(manifest):
        raise StorageFailure()
    artifacts = tuple(PublishedArtifact(obj.role, obj.download_filename, obj.sha256, obj.size_bytes,
                                        storage.publish(StagedObject(obj.path, obj.sha256, obj.size_bytes)), obj.row_count)
                      for obj in (*files, zip_file))
    key = storage.publish(StagedObject(manifest_path, digest, size))
    bundle = VerifiedBundle(manifest, digest, key, artifacts)
    verify_bundle(bundle, storage)
    return bundle


def verify_bundle(bundle, storage, *, full=True):
    """Missing or mismatched final objects are integrity failures, never a complete set."""
    manifest = bundle.manifest
    try:
        spec = manifest_spec(manifest)
        roles = tuple(spec['roles'])
        if (canonical_digest(manifest) != bundle.manifest_hash
                or bundle.manifest_key != storage.key_for_hash(bundle.manifest_hash)
                or tuple(obj.role for obj in bundle.artifacts) != (*roles, "ZIP")
                or not manifest["reconciliation"]["complete"]
                or [item["role"] for item in manifest["csv"]] != list(roles)):
            raise StorageFailure()
        data = canonical_manifest_bytes(manifest)
        path = storage.verify(bundle.manifest_key, bundle.manifest_hash, len(data))
        if path.read_bytes() != data:
            raise StorageFailure()
        for obj, metadata in zip(bundle.artifacts, [*manifest["csv"], manifest["zip"]], strict=True):
            expected = file_metadata(obj)
            actual = {key: metadata[key] for key in expected}
            if (expected != actual or obj.storage_key != storage.key_for_hash(obj.sha256)
                    or (obj.role in roles and obj.row_count != manifest["counts"][obj.role])):
                raise StorageFailure()
            if full:
                storage.verify(obj.storage_key, obj.sha256, obj.size_bytes)
        if manifest['version'] == MANIFEST_VERSION:
            if set(manifest['previews']) != set(roles):
                raise StorageFailure()
            if full:
                files = [SerializedFile(storage.path_for_key(obj.storage_key), obj.role, obj.download_filename,
                    obj.sha256, obj.size_bytes, obj.row_count) for obj in bundle.artifacts[:-1]]
                verify_zip(files, storage.path_for_key(bundle.artifacts[-1].storage_key))
                for obj in bundle.artifacts[:-1]:
                    verify_output_pages(storage, manifest['previews'][obj.role], obj, spec['operation'],
                                        error_source=manifest.get('error_source'))
    except (KeyError, TypeError, ValueError, OSError, UnicodeError, csv.Error, SerializationFailure):
        raise StorageFailure() from None
    return bundle


def verify_artifact_set(db, artifact_set, storage, *, full=True):
    rows = db.scalars(select(Artifact).where(Artifact.artifact_set_id == artifact_set.id)).all()
    try:
        roles = tuple(manifest_spec(artifact_set.manifest)['roles'])
    except (ValueError, KeyError, TypeError):
        raise StorageFailure() from None
    by_role = {obj.role: obj for obj in rows}
    if (set(by_role) != {*roles, "ZIP"} or len(rows) != len(roles) + 1
            or artifact_set.manifest.get("revision_id") != str(artifact_set.revision_id)
            or artifact_set.reconciliation != artifact_set.manifest.get("reconciliation")):
        raise StorageFailure()
    try:
        counts = artifact_set.manifest["counts"]
        objects = tuple(PublishedArtifact(obj.role, obj.download_filename, obj.sha256, obj.size_bytes,
                                          obj.storage_key, counts[obj.role] if obj.role in roles else None)
                        for obj in (by_role[role] for role in (*roles, "ZIP")))
        bundle = VerifiedBundle(artifact_set.manifest, artifact_set.manifest_hash,
                                storage.key_for_hash(artifact_set.manifest_hash), objects)
    except (KeyError, TypeError):
        raise StorageFailure() from None
    if artifact_set.manifest.get('output_spec', {}).get('operation') == 'CHANGE':
        from app.domain.change import verify_stage_links
        verify_stage_links(db, artifact_set)
    return verify_bundle(bundle, storage, full=full)


def link_artifact_bundle(db, revision, run, bundle, storage, *, verified=False):
    """Call within U6's fenced transaction. This helper never commits or changes run state."""
    if not verified:
        verify_bundle(bundle, storage)
    if (run.case_id != revision.case_id or run.revision_id != revision.id
            or bundle.manifest["revision_id"] != str(revision.id)
            or bundle.manifest["source"]["asset_id"] != str(revision.source_asset_id)
            or bundle.manifest["config_hash"] != revision.config_hash):
        raise StorageFailure()
    existing = db.scalar(select(ArtifactSet).where(ArtifactSet.revision_id == revision.id))
    if existing:
        verified = verify_artifact_set(db, existing, storage)
        if verified.manifest_hash != bundle.manifest_hash or existing.run_id != run.id:
            raise StorageFailure()
        return existing
    artifact_set = ArtifactSet(case_id=revision.case_id, revision_id=revision.id, run_id=run.id,
                               generation=run.generation, manifest=bundle.manifest, manifest_hash=bundle.manifest_hash,
                               reconciliation=bundle.manifest["reconciliation"])
    db.add(artifact_set)
    db.flush()
    artifacts = []
    for obj in bundle.artifacts:
        artifact = Artifact(artifact_set_id=artifact_set.id, role=obj.role, download_filename=obj.download_filename,
                        storage_key=obj.storage_key, size_bytes=obj.size_bytes, sha256=obj.sha256)
        db.add(artifact)
        artifacts.append(artifact)
    db.flush()
    from app.domain.change import link_stages
    link_stages(db, artifact_set, revision, artifacts)
    return artifact_set
