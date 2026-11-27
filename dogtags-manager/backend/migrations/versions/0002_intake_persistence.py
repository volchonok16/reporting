"""Add immutable intake history and typed work without rewriting v1 rows.

DDL is frozen here; no imports from live models. Downgrade refuses to discard v2 data.
"""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

DDL = [
    """CREATE TABLE intakes (
	case_id UUID NOT NULL,
	source_asset_id UUID NOT NULL,
	current_version_id UUID,
	current_assessment_id UUID,
	state VARCHAR(32) NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_intakes PRIMARY KEY (id),
	CONSTRAINT uq_intakes_case_id_id UNIQUE (case_id, id),
	CONSTRAINT uq_intakes_case_source_id UNIQUE (case_id, source_asset_id, id),
	CONSTRAINT fk_intake_source_in_case FOREIGN KEY(case_id, source_asset_id) REFERENCES source_assets (case_id, id),
	CONSTRAINT ck_intakes_assessment_has_version CHECK (current_assessment_id IS NULL OR current_version_id IS NOT NULL),
	CONSTRAINT uq_intakes_case_id UNIQUE (case_id),
	CONSTRAINT fk_intakes_case_id_cases FOREIGN KEY(case_id) REFERENCES cases (id)
)""",
    """CREATE TABLE intake_versions (
	case_id UUID NOT NULL,
	intake_id UUID NOT NULL,
	source_asset_id UUID NOT NULL,
	parent_version_id UUID,
	sequence INTEGER NOT NULL,
	created_by UUID NOT NULL,
	decisions JSONB NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_intake_versions PRIMARY KEY (id),
	CONSTRAINT uq_intake_versions_case_id_id UNIQUE (case_id, id),
	CONSTRAINT uq_intake_versions_case_intake_id UNIQUE (case_id, intake_id, id),
	CONSTRAINT uq_intake_versions_intake_sequence UNIQUE (intake_id, sequence),
	CONSTRAINT fk_intake_version_source FOREIGN KEY(case_id, source_asset_id, intake_id) REFERENCES intakes (case_id, source_asset_id, id),
	CONSTRAINT fk_intake_version_parent FOREIGN KEY(case_id, intake_id, parent_version_id) REFERENCES intake_versions (case_id, intake_id, id),
	CONSTRAINT ck_intake_versions_positive_sequence CHECK (sequence > 0),
	CONSTRAINT fk_intake_versions_created_by_users FOREIGN KEY(created_by) REFERENCES users (id)
)""",
    """CREATE TABLE intake_assessments (
	case_id UUID NOT NULL,
	intake_id UUID NOT NULL,
	source_asset_id UUID NOT NULL,
	intake_version_id UUID NOT NULL,
	reader_version VARCHAR(120),
	result JSONB NOT NULL,
	questions JSONB NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_intake_assessments PRIMARY KEY (id),
	CONSTRAINT uq_intake_assessments_case_source_id UNIQUE (case_id, source_asset_id, id),
	CONSTRAINT uq_intake_assessments_version_id UNIQUE (case_id, intake_id, intake_version_id, id),
	CONSTRAINT fk_intake_assessment_source FOREIGN KEY(case_id, source_asset_id, intake_id) REFERENCES intakes (case_id, source_asset_id, id),
	CONSTRAINT fk_intake_assessment_version FOREIGN KEY(case_id, intake_id, intake_version_id) REFERENCES intake_versions (case_id, intake_id, id)
)""",
    """ALTER TABLE intakes ADD CONSTRAINT fk_intake_current_version FOREIGN KEY(case_id, id, current_version_id) REFERENCES intake_versions (case_id, intake_id, id)""",
    """ALTER TABLE intakes ADD CONSTRAINT fk_intake_current_assessment FOREIGN KEY(case_id, id, current_version_id, current_assessment_id) REFERENCES intake_assessments (case_id, intake_id, intake_version_id, id)""",

]


def upgrade():
    op.execute("ALTER TABLE source_assets ADD COLUMN metadata_version INTEGER NOT NULL DEFAULT 1")
    op.execute("ALTER TABLE source_assets ALTER COLUMN encoding DROP NOT NULL")
    op.execute("ALTER TABLE source_assets DROP CONSTRAINT ck_source_assets_explicit_encoding")
    op.execute("""ALTER TABLE source_assets ADD CONSTRAINT ck_source_assets_explicit_encoding CHECK (
        (metadata_version = 1 AND encoding IS NOT NULL AND encoding IN ('utf-8','cp1251')) OR
        (metadata_version = 2 AND encoding IS NULL))""")
    for statement in DDL:
        op.execute(statement)
    for table in ("intake_versions", "intake_assessments"):
        op.execute(f"CREATE TRIGGER immutable_{table} BEFORE UPDATE OR DELETE ON {table} "
                   "FOR EACH ROW EXECUTE FUNCTION dogtags_reject_mutation()")
    op.execute("ALTER TABLE processing_revisions ADD COLUMN assessment_id UUID")
    op.execute("""ALTER TABLE processing_revisions ADD CONSTRAINT fk_revision_assessment_source
        FOREIGN KEY (case_id, source_asset_id, assessment_id)
        REFERENCES intake_assessments (case_id, source_asset_id, id)""")
    op.execute("ALTER TABLE processing_runs ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'BUILD'")
    op.execute("ALTER TABLE processing_runs ALTER COLUMN revision_id DROP NOT NULL")
    op.execute("ALTER TABLE processing_runs ADD COLUMN intake_version_id UUID")
    op.execute("""ALTER TABLE processing_runs ADD CONSTRAINT fk_run_intake_version_in_case
        FOREIGN KEY (case_id, intake_version_id) REFERENCES intake_versions (case_id, id)""")
    op.execute("""ALTER TABLE processing_runs ADD CONSTRAINT uq_processing_runs_intake_version
        UNIQUE (intake_version_id)""")
    op.execute("""ALTER TABLE processing_runs ADD CONSTRAINT ck_processing_runs_typed_target CHECK (
        (kind = 'BUILD' AND revision_id IS NOT NULL AND intake_version_id IS NULL) OR
        (kind = 'DISCOVER' AND revision_id IS NULL AND intake_version_id IS NOT NULL))""")


def downgrade():
    # After new writes, rollback needs a forward fix or a separately proven data-preserving migration.
    if op.get_bind().scalar(sa.text("""SELECT EXISTS (SELECT 1 FROM intakes)
        OR EXISTS (SELECT 1 FROM source_assets WHERE metadata_version <> 1)
        OR EXISTS (SELECT 1 FROM processing_revisions WHERE assessment_id IS NOT NULL)
        OR EXISTS (SELECT 1 FROM processing_runs WHERE kind <> 'BUILD')""")):
        raise RuntimeError("Cannot discard persisted v2 intake data; use a data-preserving forward migration.")
    op.execute("ALTER TABLE processing_runs DROP CONSTRAINT ck_processing_runs_typed_target")
    op.execute("ALTER TABLE processing_runs DROP CONSTRAINT uq_processing_runs_intake_version")
    op.execute("ALTER TABLE processing_runs DROP CONSTRAINT fk_run_intake_version_in_case")
    op.execute("ALTER TABLE processing_runs DROP COLUMN intake_version_id, DROP COLUMN kind")
    op.execute("ALTER TABLE processing_runs ALTER COLUMN revision_id SET NOT NULL")
    op.execute("ALTER TABLE processing_revisions DROP CONSTRAINT fk_revision_assessment_source")
    op.execute("ALTER TABLE processing_revisions DROP COLUMN assessment_id")
    op.execute("ALTER TABLE intakes DROP CONSTRAINT fk_intake_current_assessment")
    op.execute("ALTER TABLE intakes DROP CONSTRAINT fk_intake_current_version")
    for table in ("intake_assessments", "intake_versions", "intakes"):
        op.execute(f"DROP TABLE {table}")
    op.execute("ALTER TABLE source_assets DROP CONSTRAINT ck_source_assets_explicit_encoding")
    op.execute("ALTER TABLE source_assets ADD CONSTRAINT ck_source_assets_explicit_encoding "
               "CHECK (encoding IN ('utf-8','cp1251'))")
    op.execute("ALTER TABLE source_assets ALTER COLUMN encoding SET NOT NULL")
    op.execute("ALTER TABLE source_assets DROP COLUMN metadata_version")
