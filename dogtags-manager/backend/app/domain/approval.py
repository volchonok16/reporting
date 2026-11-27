"""Exact-set decisions serialize with revision saves and fenced worker publication."""
from sqlalchemy import select

from app.auth.policy import scoped_object
from app.domain.output_spec import MANIFEST_VERSION, revision_spec
from app.domain.operations import canonical_digest, complete_operation, find_operation
from app.errors import ApiError
from app.models import Approval, ArtifactSet, AuditEvent, Operation, ProcessingRevision, ProcessingRun
from app.storage.artifact_sets import verify_artifact_set
from app.storage.local import StorageFailure


def approval_view(approval):
    return {"id": str(approval.id), "case_id": str(approval.case_id), "revision_id": str(approval.revision_id),
            "artifact_set_id": str(approval.artifact_set_id), "manifest_hash": approval.manifest_hash,
            "author_id": str(approval.author_id), "created_at": approval.created_at.isoformat()}


def find_approval_for_set(db, artifact_set):
    if not artifact_set:
        return None
    return db.scalar(select(Approval).where(Approval.case_id == artifact_set.case_id,
                     Approval.revision_id == artifact_set.revision_id, Approval.artifact_set_id == artifact_set.id,
                     Approval.manifest_hash == artifact_set.manifest_hash))


def current_complete_set(db, user, case, revision_id, manifest_hash, storage):
    """Caller holds Case; acquiring Run second follows the common mutation lock order."""
    revision = scoped_object(db, user, ProcessingRevision, revision_id, case_id=case.id)
    from app.domain.retries import require_snapshot
    require_snapshot(db, user.id, revision)
    if case.head_revision_id != revision.id:
        raise ApiError(409, "revision_conflict", "Текущая ревизия изменилась. Сверьте актуальный комплект.")
    run = db.scalar(select(ProcessingRun).where(ProcessingRun.revision_id == revision.id).with_for_update())
    artifact_set = db.scalar(select(ArtifactSet).where(ArtifactSet.revision_id == revision.id))
    if (not run or not artifact_set or run.state not in {"PREPARED", "APPROVED"}
            or artifact_set.run_id != run.id or artifact_set.generation != run.generation
            or run.summary.get("blocking") is not False or not artifact_set.reconciliation.get("complete")):
        raise ApiError(409, "package_not_prepared", "Полный комплект ещё не подготовлен без блокирующих ошибок.")
    if artifact_set.manifest_hash != manifest_hash:
        raise ApiError(409, "manifest_conflict", "Состав или хеш комплекта изменился. Сверьте актуальный результат.")
    try:
        bundle = verify_artifact_set(db, artifact_set, storage)
        expected_spec = revision_spec(revision)
        if expected_spec['operation'] == 'REPAIR':
            from app.domain.output_spec import repair_spec
            expected_spec = repair_spec(revision.settings['repair_role'],
                                       [role for role in expected_spec['roles'] if role in run.summary['counts']],
                                       version=expected_spec['version'])
        if expected_spec.get('version') == 'source-output-v1':
            from app.domain.output_spec import source_spec
            expected_spec = source_spec(expected_spec['operation'],
                                       [role for role in expected_spec['roles'] if role in run.summary['counts']])
        if revision.settings.get('retry'):
            from app.domain.output_spec import retry_spec
            expected_spec = retry_spec(expected_spec['operation'], [r for r in expected_spec['roles'] if r in run.summary['counts']])
            if bundle.manifest.get('retry') != revision.settings['retry']:
                raise StorageFailure()
        if bundle.manifest['version'] == MANIFEST_VERSION and bundle.manifest['output_spec'] != expected_spec:
            raise StorageFailure()
        if (bundle.manifest["source"]["asset_id"] != str(revision.source_asset_id)
                or bundle.manifest["config_hash"] != revision.config_hash
                or bundle.manifest["rules"]["version"] != revision.rules_version
                or bundle.manifest["serializer"]["version"] != revision.serializer_version
                or run.summary.get("reconciliation") != artifact_set.reconciliation
                or run.summary.get("counts") != bundle.manifest["counts"]):
            raise StorageFailure()
    except (StorageFailure, KeyError, TypeError, ValueError):
        raise ApiError(503, "artifact_integrity_error", "Сохранённый комплект недоступен или повреждён.",
                       retryable=True) from None
    return revision, run, artifact_set, bundle


def approve(db, user, case, body, storage):
    digest = canonical_digest(body.model_dump(mode="json", exclude={"operation_id"}))
    existing = find_operation(db, user.id, case.id, "package.approve", body.operation_id, digest)
    if existing:
        return existing  # Original receipt survives edits; it cannot approve a new head.
    revision, run, artifact_set, _ = current_complete_set(
        db, user, case, body.expected_revision_id, body.manifest_hash, storage)
    operation = Operation(owner_id=user.id, case_id=case.id, action="package.approve",
                          client_operation_id=body.operation_id, request_digest=digest)
    db.add(operation)
    db.flush()
    decision = find_approval_for_set(db, artifact_set)
    if not decision:
        decision = Approval(case_id=case.id, revision_id=revision.id, artifact_set_id=artifact_set.id,
                            operation_id=operation.id, author_id=user.id, manifest_hash=artifact_set.manifest_hash)
        db.add(decision)
        db.flush()
        db.add(AuditEvent(case_id=case.id, revision_id=revision.id, actor_id=user.id, action="package.approve",
                          operation_id=operation.id, details={"approval_id": str(decision.id),
                          "artifact_set_id": str(artifact_set.id), "manifest_hash": artifact_set.manifest_hash}))
    run.state = "APPROVED"
    complete_operation(operation, {"approval": approval_view(decision)})
    return operation
