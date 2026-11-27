"""Frozen additive STATUS provenance, preserving legacy external events."""
from alembic import op
import sqlalchemy as sa

revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None

TABLES = ('return_assessments', 'return_rows', 'return_resolutions')

DDL = [
    """CREATE TABLE return_assessments (
	owner_id UUID NOT NULL, 
	case_id UUID NOT NULL, 
	intake_id UUID NOT NULL, 
	source_asset_id UUID NOT NULL, 
	intake_version_id UUID NOT NULL, 
	assessment_id UUID NOT NULL, 
	artifact_id UUID NOT NULL, 
	attempt_id UUID NOT NULL, 
	rule_version VARCHAR(120) NOT NULL, 
	rule_digest VARCHAR(64) NOT NULL, 
	counts JSONB NOT NULL, 
	id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_return_assessments PRIMARY KEY (id), 
	CONSTRAINT fk_return_assessments_owner_id_cases FOREIGN KEY(owner_id, case_id) REFERENCES cases (owner_id, id), 
	CONSTRAINT fk_return_assessments_case_id_intake_assessments FOREIGN KEY(case_id, source_asset_id, assessment_id) REFERENCES intake_assessments (case_id, source_asset_id, id), 
	CONSTRAINT fk_return_assessment_version FOREIGN KEY(case_id, intake_id, intake_version_id, assessment_id) REFERENCES intake_assessments (case_id, intake_id, intake_version_id, id), 
	CONSTRAINT fk_return_assessments_owner_id_external_attempts FOREIGN KEY(owner_id, artifact_id, attempt_id) REFERENCES external_attempts (owner_id, artifact_id, id), 
	CONSTRAINT uq_return_artifact_id UNIQUE (owner_id, artifact_id, id), 
	CONSTRAINT uq_return_intake_id UNIQUE (owner_id, intake_id, id), 
	CONSTRAINT uq_return_provenance UNIQUE (owner_id, case_id, source_asset_id, artifact_id, attempt_id, id), 
	CONSTRAINT uq_return_assessments_assessment_id UNIQUE (assessment_id)
)""",
    """CREATE INDEX ix_return_intake_page ON return_assessments (owner_id, intake_id, id)""",
    """CREATE TABLE return_rows (
	owner_id UUID NOT NULL, 
	artifact_id UUID NOT NULL, 
	return_assessment_id UUID NOT NULL, 
	ordinal BIGINT NOT NULL, 
	raw_record_id UUID, 
	raw_cells JSONB NOT NULL, 
	raw_status VARCHAR, 
	export_row_id UUID, 
	classification VARCHAR(32) NOT NULL, 
	reason VARCHAR(120) NOT NULL, 
	id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_return_rows PRIMARY KEY (id), 
	CONSTRAINT fk_return_rows_owner_id_return_assessments FOREIGN KEY(owner_id, artifact_id, return_assessment_id) REFERENCES return_assessments (owner_id, artifact_id, id), 
	CONSTRAINT fk_return_rows_owner_id_export_rows FOREIGN KEY(owner_id, artifact_id, export_row_id) REFERENCES export_rows (owner_id, artifact_id, id), 
	CONSTRAINT uq_return_row_ordinal UNIQUE (return_assessment_id, ordinal), 
	CONSTRAINT ck_return_rows_return_row_classification CHECK (classification IN ('APPLIED','REJECTED','UNKNOWN','MISSING','UNMATCHED','AMBIGUOUS','CONFLICT','INVALID')), 
	CONSTRAINT ck_return_rows_return_row_match CHECK (ordinal>0 AND (classification NOT IN ('APPLIED','REJECTED','MISSING') OR export_row_id IS NOT NULL))
)""",
    """CREATE INDEX ix_return_row_export ON return_rows (return_assessment_id, export_row_id, classification)""",
    """CREATE TABLE return_resolutions (
	owner_id UUID NOT NULL, 
	intake_id UUID NOT NULL, 
	previous_id UUID NOT NULL, 
	replacement_id UUID NOT NULL, 
	reason VARCHAR(2000) NOT NULL, 
	snapshot_version BIGINT NOT NULL, 
	id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_return_resolutions PRIMARY KEY (id), 
	CONSTRAINT fk_return_resolutions_owner_id_return_assessments FOREIGN KEY(owner_id, intake_id, previous_id) REFERENCES return_assessments (owner_id, intake_id, id), 
	CONSTRAINT fk_return_resolution_replacement FOREIGN KEY(owner_id, intake_id, replacement_id) REFERENCES return_assessments (owner_id, intake_id, id), 
	CONSTRAINT ck_return_resolutions_return_resolution_reason CHECK (previous_id<>replacement_id AND length(trim(reason))>0), 
	CONSTRAINT uq_return_resolutions_previous_id UNIQUE (previous_id), 
	CONSTRAINT uq_return_resolutions_replacement_id UNIQUE (replacement_id)
)""",
]


def upgrade():
    for statement in DDL:
        op.execute(statement)
    op.add_column('evidence_events', sa.Column('return_assessment_id', sa.UUID(), nullable=True))
    op.create_foreign_key('fk_evidence_return_provenance', 'evidence_events', 'return_assessments',
        ['owner_id', 'source_case_id', 'source_asset_id', 'artifact_id', 'attempt_id', 'return_assessment_id'],
        ['owner_id', 'case_id', 'source_asset_id', 'artifact_id', 'attempt_id', 'id'])
    for name in TABLES:
        op.execute(f'CREATE TRIGGER immutable_{name} BEFORE UPDATE OR DELETE ON {name} '
                   'FOR EACH ROW EXECUTE FUNCTION dogtags_reject_mutation()')
    # INSERT-only validation deliberately preserves pre-U11 nullable legacy RETURN history.
    op.execute("""CREATE FUNCTION dogtags_check_return_event() RETURNS trigger AS $$
    BEGIN
      IF (NEW.origin='RETURN') <> (NEW.return_assessment_id IS NOT NULL)
         OR (NEW.origin='RETURN' AND (NEW.coverage<>'ROWS' OR NEW.outcome NOT IN ('APPLIED','REJECTED'))) THEN
        RAISE EXCEPTION 'New RETURN evidence requires immutable exact correlation';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql""")
    op.execute('CREATE TRIGGER check_return_event BEFORE INSERT ON evidence_events '
               'FOR EACH ROW EXECUTE FUNCTION dogtags_check_return_event()')
    op.execute("""CREATE FUNCTION dogtags_check_return_coverage() RETURNS trigger AS $$
    DECLARE assessment uuid; result text;
    BEGIN
      SELECT return_assessment_id, outcome INTO assessment,result FROM evidence_events WHERE id=NEW.event_id;
      IF assessment IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM return_rows r WHERE r.return_assessment_id=assessment
          AND r.export_row_id=NEW.export_row_id AND r.owner_id=NEW.owner_id
          AND r.artifact_id=NEW.artifact_id AND r.classification=result
      ) THEN RAISE EXCEPTION 'Coverage lacks the matching classified return row'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql""")
    op.execute('CREATE TRIGGER check_return_coverage BEFORE INSERT ON evidence_coverage '
               'FOR EACH ROW EXECUTE FUNCTION dogtags_check_return_coverage()')
    op.execute("""CREATE FUNCTION dogtags_check_return_assessment() RETURNS trigger AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM intake_versions v WHERE v.id=NEW.intake_version_id
        AND v.decisions->'rules_snapshot'->>'version'=NEW.rule_version
        AND v.decisions->'rules_snapshot'->>'digest'=NEW.rule_digest
        AND v.decisions->>'return_attempt_id'=NEW.attempt_id::text) THEN
        RAISE EXCEPTION 'Return assessment does not match its pinned decisions and rules';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql""")
    op.execute('CREATE TRIGGER check_return_assessment BEFORE INSERT ON return_assessments '
               'FOR EACH ROW EXECUTE FUNCTION dogtags_check_return_assessment()')
    op.execute("""CREATE FUNCTION dogtags_check_return_row() RETURNS trigger AS $$
    BEGIN
      IF NEW.export_row_id IS NOT NULL AND NEW.classification<>'MISSING' AND NOT EXISTS (
        SELECT 1 FROM return_assessments a JOIN intake_assessments ia ON ia.id=a.assessment_id
        JOIN intake_versions v ON v.id=a.intake_version_id
        JOIN export_rows e ON e.id=NEW.export_row_id AND e.artifact_id=a.artifact_id
        WHERE a.id=NEW.return_assessment_id AND NEW.raw_record_id IS NOT NULL
        AND NEW.raw_cells->>((ia.result->'mapping'->>'STATUS')::int)=NEW.raw_status
        AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(e.values) cell
          WHERE NEW.raw_cells->>((ia.result->'mapping'->>cell.key)::int) IS DISTINCT FROM cell.value)
        AND (NEW.classification NOT IN ('APPLIED','REJECTED') OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(v.decisions->'rules_snapshot'->'config'->'statuses') rule
          WHERE rule->>'value'=NEW.raw_status AND rule->>'classification'=
            CASE WHEN NEW.classification='APPLIED' THEN 'success' ELSE 'failure' END))
      ) THEN RAISE EXCEPTION 'Matched return row lacks exact exported values and pinned STATUS rule'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql""")
    op.execute('CREATE TRIGGER check_return_row BEFORE INSERT ON return_rows '
               'FOR EACH ROW EXECUTE FUNCTION dogtags_check_return_row()')
    op.execute("""CREATE FUNCTION dogtags_check_return_resolution() RETURNS trigger AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM return_assessments prior_assessment JOIN intake_versions ov ON ov.id=prior_assessment.intake_version_id
        JOIN return_assessments next_assessment ON next_assessment.id=NEW.replacement_id JOIN intake_versions nv ON nv.id=next_assessment.intake_version_id
        WHERE prior_assessment.id=NEW.previous_id AND nv.sequence>ov.sequence
        AND nv.decisions->>'replaces_return_assessment_id'=prior_assessment.id::text
        AND nv.decisions->>'reason'=NEW.reason) THEN
        RAISE EXCEPTION 'Return correction lacks a later explicit reasoned decision';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql""")
    op.execute('CREATE TRIGGER check_return_resolution BEFORE INSERT ON return_resolutions '
               'FOR EACH ROW EXECUTE FUNCTION dogtags_check_return_resolution()')



def downgrade():
    if any(op.get_bind().scalar(sa.text(f'SELECT EXISTS (SELECT 1 FROM {name})')) for name in TABLES):
        raise RuntimeError('Return history requires a data-preserving forward migration.')
    op.execute('DROP TRIGGER check_return_coverage ON evidence_coverage')
    op.execute('DROP TRIGGER check_return_event ON evidence_events')
    op.drop_constraint('fk_evidence_return_provenance', 'evidence_events', type_='foreignkey')
    op.drop_column('evidence_events', 'return_assessment_id')
    for name in reversed(TABLES):
        op.drop_table(name)
    for name in ('dogtags_check_return_assessment', 'dogtags_check_return_coverage', 'dogtags_check_return_event',
                 'dogtags_check_return_row', 'dogtags_check_return_resolution'):
        op.execute(f'DROP FUNCTION {name}()')
