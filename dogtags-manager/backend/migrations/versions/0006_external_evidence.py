"""Immutable artifact/row evidence and owner-scoped rebuildable registry. No v1 rewrites."""
from alembic import op
import sqlalchemy as sa

revision = '0006'
down_revision = '0005'
branch_labels = None
depends_on = None

TABLES = ('registry_clocks', 'registry_backfills', 'export_rows', 'registry_entries',
          'external_attempts', 'attempt_ancestors', 'evidence_events', 'evidence_coverage',
          'evidence_resolutions', 'resolution_evidence')
IMMUTABLE = ('export_rows', 'external_attempts', 'attempt_ancestors', 'evidence_events',
             'evidence_coverage', 'evidence_resolutions', 'resolution_evidence')


# Frozen DDL, matching 0001/0002: future model changes cannot alter this migration.
DDL = [
    """CREATE TABLE registry_clocks (
	owner_id UUID NOT NULL, 
	version BIGINT NOT NULL, 
	CONSTRAINT pk_registry_clocks PRIMARY KEY (owner_id), 
	CONSTRAINT fk_registry_clocks_owner_id_users FOREIGN KEY(owner_id) REFERENCES users (id)
)""",
    """CREATE TABLE registry_backfills (
	artifact_id UUID NOT NULL, 
	owner_id UUID NOT NULL, 
	case_id UUID NOT NULL, 
	artifact_set_id UUID NOT NULL, 
	projection_version INTEGER NOT NULL, 
	cursor BIGINT NOT NULL, 
	byte_cursor BIGINT NOT NULL, 
	expected_rows BIGINT NOT NULL, 
	complete BOOLEAN NOT NULL, 
	CONSTRAINT pk_registry_backfills PRIMARY KEY (artifact_id), 
	CONSTRAINT fk_registry_backfills_owner_id_cases FOREIGN KEY(owner_id, case_id) REFERENCES cases (owner_id, id), 
	CONSTRAINT fk_registry_backfills_case_id_artifact_sets FOREIGN KEY(case_id, artifact_set_id) REFERENCES artifact_sets (case_id, id), 
	CONSTRAINT fk_registry_backfills_artifact_set_id_artifacts FOREIGN KEY(artifact_set_id, artifact_id) REFERENCES artifacts (artifact_set_id, id), 
	CONSTRAINT ck_registry_backfills_backfill_cursor CHECK (projection_version=1 AND cursor>=0 AND cursor<=expected_rows), 
	CONSTRAINT fk_registry_backfills_artifact_id_artifacts FOREIGN KEY(artifact_id) REFERENCES artifacts (id)
)""",
    """CREATE INDEX ix_registry_backfill_owner_complete ON registry_backfills (owner_id, complete, artifact_id)""",
    """CREATE TABLE export_rows (
	owner_id UUID NOT NULL, 
	case_id UUID NOT NULL, 
	artifact_set_id UUID NOT NULL, 
	artifact_id UUID NOT NULL, 
	ordinal BIGINT NOT NULL, 
	projection_version INTEGER NOT NULL, 
	kind VARCHAR(16) NOT NULL, 
	business_key VARCHAR(64) NOT NULL, 
	values JSONB NOT NULL, 
	id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_export_rows PRIMARY KEY (id), 
	CONSTRAINT fk_export_rows_owner_id_cases FOREIGN KEY(owner_id, case_id) REFERENCES cases (owner_id, id), 
	CONSTRAINT fk_export_rows_case_id_artifact_sets FOREIGN KEY(case_id, artifact_set_id) REFERENCES artifact_sets (case_id, id), 
	CONSTRAINT fk_export_rows_artifact_set_id_artifacts FOREIGN KEY(artifact_set_id, artifact_id) REFERENCES artifacts (artifact_set_id, id), 
	CONSTRAINT uq_export_row_ordinal UNIQUE (projection_version, artifact_id, ordinal), 
	CONSTRAINT uq_export_row_owner_artifact_id UNIQUE (owner_id, artifact_id, id), 
	CONSTRAINT ck_export_rows_export_row_identity CHECK (projection_version=1 AND ordinal>0)
)""",
    """CREATE INDEX ix_export_rows_owner_key ON export_rows (owner_id, kind, business_key)""",
    """CREATE TABLE registry_entries (
	owner_id UUID NOT NULL, 
	kind VARCHAR(16) NOT NULL, 
	business_key VARCHAR(64) NOT NULL, 
	prepared_count BIGINT NOT NULL, 
	external_state VARCHAR(16) NOT NULL, 
	id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_registry_entries PRIMARY KEY (id), 
	CONSTRAINT uq_registry_owner_key UNIQUE (owner_id, kind, business_key), 
	CONSTRAINT uq_registry_owner_id UNIQUE (owner_id, id), 
	CONSTRAINT fk_registry_entries_owner_id_users FOREIGN KEY(owner_id) REFERENCES users (id)
)""",
    """CREATE INDEX ix_registry_owner_kind_page ON registry_entries (owner_id, kind, id)""",
    """CREATE INDEX ix_registry_owner_state_page ON registry_entries (owner_id, external_state, id)""",
    """CREATE TABLE external_attempts (
	owner_id UUID NOT NULL, 
	case_id UUID NOT NULL, 
	artifact_set_id UUID NOT NULL, 
	artifact_id UUID NOT NULL, 
	stage_id UUID NOT NULL, 
	manifest_hash VARCHAR(64) NOT NULL, 
	reason VARCHAR(2000) NOT NULL, 
	operation_id UUID NOT NULL, 
	request_digest VARCHAR(64) NOT NULL, 
	id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_external_attempts PRIMARY KEY (id), 
	CONSTRAINT fk_external_attempts_owner_id_cases FOREIGN KEY(owner_id, case_id) REFERENCES cases (owner_id, id), 
	CONSTRAINT fk_external_attempts_case_id_artifact_sets FOREIGN KEY(case_id, artifact_set_id, manifest_hash) REFERENCES artifact_sets (case_id, id, manifest_hash), 
	CONSTRAINT fk_external_attempts_artifact_set_id_stage_artifacts FOREIGN KEY(artifact_set_id, stage_id, artifact_id) REFERENCES stage_artifacts (artifact_set_id, stage_id, artifact_id), 
	CONSTRAINT uq_attempt_owner_id UNIQUE (owner_id, id), 
	CONSTRAINT uq_attempt_owner_artifact_id UNIQUE (owner_id, artifact_id, id), 
	CONSTRAINT uq_attempt_operation UNIQUE (owner_id, operation_id), 
	CONSTRAINT ck_external_attempts_attempt_reason CHECK (length(trim(reason))>0)
)""",
    """CREATE INDEX ix_attempt_owner_artifact ON external_attempts (owner_id, artifact_id)""",
    """CREATE TABLE attempt_ancestors (
	owner_id UUID NOT NULL, 
	attempt_id UUID NOT NULL, 
	ancestor_id UUID NOT NULL, 
	direct BOOLEAN NOT NULL, 
	CONSTRAINT pk_attempt_ancestors PRIMARY KEY (attempt_id, ancestor_id), 
	CONSTRAINT fk_attempt_ancestors_owner_id_external_attempts FOREIGN KEY(owner_id, attempt_id) REFERENCES external_attempts (owner_id, id), 
	CONSTRAINT fk_ancestor_target_owner FOREIGN KEY(owner_id, ancestor_id) REFERENCES external_attempts (owner_id, id), 
	CONSTRAINT ck_attempt_ancestors_attempt_no_self_ancestor CHECK (attempt_id<>ancestor_id)
)""",
    """CREATE INDEX ix_attempt_ancestor_reverse ON attempt_ancestors (owner_id, ancestor_id, attempt_id)""",
    """CREATE TABLE evidence_events (
	owner_id UUID NOT NULL, 
	artifact_id UUID NOT NULL, 
	attempt_id UUID NOT NULL, 
	author_id UUID NOT NULL, 
	reason VARCHAR(2000) NOT NULL, 
	origin VARCHAR(16) NOT NULL, 
	source_case_id UUID, 
	source_asset_id UUID, 
	outcome VARCHAR(16) NOT NULL, 
	coverage VARCHAR(16) NOT NULL, 
	operation_id UUID NOT NULL, 
	request_digest VARCHAR(64) NOT NULL, 
	snapshot_version BIGINT NOT NULL, 
	id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_evidence_events PRIMARY KEY (id), 
	CONSTRAINT fk_evidence_events_owner_id_external_attempts FOREIGN KEY(owner_id, artifact_id, attempt_id) REFERENCES external_attempts (owner_id, artifact_id, id), 
	CONSTRAINT fk_evidence_events_owner_id_cases FOREIGN KEY(owner_id, source_case_id) REFERENCES cases (owner_id, id), 
	CONSTRAINT fk_evidence_events_source_case_id_source_assets FOREIGN KEY(source_case_id, source_asset_id) REFERENCES source_assets (case_id, id), 
	CONSTRAINT uq_event_owner_artifact_id UNIQUE (owner_id, artifact_id, id), 
	CONSTRAINT uq_event_owner_id UNIQUE (owner_id, id), 
	CONSTRAINT uq_evidence_operation UNIQUE (owner_id, operation_id), 
	CONSTRAINT ck_evidence_events_evidence_outcome CHECK (outcome IN ('APPLIED', 'REJECTED', 'UNKNOWN', 'PARTIAL')), 
	CONSTRAINT ck_evidence_events_evidence_coverage CHECK (coverage IN ('FILE','ROWS','UNKNOWN') AND (outcome<>'PARTIAL' OR coverage='UNKNOWN') AND (coverage<>'UNKNOWN' OR outcome IN ('PARTIAL','UNKNOWN'))), 
	CONSTRAINT ck_evidence_events_evidence_provenance CHECK (author_id=owner_id AND ((origin='MANUAL' AND source_asset_id IS NULL AND source_case_id IS NULL) OR (origin='RETURN' AND source_asset_id IS NOT NULL AND source_case_id IS NOT NULL))), 
	CONSTRAINT ck_evidence_events_evidence_reason CHECK (length(trim(reason))>0), 
	CONSTRAINT fk_evidence_events_author_id_users FOREIGN KEY(author_id) REFERENCES users (id)
)""",
    """CREATE INDEX ix_evidence_attempt_page ON evidence_events (owner_id, attempt_id, id)""",
    """CREATE TABLE evidence_coverage (
	owner_id UUID NOT NULL, 
	artifact_id UUID NOT NULL, 
	event_id UUID NOT NULL, 
	export_row_id UUID NOT NULL, 
	CONSTRAINT pk_evidence_coverage PRIMARY KEY (event_id, export_row_id), 
	CONSTRAINT fk_evidence_coverage_owner_id_evidence_events FOREIGN KEY(owner_id, artifact_id, event_id) REFERENCES evidence_events (owner_id, artifact_id, id), 
	CONSTRAINT fk_evidence_coverage_owner_id_export_rows FOREIGN KEY(owner_id, artifact_id, export_row_id) REFERENCES export_rows (owner_id, artifact_id, id)
)""",
    """CREATE INDEX ix_coverage_export_row ON evidence_coverage (export_row_id, event_id)""",
    """CREATE TABLE evidence_resolutions (
	owner_id UUID NOT NULL, 
	entry_id UUID NOT NULL, 
	chosen_event_id UUID NOT NULL, 
	reason VARCHAR(2000) NOT NULL, 
	operation_id UUID NOT NULL, 
	request_digest VARCHAR(64) NOT NULL, 
	snapshot_version BIGINT NOT NULL, 
	id UUID NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	CONSTRAINT pk_evidence_resolutions PRIMARY KEY (id), 
	CONSTRAINT fk_evidence_resolutions_owner_id_registry_entries FOREIGN KEY(owner_id, entry_id) REFERENCES registry_entries (owner_id, id), 
	CONSTRAINT fk_evidence_resolutions_owner_id_evidence_events FOREIGN KEY(owner_id, chosen_event_id) REFERENCES evidence_events (owner_id, id), 
	CONSTRAINT uq_resolution_owner_id UNIQUE (owner_id, id), 
	CONSTRAINT uq_resolution_operation UNIQUE (owner_id, operation_id), 
	CONSTRAINT ck_evidence_resolutions_resolution_reason CHECK (length(trim(reason))>0)
)""",
    """CREATE INDEX ix_resolution_entry ON evidence_resolutions (owner_id, entry_id)""",
    """CREATE TABLE resolution_evidence (
	owner_id UUID NOT NULL, 
	resolution_id UUID NOT NULL, 
	event_id UUID NOT NULL, 
	CONSTRAINT pk_resolution_evidence PRIMARY KEY (resolution_id, event_id), 
	CONSTRAINT fk_resolution_evidence_owner_id_evidence_resolutions FOREIGN KEY(owner_id, resolution_id) REFERENCES evidence_resolutions (owner_id, id), 
	CONSTRAINT fk_resolution_evidence_owner_id_evidence_events FOREIGN KEY(owner_id, event_id) REFERENCES evidence_events (owner_id, id)
)""",
]


def upgrade():
    op.drop_constraint(op.f('ck_output_stages_change_stage_order'), 'output_stages', type_='check')
    op.create_check_constraint('change_stage_order', 'output_stages',
        "(name = 'DELETE' AND depends_on_id IS NULL) OR (name = 'ADD' AND (depends_on_id IS NULL OR depends_on_id <> id))")
    op.create_unique_constraint('uq_artifact_set_manifest_identity', 'artifact_sets', ['case_id', 'id', 'manifest_hash'])
    op.create_unique_constraint('uq_stage_artifact_identity', 'stage_artifacts', ['artifact_set_id', 'stage_id', 'artifact_id'])
    for statement in DDL:
        op.execute(statement)
    for name in IMMUTABLE:
        op.execute(f'CREATE TRIGGER immutable_{name} BEFORE UPDATE OR DELETE ON {name} '
                   'FOR EACH ROW EXECUTE FUNCTION dogtags_reject_mutation()')

    op.execute("""CREATE FUNCTION dogtags_check_resolution_coverage() RETURNS trigger AS $$
    DECLARE entity_id uuid; selected_event uuid;
    BEGIN
      IF TG_TABLE_NAME='evidence_resolutions' THEN
        entity_id := NEW.entry_id; selected_event := NEW.chosen_event_id;
      ELSE
        SELECT entry_id INTO entity_id FROM evidence_resolutions WHERE id=NEW.resolution_id;
        selected_event := NEW.event_id;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM registry_entries re JOIN export_rows r ON r.owner_id=re.owner_id
          AND r.kind=re.kind AND r.business_key=re.business_key
        JOIN evidence_coverage c ON c.export_row_id=r.id
        WHERE re.id=entity_id AND re.owner_id=NEW.owner_id AND c.event_id=selected_event
      ) THEN RAISE EXCEPTION 'Resolution evidence is outside the exact business coverage'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql""")
    for name in ('evidence_resolutions', 'resolution_evidence'):
        op.execute(f'CREATE TRIGGER check_{name}_coverage BEFORE INSERT ON {name} '
                   'FOR EACH ROW EXECUTE FUNCTION dogtags_check_resolution_coverage()')
    op.execute("""CREATE FUNCTION dogtags_check_known_coverage() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM evidence_events WHERE id=NEW.event_id AND coverage='UNKNOWN') THEN
        RAISE EXCEPTION 'Unknown coverage cannot assert exact rows';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql""")
    op.execute('CREATE TRIGGER check_known_coverage BEFORE INSERT ON evidence_coverage '
               'FOR EACH ROW EXECUTE FUNCTION dogtags_check_known_coverage()')


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM output_stages "
                                   "WHERE name='ADD' AND depends_on_id IS NULL)")):
        raise RuntimeError('Standalone ADD stages require a data-preserving forward migration.')
    if any(op.get_bind().scalar(sa.text(f'SELECT EXISTS (SELECT 1 FROM {name})')) for name in TABLES):
        raise RuntimeError('External history requires a data-preserving forward migration.')
    for name in reversed(TABLES):
        op.drop_table(name)
    op.execute('DROP FUNCTION dogtags_check_resolution_coverage()')
    op.execute('DROP FUNCTION dogtags_check_known_coverage()')
    op.drop_constraint('uq_stage_artifact_identity', 'stage_artifacts', type_='unique')
    op.drop_constraint('uq_artifact_set_manifest_identity', 'artifact_sets', type_='unique')
    op.drop_constraint(op.f('ck_output_stages_change_stage_order'), 'output_stages', type_='check')
    op.create_check_constraint('change_stage_order', 'output_stages',
        "(name = 'DELETE' AND depends_on_id IS NULL) OR "
        "(name = 'ADD' AND depends_on_id IS NOT NULL AND depends_on_id <> id)")
