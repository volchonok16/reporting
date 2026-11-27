"""Immutable STATUS correlation and exact evidence lineage; no changes to v1 bytes."""
from uuid import UUID

from sqlalchemy import BigInteger, CheckConstraint, ForeignKeyConstraint, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models import Base, Identity


class ReturnAssessment(Identity, Base):
    __tablename__ = 'return_assessments'
    owner_id: Mapped[UUID]
    case_id: Mapped[UUID]
    intake_id: Mapped[UUID]
    source_asset_id: Mapped[UUID]
    intake_version_id: Mapped[UUID]
    assessment_id: Mapped[UUID] = mapped_column(unique=True)
    artifact_id: Mapped[UUID]
    attempt_id: Mapped[UUID]
    rule_version: Mapped[str] = mapped_column(String(120))
    rule_digest: Mapped[str] = mapped_column(String(64))
    counts: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (
        ForeignKeyConstraint(['owner_id', 'case_id'], ['cases.owner_id', 'cases.id']),
        ForeignKeyConstraint(['case_id', 'source_asset_id', 'assessment_id'],
                             ['intake_assessments.case_id', 'intake_assessments.source_asset_id', 'intake_assessments.id']),
        ForeignKeyConstraint(['case_id', 'intake_id', 'intake_version_id', 'assessment_id'],
                             ['intake_assessments.case_id', 'intake_assessments.intake_id',
                              'intake_assessments.intake_version_id', 'intake_assessments.id'], name='fk_return_assessment_version'),
        ForeignKeyConstraint(['owner_id', 'artifact_id', 'attempt_id'],
                             ['external_attempts.owner_id', 'external_attempts.artifact_id', 'external_attempts.id']),
        UniqueConstraint('owner_id', 'artifact_id', 'id', name='uq_return_artifact_id'),
        UniqueConstraint('owner_id', 'intake_id', 'id', name='uq_return_intake_id'),
        UniqueConstraint('owner_id', 'case_id', 'source_asset_id', 'artifact_id', 'attempt_id', 'id',
                         name='uq_return_provenance'),
        Index('ix_return_intake_page', 'owner_id', 'intake_id', 'id'),
    )


class ReturnRow(Identity, Base):
    __tablename__ = 'return_rows'
    owner_id: Mapped[UUID]
    artifact_id: Mapped[UUID]
    return_assessment_id: Mapped[UUID]
    ordinal: Mapped[int] = mapped_column(BigInteger)
    raw_record_id: Mapped[UUID | None]
    raw_cells: Mapped[list] = mapped_column(JSONB)
    raw_status: Mapped[str | None]
    export_row_id: Mapped[UUID | None]
    classification: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str] = mapped_column(String(120))
    __table_args__ = (
        ForeignKeyConstraint(['owner_id', 'artifact_id', 'return_assessment_id'],
                             ['return_assessments.owner_id', 'return_assessments.artifact_id', 'return_assessments.id']),
        ForeignKeyConstraint(['owner_id', 'artifact_id', 'export_row_id'],
                             ['export_rows.owner_id', 'export_rows.artifact_id', 'export_rows.id']),
        UniqueConstraint('return_assessment_id', 'ordinal', name='uq_return_row_ordinal'),
        CheckConstraint("classification IN ('APPLIED','REJECTED','UNKNOWN','MISSING','UNMATCHED','AMBIGUOUS','CONFLICT','INVALID')",
                        name='return_row_classification'),
        CheckConstraint("ordinal>0 AND (classification NOT IN ('APPLIED','REJECTED','MISSING') OR export_row_id IS NOT NULL)",
                        name='return_row_match'),
        Index('ix_return_row_export', 'return_assessment_id', 'export_row_id', 'classification'),
    )


class ReturnResolution(Identity, Base):
    __tablename__ = 'return_resolutions'
    owner_id: Mapped[UUID]
    intake_id: Mapped[UUID]
    previous_id: Mapped[UUID] = mapped_column(unique=True)
    replacement_id: Mapped[UUID] = mapped_column(unique=True)
    reason: Mapped[str] = mapped_column(String(2000))
    snapshot_version: Mapped[int] = mapped_column(BigInteger)
    __table_args__ = (
        ForeignKeyConstraint(['owner_id', 'intake_id', 'previous_id'],
                             ['return_assessments.owner_id', 'return_assessments.intake_id', 'return_assessments.id']),
        ForeignKeyConstraint(['owner_id', 'intake_id', 'replacement_id'],
                             ['return_assessments.owner_id', 'return_assessments.intake_id', 'return_assessments.id'], name='fk_return_resolution_replacement'),
        CheckConstraint('previous_id<>replacement_id AND length(trim(reason))>0', name='return_resolution_reason'),
    )
