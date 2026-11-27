"""PostgreSQL metadata. Dataset details belong in immutable Parquet, not JSON rows."""
from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import (BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, ForeignKeyConstraint,
                        Integer, MetaData, String, UniqueConstraint, Identity as SQLIdentity)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow():
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention={
        "pk": "pk_%(table_name)s", "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
        "uq": "uq_%(table_name)s_%(column_0_name)s", "ix": "ix_%(table_name)s_%(column_0_name)s",
        "ck": "ck_%(table_name)s_%(constraint_name)s",
    })


class Identity:
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class User(Identity, Base):
    __tablename__ = "users"
    username: Mapped[str] = mapped_column(String(120), unique=True)
    password_hash: Mapped[str] = mapped_column(String(512))
    permissions: Mapped[list] = mapped_column(JSONB)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class Session(Identity, Base):
    __tablename__ = "sessions"
    token_digest: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(128))
    user_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Case(Identity, Base):
    __tablename__ = "cases"
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str] = mapped_column(String(240))
    head_revision_id: Mapped[UUID | None]
    external_state: Mapped[str] = mapped_column(String(32), default="NOT_SUBMITTED")
    __table_args__ = (
        UniqueConstraint("owner_id", "id", name="uq_cases_owner_id_id"),
        ForeignKeyConstraint(["id", "head_revision_id"], ["processing_revisions.case_id", "processing_revisions.id"],
                             name="fk_cases_head_in_case", use_alter=True, deferrable=True),
    )


class SourceProfileVersion(Identity, Base):
    __tablename__ = "source_profile_versions"
    version: Mapped[str] = mapped_column(String(120), unique=True)
    config_hash: Mapped[str] = mapped_column(String(64))
    snapshot: Mapped[dict] = mapped_column(JSONB)


class RulePublication(Identity, Base):
    __tablename__ = 'rule_publications'
    publication_order: Mapped[int] = mapped_column(BigInteger, SQLIdentity(), unique=True)
    version: Mapped[str] = mapped_column(String(120), unique=True)
    digest: Mapped[str] = mapped_column(String(64))
    snapshot: Mapped[dict] = mapped_column(JSONB)
    created_by: Mapped[UUID] = mapped_column(ForeignKey('users.id'))
    reason: Mapped[str] = mapped_column(String(2000))


class ProcessingMnemonic(Identity, Base):
    __tablename__ = 'processing_mnemonics'
    code: Mapped[str] = mapped_column(String(120), unique=True)
    description: Mapped[str] = mapped_column(String(500), default='')
    __table_args__ = (CheckConstraint("digest ~ '^[0-9a-f]{64}$'", name='digest_format'),)


class WhitemavInn(Identity, Base):
    __tablename__ = 'whitemav_inns'
    owner_id: Mapped[UUID] = mapped_column(ForeignKey('users.id'))
    inn: Mapped[str] = mapped_column(String(12))
    company_name: Mapped[str] = mapped_column(String(500), default='', server_default='')
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, server_default='false')
    __table_args__ = (UniqueConstraint('owner_id', 'inn'),
                     CheckConstraint("inn ~ '^([0-9]{10}|[0-9]{12})$'", name='inn_digits'))


class SourceAsset(Identity, Base):
    __tablename__ = "source_assets"
    case_id: Mapped[UUID] = mapped_column(ForeignKey("cases.id"), index=True)
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    filename: Mapped[str] = mapped_column(String(240))
    encoding: Mapped[str | None] = mapped_column(String(16))
    metadata_version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    sha256: Mapped[str] = mapped_column(String(64))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    storage_key: Mapped[str] = mapped_column(String(160))
    inspection: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (
        UniqueConstraint("case_id", "id", name="uq_source_assets_case_id_id"),
        CheckConstraint("size_bytes >= 0", name="size_nonnegative"),
        CheckConstraint("(metadata_version = 1 AND encoding IS NOT NULL AND encoding IN ('utf-8','cp1251')) "
                        "OR (metadata_version = 2 AND encoding IS NULL)", name="explicit_encoding"),
        CheckConstraint("sha256 ~ '^[0-9a-f]{64}$'", name="sha256_format"),
    )


class Intake(Identity, Base):
    """Mutable head pointers; source facts and every decision/assessment remain immutable."""
    __tablename__ = "intakes"
    case_id: Mapped[UUID] = mapped_column(ForeignKey("cases.id"), unique=True)
    source_asset_id: Mapped[UUID]
    current_version_id: Mapped[UUID | None]
    current_assessment_id: Mapped[UUID | None]
    state: Mapped[str] = mapped_column(String(32), default="RECEIVING")
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    database_status: Mapped[str] = mapped_column(String(16), default="IN_PROGRESS", server_default="IN_PROGRESS")
    __table_args__ = (
        UniqueConstraint("case_id", "id", name="uq_intakes_case_id_id"),
        UniqueConstraint("case_id", "source_asset_id", "id", name="uq_intakes_case_source_id"),
        ForeignKeyConstraint(["case_id", "source_asset_id"], ["source_assets.case_id", "source_assets.id"],
                             name="fk_intake_source_in_case"),
        ForeignKeyConstraint(["case_id", "id", "current_version_id"],
                             ["intake_versions.case_id", "intake_versions.intake_id", "intake_versions.id"],
                             name="fk_intake_current_version", use_alter=True),
        ForeignKeyConstraint(["case_id", "id", "current_version_id", "current_assessment_id"],
                             ["intake_assessments.case_id", "intake_assessments.intake_id",
                              "intake_assessments.intake_version_id", "intake_assessments.id"],
                             name="fk_intake_current_assessment", use_alter=True),
        CheckConstraint("current_assessment_id IS NULL OR current_version_id IS NOT NULL",
                        name="assessment_has_version"),
    )


class IntakeVersion(Identity, Base):
    __tablename__ = "intake_versions"
    case_id: Mapped[UUID]
    intake_id: Mapped[UUID]
    source_asset_id: Mapped[UUID]
    parent_version_id: Mapped[UUID | None]
    sequence: Mapped[int] = mapped_column(Integer)
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    decisions: Mapped[dict] = mapped_column(JSONB, default=dict)
    __table_args__ = (
        UniqueConstraint("case_id", "id", name="uq_intake_versions_case_id_id"),
        UniqueConstraint("case_id", "intake_id", "id", name="uq_intake_versions_case_intake_id"),
        UniqueConstraint("intake_id", "sequence", name="uq_intake_versions_intake_sequence"),
        ForeignKeyConstraint(["case_id", "source_asset_id", "intake_id"],
                             ["intakes.case_id", "intakes.source_asset_id", "intakes.id"],
                             name="fk_intake_version_source"),
        ForeignKeyConstraint(["case_id", "intake_id", "parent_version_id"],
                             ["intake_versions.case_id", "intake_versions.intake_id", "intake_versions.id"],
                             name="fk_intake_version_parent"),
        CheckConstraint("sequence > 0", name="positive_sequence"),
    )


class IntakeAssessment(Identity, Base):
    __tablename__ = "intake_assessments"
    case_id: Mapped[UUID]
    intake_id: Mapped[UUID]
    source_asset_id: Mapped[UUID]
    intake_version_id: Mapped[UUID]
    reader_version: Mapped[str | None] = mapped_column(String(120))
    result: Mapped[dict] = mapped_column(JSONB, default=dict)
    questions: Mapped[list] = mapped_column(JSONB, default=list)
    __table_args__ = (
        UniqueConstraint("case_id", "source_asset_id", "id", name="uq_intake_assessments_case_source_id"),
        UniqueConstraint("case_id", "intake_id", "intake_version_id", "id",
                         name="uq_intake_assessments_version_id"),
        ForeignKeyConstraint(["case_id", "source_asset_id", "intake_id"],
                             ["intakes.case_id", "intakes.source_asset_id", "intakes.id"],
                             name="fk_intake_assessment_source"),
        ForeignKeyConstraint(["case_id", "intake_id", "intake_version_id"],
                             ["intake_versions.case_id", "intake_versions.intake_id", "intake_versions.id"],
                             name="fk_intake_assessment_version"),
    )


class ProcessingRevision(Identity, Base):
    __tablename__ = "processing_revisions"
    case_id: Mapped[UUID] = mapped_column(ForeignKey("cases.id"), index=True)
    source_asset_id: Mapped[UUID]
    parent_revision_id: Mapped[UUID | None]
    assessment_id: Mapped[UUID | None]
    sequence: Mapped[int] = mapped_column(Integer)
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    profile_version_id: Mapped[UUID] = mapped_column(ForeignKey("source_profile_versions.id"))
    profile_snapshot: Mapped[dict] = mapped_column(JSONB)
    settings: Mapped[dict] = mapped_column(JSONB, default=dict)
    correction_overlay: Mapped[list] = mapped_column(JSONB, default=list)
    config_hash: Mapped[str] = mapped_column(String(64))
    rules_version: Mapped[str] = mapped_column(String(120), default="hub-rules-v1")
    serializer_version: Mapped[str] = mapped_column(String(120), default="cp1251-crlf-v1")
    export_timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    export_timezone: Mapped[str] = mapped_column(String(120))
    filename_components: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (
        UniqueConstraint("case_id", "id", name="uq_processing_revisions_case_id_id"),
        UniqueConstraint("case_id", "sequence", name="uq_processing_revisions_case_sequence"),
        ForeignKeyConstraint(["case_id", "source_asset_id"], ["source_assets.case_id", "source_assets.id"],
                             name="fk_revision_source_in_case"),
        ForeignKeyConstraint(["case_id", "parent_revision_id"], ["processing_revisions.case_id", "processing_revisions.id"],
                             name="fk_revision_parent_in_case"),
        ForeignKeyConstraint(["case_id", "source_asset_id", "assessment_id"],
                             ["intake_assessments.case_id", "intake_assessments.source_asset_id", "intake_assessments.id"],
                             name="fk_revision_assessment_source"),
        CheckConstraint("sequence > 0", name="positive_sequence"),
    )


class Operation(Identity, Base):
    __tablename__ = "operations"
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    case_id: Mapped[UUID | None]
    action: Mapped[str] = mapped_column(String(80))
    client_operation_id: Mapped[UUID]
    request_digest: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(24), default="RUNNING")
    result: Mapped[dict | None] = mapped_column(JSONB)
    private_pending: Mapped[dict | None] = mapped_column(JSONB)
    error: Mapped[dict | None] = mapped_column(JSONB)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        ForeignKeyConstraint(["owner_id", "case_id"], ["cases.owner_id", "cases.id"], name="fk_operation_owner_case"),
        UniqueConstraint("owner_id", "case_id", "action", "client_operation_id",
                         name="uq_operations_scope_key", postgresql_nulls_not_distinct=True),
        CheckConstraint("status IN ('RUNNING','SUCCEEDED','FAILED')", name="status"),
    )


class ProcessingRun(Identity, Base):
    __tablename__ = "processing_runs"
    case_id: Mapped[UUID] = mapped_column(ForeignKey("cases.id"))
    kind: Mapped[str] = mapped_column(String(16), default="BUILD", server_default="BUILD")
    revision_id: Mapped[UUID | None]
    intake_version_id: Mapped[UUID | None]
    work_identity: Mapped[str] = mapped_column(String(64), unique=True)
    state: Mapped[str] = mapped_column(String(32), default="QUEUED")
    attempt: Mapped[int] = mapped_column(Integer, default=0)
    generation: Mapped[int] = mapped_column(Integer, default=0)
    lease_token: Mapped[UUID | None]
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    progress: Mapped[dict] = mapped_column(JSONB, default=dict)
    summary: Mapped[dict] = mapped_column(JSONB, default=dict)
    dataset_key: Mapped[str | None] = mapped_column(String(160))
    error: Mapped[dict | None] = mapped_column(JSONB)
    __table_args__ = (
        ForeignKeyConstraint(["case_id", "revision_id"], ["processing_revisions.case_id", "processing_revisions.id"],
                             name="fk_run_revision_in_case"),
        UniqueConstraint("case_id", "id", name="uq_processing_runs_case_id_id"),
        UniqueConstraint("revision_id", name="uq_processing_runs_revision"),
        UniqueConstraint("intake_version_id", name="uq_processing_runs_intake_version"),
        ForeignKeyConstraint(["case_id", "intake_version_id"], ["intake_versions.case_id", "intake_versions.id"],
                             name="fk_run_intake_version_in_case"),
        CheckConstraint("(kind = 'BUILD' AND revision_id IS NOT NULL AND intake_version_id IS NULL) OR "
                        "(kind = 'DISCOVER' AND revision_id IS NULL AND intake_version_id IS NOT NULL)",
                        name="typed_target"),
        CheckConstraint("attempt >= 0 AND generation >= 0", name="nonnegative_attempt_generation"),
    )


class Outbox(Identity, Base):
    __tablename__ = "outbox"
    run_id: Mapped[UUID] = mapped_column(ForeignKey("processing_runs.id"), unique=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ArtifactSet(Identity, Base):
    __tablename__ = "artifact_sets"
    case_id: Mapped[UUID] = mapped_column(ForeignKey("cases.id"))
    revision_id: Mapped[UUID]
    run_id: Mapped[UUID]
    generation: Mapped[int] = mapped_column(Integer)
    manifest: Mapped[dict] = mapped_column(JSONB)
    manifest_hash: Mapped[str] = mapped_column(String(64), unique=True)
    reconciliation: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (
        ForeignKeyConstraint(["case_id", "revision_id"], ["processing_revisions.case_id", "processing_revisions.id"],
                             name="fk_artifactset_revision_in_case"),
        ForeignKeyConstraint(["case_id", "run_id"], ["processing_runs.case_id", "processing_runs.id"],
                             name="fk_artifactset_run_in_case"),
        UniqueConstraint("case_id", "id", name="uq_artifact_sets_case_id_id"),
        UniqueConstraint("case_id", "id", "manifest_hash", name="uq_artifact_set_manifest_identity"),
        UniqueConstraint("case_id", "revision_id", "id", name="uq_artifact_sets_case_revision_id"),
        UniqueConstraint("revision_id", name="uq_artifact_sets_revision"),
    )


class Artifact(Identity, Base):
    __tablename__ = "artifacts"
    artifact_set_id: Mapped[UUID] = mapped_column(ForeignKey("artifact_sets.id"), index=True)
    role: Mapped[str] = mapped_column(String(32))
    download_filename: Mapped[str] = mapped_column(String(240))
    storage_key: Mapped[str] = mapped_column(String(160))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    __table_args__ = (UniqueConstraint("artifact_set_id", "role", name="uq_artifacts_set_role"),
                      UniqueConstraint("artifact_set_id", "id", name="uq_artifacts_set_id"))


class ArtifactDatabaseStatus(Base):
    """Operator marks live outside immutable exported-file metadata."""
    __tablename__ = "artifact_database_statuses"
    artifact_id: Mapped[UUID] = mapped_column(ForeignKey("artifacts.id"), primary_key=True)
    database_status: Mapped[str] = mapped_column(String(16), default="IN_PROGRESS", server_default="IN_PROGRESS")
    __table_args__ = (CheckConstraint("database_status IN ('IN_PROGRESS', 'LOADED')", name="valid_database_status"),)


class Approval(Identity, Base):
    __tablename__ = "approvals"
    case_id: Mapped[UUID] = mapped_column(ForeignKey("cases.id"))
    revision_id: Mapped[UUID]
    artifact_set_id: Mapped[UUID]
    operation_id: Mapped[UUID] = mapped_column(ForeignKey("operations.id"), unique=True)
    author_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    manifest_hash: Mapped[str] = mapped_column(String(64))
    __table_args__ = (
        ForeignKeyConstraint(["case_id", "revision_id"], ["processing_revisions.case_id", "processing_revisions.id"],
                             name="fk_approval_revision_in_case"),
        ForeignKeyConstraint(["case_id", "artifact_set_id"], ["artifact_sets.case_id", "artifact_sets.id"],
                             name="fk_approval_artifactset_in_case"),
    )


class AuditEvent(Identity, Base):
    __tablename__ = "audit_events"
    case_id: Mapped[UUID | None] = mapped_column(ForeignKey("cases.id"), index=True)
    revision_id: Mapped[UUID | None] = mapped_column(ForeignKey("processing_revisions.id"))
    actor_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(80))
    operation_id: Mapped[UUID | None] = mapped_column(ForeignKey("operations.id"))
    details: Mapped[dict] = mapped_column(JSONB, default=dict)


class ChangeScope(Identity, Base):
    __tablename__ = 'change_scopes'
    owner_id: Mapped[UUID] = mapped_column(ForeignKey('users.id'))
    case_id: Mapped[UUID]
    revision_id: Mapped[UUID] = mapped_column(unique=True)
    source_case_id: Mapped[UUID]
    source_artifact_set_id: Mapped[UUID]
    source_artifact_id: Mapped[UUID]
    snapshot: Mapped[dict] = mapped_column(JSONB)
    digest: Mapped[str] = mapped_column(String(64))
    __table_args__ = (
        ForeignKeyConstraint(['owner_id', 'case_id'], ['cases.owner_id', 'cases.id']),
        ForeignKeyConstraint(['owner_id', 'source_case_id'], ['cases.owner_id', 'cases.id'], name='fk_change_scope_source_owner'),
        ForeignKeyConstraint(['case_id', 'revision_id'], ['processing_revisions.case_id', 'processing_revisions.id']),
        ForeignKeyConstraint(['source_case_id', 'source_artifact_set_id'], ['artifact_sets.case_id', 'artifact_sets.id']),
        ForeignKeyConstraint(['source_artifact_set_id', 'source_artifact_id'], ['artifacts.artifact_set_id', 'artifacts.id']),
    )


class OutputStage(Identity, Base):
    __tablename__ = 'output_stages'
    case_id: Mapped[UUID]
    revision_id: Mapped[UUID]
    artifact_set_id: Mapped[UUID]
    name: Mapped[str] = mapped_column(String(32))
    depends_on_id: Mapped[UUID | None]
    __table_args__ = (
        UniqueConstraint('artifact_set_id', 'id', name='uq_output_stages_set_id'),
        UniqueConstraint('artifact_set_id', 'name', name='uq_output_stages_set_name'),
        ForeignKeyConstraint(['case_id', 'revision_id', 'artifact_set_id'],
            ['artifact_sets.case_id', 'artifact_sets.revision_id', 'artifact_sets.id']),
        ForeignKeyConstraint(['artifact_set_id', 'depends_on_id'], ['output_stages.artifact_set_id', 'output_stages.id']),
        CheckConstraint("(name = 'DELETE' AND depends_on_id IS NULL) OR "
                        "(name = 'ADD' AND (depends_on_id IS NULL OR depends_on_id <> id))", name='change_stage_order'),
    )


class StageArtifact(Identity, Base):
    __tablename__ = 'stage_artifacts'
    artifact_set_id: Mapped[UUID]
    stage_id: Mapped[UUID]
    artifact_id: Mapped[UUID] = mapped_column(unique=True)
    __table_args__ = (
        UniqueConstraint('artifact_set_id', 'stage_id', 'artifact_id', name='uq_stage_artifact_identity'),
        ForeignKeyConstraint(['artifact_set_id', 'stage_id'], ['output_stages.artifact_set_id', 'output_stages.id']),
        ForeignKeyConstraint(['artifact_set_id', 'artifact_id'], ['artifacts.artifact_set_id', 'artifacts.id']),
    )


from app.models.evidence import (AttemptAncestor, EvidenceCoverage, EvidenceEvent, EvidenceResolution,  # noqa: E402,F401
                                 ExportRow, ExternalAttempt, RegistryBackfill, RegistryClock,
                                 RegistryEntry, ResolutionEvidence)
from app.models.returns import ReturnAssessment, ReturnResolution, ReturnRow  # noqa: E402,F401
