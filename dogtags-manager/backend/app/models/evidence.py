"""Additive immutable external history and rebuildable owner-scoped projections."""
from uuid import UUID

from sqlalchemy import BigInteger, CheckConstraint, ForeignKey, ForeignKeyConstraint, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base, Identity


class RegistryClock(Base):
    __tablename__ = 'registry_clocks'
    owner_id: Mapped[UUID] = mapped_column(ForeignKey('users.id'), primary_key=True)
    version: Mapped[int] = mapped_column(BigInteger, default=0)


class RegistryBackfill(Base):
    __tablename__ = 'registry_backfills'
    artifact_id: Mapped[UUID] = mapped_column(ForeignKey('artifacts.id'), primary_key=True)
    owner_id: Mapped[UUID]
    case_id: Mapped[UUID]
    artifact_set_id: Mapped[UUID]
    projection_version: Mapped[int] = mapped_column(default=1)
    cursor: Mapped[int] = mapped_column(BigInteger, default=0)
    byte_cursor: Mapped[int] = mapped_column(BigInteger, default=0)
    expected_rows: Mapped[int] = mapped_column(BigInteger)
    complete: Mapped[bool] = mapped_column(default=False)
    __table_args__ = (
        ForeignKeyConstraint(['owner_id', 'case_id'], ['cases.owner_id', 'cases.id']),
        ForeignKeyConstraint(['case_id', 'artifact_set_id'], ['artifact_sets.case_id', 'artifact_sets.id']),
        ForeignKeyConstraint(['artifact_set_id', 'artifact_id'], ['artifacts.artifact_set_id', 'artifacts.id']),
        CheckConstraint('projection_version=1 AND cursor>=0 AND cursor<=expected_rows', name='backfill_cursor'),
        Index('ix_registry_backfill_owner_complete', 'owner_id', 'complete', 'artifact_id'),
    )


class ExportRow(Identity, Base):
    __tablename__ = 'export_rows'
    owner_id: Mapped[UUID]
    case_id: Mapped[UUID]
    artifact_set_id: Mapped[UUID]
    artifact_id: Mapped[UUID]
    ordinal: Mapped[int] = mapped_column(BigInteger)
    projection_version: Mapped[int] = mapped_column(default=1)
    kind: Mapped[str] = mapped_column(String(16))
    business_key: Mapped[str] = mapped_column(String(64))
    values: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (
        ForeignKeyConstraint(['owner_id', 'case_id'], ['cases.owner_id', 'cases.id']),
        ForeignKeyConstraint(['case_id', 'artifact_set_id'], ['artifact_sets.case_id', 'artifact_sets.id']),
        ForeignKeyConstraint(['artifact_set_id', 'artifact_id'], ['artifacts.artifact_set_id', 'artifacts.id']),
        UniqueConstraint('projection_version', 'artifact_id', 'ordinal', name='uq_export_row_ordinal'),
        UniqueConstraint('owner_id', 'artifact_id', 'id', name='uq_export_row_owner_artifact_id'),
        CheckConstraint('projection_version=1 AND ordinal>0', name='export_row_identity'),
        Index('ix_export_rows_owner_key', 'owner_id', 'kind', 'business_key'),
    )


class RegistryEntry(Identity, Base):
    __tablename__ = 'registry_entries'
    owner_id: Mapped[UUID] = mapped_column(ForeignKey('users.id'))
    kind: Mapped[str] = mapped_column(String(16))
    business_key: Mapped[str] = mapped_column(String(64))
    prepared_count: Mapped[int] = mapped_column(BigInteger, default=0)
    external_state: Mapped[str] = mapped_column(String(16), default='UNKNOWN')
    __table_args__ = (
        UniqueConstraint('owner_id', 'kind', 'business_key', name='uq_registry_owner_key'),
        UniqueConstraint('owner_id', 'id', name='uq_registry_owner_id'),
        Index('ix_registry_owner_kind_page', 'owner_id', 'kind', 'id'),
        Index('ix_registry_owner_state_page', 'owner_id', 'external_state', 'id'),
    )


class ExternalAttempt(Identity, Base):
    __tablename__ = 'external_attempts'
    owner_id: Mapped[UUID]
    case_id: Mapped[UUID]
    artifact_set_id: Mapped[UUID]
    artifact_id: Mapped[UUID]
    stage_id: Mapped[UUID]
    manifest_hash: Mapped[str] = mapped_column(String(64))
    reason: Mapped[str] = mapped_column(String(2000))
    operation_id: Mapped[UUID]
    request_digest: Mapped[str] = mapped_column(String(64))
    __table_args__ = (
        ForeignKeyConstraint(['owner_id', 'case_id'], ['cases.owner_id', 'cases.id']),
        ForeignKeyConstraint(['case_id', 'artifact_set_id', 'manifest_hash'],
                             ['artifact_sets.case_id', 'artifact_sets.id', 'artifact_sets.manifest_hash']),
        ForeignKeyConstraint(['artifact_set_id', 'stage_id', 'artifact_id'],
                             ['stage_artifacts.artifact_set_id', 'stage_artifacts.stage_id', 'stage_artifacts.artifact_id']),
        UniqueConstraint('owner_id', 'id', name='uq_attempt_owner_id'),
        UniqueConstraint('owner_id', 'artifact_id', 'id', name='uq_attempt_owner_artifact_id'),
        UniqueConstraint('owner_id', 'operation_id', name='uq_attempt_operation'),
        CheckConstraint('length(trim(reason))>0', name='attempt_reason'),
        Index('ix_attempt_owner_artifact', 'owner_id', 'artifact_id'),
    )


class AttemptAncestor(Base):
    __tablename__ = 'attempt_ancestors'
    owner_id: Mapped[UUID]
    attempt_id: Mapped[UUID] = mapped_column(primary_key=True)
    ancestor_id: Mapped[UUID] = mapped_column(primary_key=True)
    direct: Mapped[bool]
    __table_args__ = (
        ForeignKeyConstraint(['owner_id', 'attempt_id'], ['external_attempts.owner_id', 'external_attempts.id']),
        ForeignKeyConstraint(['owner_id', 'ancestor_id'], ['external_attempts.owner_id', 'external_attempts.id'], name='fk_ancestor_target_owner'),
        CheckConstraint('attempt_id<>ancestor_id', name='attempt_no_self_ancestor'),
        Index('ix_attempt_ancestor_reverse', 'owner_id', 'ancestor_id', 'attempt_id'),
    )


class EvidenceEvent(Identity, Base):
    __tablename__ = 'evidence_events'
    owner_id: Mapped[UUID]
    artifact_id: Mapped[UUID]
    attempt_id: Mapped[UUID]
    author_id: Mapped[UUID] = mapped_column(ForeignKey('users.id'))
    reason: Mapped[str] = mapped_column(String(2000))
    origin: Mapped[str] = mapped_column(String(16))
    source_case_id: Mapped[UUID | None]
    source_asset_id: Mapped[UUID | None]
    return_assessment_id: Mapped[UUID | None]
    outcome: Mapped[str] = mapped_column(String(16))
    coverage: Mapped[str] = mapped_column(String(16))
    operation_id: Mapped[UUID]
    request_digest: Mapped[str] = mapped_column(String(64))
    snapshot_version: Mapped[int] = mapped_column(BigInteger)
    __table_args__ = (
        ForeignKeyConstraint(['owner_id', 'artifact_id', 'attempt_id'],
                             ['external_attempts.owner_id', 'external_attempts.artifact_id', 'external_attempts.id']),
        ForeignKeyConstraint(['owner_id', 'source_case_id'], ['cases.owner_id', 'cases.id']),
        ForeignKeyConstraint(['owner_id', 'source_case_id', 'source_asset_id', 'artifact_id', 'attempt_id', 'return_assessment_id'],
                             ['return_assessments.owner_id', 'return_assessments.case_id', 'return_assessments.source_asset_id',
                              'return_assessments.artifact_id', 'return_assessments.attempt_id', 'return_assessments.id'],
                             name='fk_evidence_return_provenance'),
        ForeignKeyConstraint(['source_case_id', 'source_asset_id'], ['source_assets.case_id', 'source_assets.id']),
        UniqueConstraint('owner_id', 'artifact_id', 'id', name='uq_event_owner_artifact_id'),
        UniqueConstraint('owner_id', 'id', name='uq_event_owner_id'),
        UniqueConstraint('owner_id', 'operation_id', name='uq_evidence_operation'),
        CheckConstraint("outcome IN ('APPLIED', 'REJECTED', 'UNKNOWN', 'PARTIAL')", name='evidence_outcome'),
        CheckConstraint("coverage IN ('FILE','ROWS','UNKNOWN') AND "
                        "(outcome<>'PARTIAL' OR coverage='UNKNOWN') AND "
                        "(coverage<>'UNKNOWN' OR outcome IN ('PARTIAL','UNKNOWN'))", name='evidence_coverage'),
        CheckConstraint("author_id=owner_id AND ((origin='MANUAL' AND source_asset_id IS NULL AND source_case_id IS NULL) OR "
                        "(origin='RETURN' AND source_asset_id IS NOT NULL AND source_case_id IS NOT NULL))", name='evidence_provenance'),
        CheckConstraint('length(trim(reason))>0', name='evidence_reason'),
        Index('ix_evidence_attempt_page', 'owner_id', 'attempt_id', 'id'),
    )


class EvidenceCoverage(Base):
    __tablename__ = 'evidence_coverage'
    owner_id: Mapped[UUID]
    artifact_id: Mapped[UUID]
    event_id: Mapped[UUID] = mapped_column(primary_key=True)
    export_row_id: Mapped[UUID] = mapped_column(primary_key=True)
    __table_args__ = (
        ForeignKeyConstraint(['owner_id', 'artifact_id', 'event_id'],
                             ['evidence_events.owner_id', 'evidence_events.artifact_id', 'evidence_events.id']),
        ForeignKeyConstraint(['owner_id', 'artifact_id', 'export_row_id'],
                             ['export_rows.owner_id', 'export_rows.artifact_id', 'export_rows.id']),
        Index('ix_coverage_export_row', 'export_row_id', 'event_id'),
    )


class EvidenceResolution(Identity, Base):
    __tablename__ = 'evidence_resolutions'
    owner_id: Mapped[UUID]
    entry_id: Mapped[UUID]
    chosen_event_id: Mapped[UUID]
    reason: Mapped[str] = mapped_column(String(2000))
    operation_id: Mapped[UUID]
    request_digest: Mapped[str] = mapped_column(String(64))
    snapshot_version: Mapped[int] = mapped_column(BigInteger)
    __table_args__ = (
        ForeignKeyConstraint(['owner_id', 'entry_id'], ['registry_entries.owner_id', 'registry_entries.id']),
        ForeignKeyConstraint(['owner_id', 'chosen_event_id'], ['evidence_events.owner_id', 'evidence_events.id']),
        UniqueConstraint('owner_id', 'id', name='uq_resolution_owner_id'),
        UniqueConstraint('owner_id', 'operation_id', name='uq_resolution_operation'),
        CheckConstraint('length(trim(reason))>0', name='resolution_reason'),
        Index('ix_resolution_entry', 'owner_id', 'entry_id'),
    )


class ResolutionEvidence(Base):
    __tablename__ = 'resolution_evidence'
    owner_id: Mapped[UUID]
    resolution_id: Mapped[UUID] = mapped_column(primary_key=True)
    event_id: Mapped[UUID] = mapped_column(primary_key=True)
    __table_args__ = (
        ForeignKeyConstraint(['owner_id', 'resolution_id'], ['evidence_resolutions.owner_id', 'evidence_resolutions.id']),
        ForeignKeyConstraint(['owner_id', 'event_id'], ['evidence_events.owner_id', 'evidence_events.id']),
    )
