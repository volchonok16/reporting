"""Persistent local accounts, immutable sources/revisions, and future processing metadata.

DDL is frozen in this migration and does not import live application models.
"""
import json
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

DDL = [
    """CREATE TABLE source_profile_versions (
	version VARCHAR(120) NOT NULL,
	config_hash VARCHAR(64) NOT NULL,
	snapshot JSONB NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_source_profile_versions PRIMARY KEY (id),
	CONSTRAINT uq_source_profile_versions_version UNIQUE (version)
)""",
    """CREATE TABLE users (
	username VARCHAR(120) NOT NULL,
	password_hash VARCHAR(512) NOT NULL,
	permissions JSONB NOT NULL,
	active BOOLEAN NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_users PRIMARY KEY (id),
	CONSTRAINT uq_users_username UNIQUE (username)
)""",
    """CREATE TABLE cases (
	owner_id UUID NOT NULL,
	title VARCHAR(240) NOT NULL,
	head_revision_id UUID,
	external_state VARCHAR(32) NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_cases PRIMARY KEY (id),
	CONSTRAINT uq_cases_owner_id_id UNIQUE (owner_id, id),
	CONSTRAINT fk_cases_owner_id_users FOREIGN KEY(owner_id) REFERENCES users (id)
)""",
    """CREATE INDEX ix_cases_owner_id ON cases (owner_id)""",
    """CREATE TABLE sessions (
	token_digest VARCHAR(64) NOT NULL,
	csrf_token VARCHAR(128) NOT NULL,
	user_id UUID,
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
	revoked_at TIMESTAMP WITH TIME ZONE,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_sessions PRIMARY KEY (id),
	CONSTRAINT uq_sessions_token_digest UNIQUE (token_digest),
	CONSTRAINT fk_sessions_user_id_users FOREIGN KEY(user_id) REFERENCES users (id)
)""",
    """CREATE INDEX ix_sessions_user_id ON sessions (user_id)""",
    """CREATE TABLE operations (
	owner_id UUID NOT NULL,
	case_id UUID,
	action VARCHAR(80) NOT NULL,
	client_operation_id UUID NOT NULL,
	request_digest VARCHAR(64) NOT NULL,
	status VARCHAR(24) NOT NULL,
	result JSONB,
	error JSONB,
	completed_at TIMESTAMP WITH TIME ZONE,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_operations PRIMARY KEY (id),
	CONSTRAINT fk_operation_owner_case FOREIGN KEY(owner_id, case_id) REFERENCES cases (owner_id, id),
	CONSTRAINT uq_operations_scope_key UNIQUE NULLS NOT DISTINCT (owner_id, case_id, action, client_operation_id),
	CONSTRAINT ck_operations_status CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
	CONSTRAINT fk_operations_owner_id_users FOREIGN KEY(owner_id) REFERENCES users (id)
)""",
    """CREATE INDEX ix_operations_owner_id ON operations (owner_id)""",
    """CREATE TABLE source_assets (
	case_id UUID NOT NULL,
	created_by UUID NOT NULL,
	filename VARCHAR(240) NOT NULL,
	encoding VARCHAR(16) NOT NULL,
	sha256 VARCHAR(64) NOT NULL,
	size_bytes BIGINT NOT NULL,
	storage_key VARCHAR(160) NOT NULL,
	inspection JSONB NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_source_assets PRIMARY KEY (id),
	CONSTRAINT uq_source_assets_case_id_id UNIQUE (case_id, id),
	CONSTRAINT ck_source_assets_size_nonnegative CHECK (size_bytes >= 0),
	CONSTRAINT ck_source_assets_explicit_encoding CHECK (encoding IN ('utf-8','cp1251')),
	CONSTRAINT ck_source_assets_sha256_format CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT fk_source_assets_case_id_cases FOREIGN KEY(case_id) REFERENCES cases (id),
	CONSTRAINT fk_source_assets_created_by_users FOREIGN KEY(created_by) REFERENCES users (id)
)""",
    """CREATE INDEX ix_source_assets_case_id ON source_assets (case_id)""",
    """CREATE TABLE processing_revisions (
	case_id UUID NOT NULL,
	source_asset_id UUID NOT NULL,
	parent_revision_id UUID,
	sequence INTEGER NOT NULL,
	created_by UUID NOT NULL,
	profile_version_id UUID NOT NULL,
	profile_snapshot JSONB NOT NULL,
	settings JSONB NOT NULL,
	correction_overlay JSONB NOT NULL,
	config_hash VARCHAR(64) NOT NULL,
	rules_version VARCHAR(120) NOT NULL,
	serializer_version VARCHAR(120) NOT NULL,
	export_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
	export_timezone VARCHAR(120) NOT NULL,
	filename_components JSONB NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_processing_revisions PRIMARY KEY (id),
	CONSTRAINT uq_processing_revisions_case_id_id UNIQUE (case_id, id),
	CONSTRAINT uq_processing_revisions_case_sequence UNIQUE (case_id, sequence),
	CONSTRAINT fk_revision_source_in_case FOREIGN KEY(case_id, source_asset_id) REFERENCES source_assets (case_id, id),
	CONSTRAINT fk_revision_parent_in_case FOREIGN KEY(case_id, parent_revision_id) REFERENCES processing_revisions (case_id, id),
	CONSTRAINT ck_processing_revisions_positive_sequence CHECK (sequence > 0),
	CONSTRAINT fk_processing_revisions_case_id_cases FOREIGN KEY(case_id) REFERENCES cases (id),
	CONSTRAINT fk_processing_revisions_created_by_users FOREIGN KEY(created_by) REFERENCES users (id),
	CONSTRAINT fk_processing_revisions_profile_version_id_source_profi_6aee FOREIGN KEY(profile_version_id) REFERENCES source_profile_versions (id)
)""",
    """CREATE INDEX ix_processing_revisions_case_id ON processing_revisions (case_id)""",
    """CREATE TABLE audit_events (
	case_id UUID,
	revision_id UUID,
	actor_id UUID NOT NULL,
	action VARCHAR(80) NOT NULL,
	operation_id UUID,
	details JSONB NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_audit_events PRIMARY KEY (id),
	CONSTRAINT fk_audit_events_case_id_cases FOREIGN KEY(case_id) REFERENCES cases (id),
	CONSTRAINT fk_audit_events_revision_id_processing_revisions FOREIGN KEY(revision_id) REFERENCES processing_revisions (id),
	CONSTRAINT fk_audit_events_actor_id_users FOREIGN KEY(actor_id) REFERENCES users (id),
	CONSTRAINT fk_audit_events_operation_id_operations FOREIGN KEY(operation_id) REFERENCES operations (id)
)""",
    """CREATE INDEX ix_audit_events_case_id ON audit_events (case_id)""",
    """CREATE TABLE processing_runs (
	case_id UUID NOT NULL,
	revision_id UUID NOT NULL,
	work_identity VARCHAR(64) NOT NULL,
	state VARCHAR(32) NOT NULL,
	attempt INTEGER NOT NULL,
	generation INTEGER NOT NULL,
	lease_token UUID,
	lease_expires_at TIMESTAMP WITH TIME ZONE,
	heartbeat_at TIMESTAMP WITH TIME ZONE,
	next_attempt_at TIMESTAMP WITH TIME ZONE,
	progress JSONB NOT NULL,
	summary JSONB NOT NULL,
	dataset_key VARCHAR(160),
	error JSONB,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_processing_runs PRIMARY KEY (id),
	CONSTRAINT fk_run_revision_in_case FOREIGN KEY(case_id, revision_id) REFERENCES processing_revisions (case_id, id),
	CONSTRAINT uq_processing_runs_case_id_id UNIQUE (case_id, id),
	CONSTRAINT uq_processing_runs_revision UNIQUE (revision_id),
	CONSTRAINT ck_processing_runs_nonnegative_attempt_generation CHECK (attempt >= 0 AND generation >= 0),
	CONSTRAINT fk_processing_runs_case_id_cases FOREIGN KEY(case_id) REFERENCES cases (id),
	CONSTRAINT uq_processing_runs_work_identity UNIQUE (work_identity)
)""",
    """CREATE TABLE artifact_sets (
	case_id UUID NOT NULL,
	revision_id UUID NOT NULL,
	run_id UUID NOT NULL,
	generation INTEGER NOT NULL,
	manifest JSONB NOT NULL,
	manifest_hash VARCHAR(64) NOT NULL,
	reconciliation JSONB NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_artifact_sets PRIMARY KEY (id),
	CONSTRAINT fk_artifactset_revision_in_case FOREIGN KEY(case_id, revision_id) REFERENCES processing_revisions (case_id, id),
	CONSTRAINT fk_artifactset_run_in_case FOREIGN KEY(case_id, run_id) REFERENCES processing_runs (case_id, id),
	CONSTRAINT uq_artifact_sets_case_id_id UNIQUE (case_id, id),
	CONSTRAINT uq_artifact_sets_revision UNIQUE (revision_id),
	CONSTRAINT fk_artifact_sets_case_id_cases FOREIGN KEY(case_id) REFERENCES cases (id),
	CONSTRAINT uq_artifact_sets_manifest_hash UNIQUE (manifest_hash)
)""",
    """CREATE TABLE outbox (
	run_id UUID NOT NULL,
	published_at TIMESTAMP WITH TIME ZONE,
	attempts INTEGER NOT NULL,
	next_attempt_at TIMESTAMP WITH TIME ZONE,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_outbox PRIMARY KEY (id),
	CONSTRAINT uq_outbox_run_id UNIQUE (run_id),
	CONSTRAINT fk_outbox_run_id_processing_runs FOREIGN KEY(run_id) REFERENCES processing_runs (id)
)""",
    """CREATE TABLE approvals (
	case_id UUID NOT NULL,
	revision_id UUID NOT NULL,
	artifact_set_id UUID NOT NULL,
	operation_id UUID NOT NULL,
	author_id UUID NOT NULL,
	manifest_hash VARCHAR(64) NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_approvals PRIMARY KEY (id),
	CONSTRAINT fk_approval_revision_in_case FOREIGN KEY(case_id, revision_id) REFERENCES processing_revisions (case_id, id),
	CONSTRAINT fk_approval_artifactset_in_case FOREIGN KEY(case_id, artifact_set_id) REFERENCES artifact_sets (case_id, id),
	CONSTRAINT fk_approvals_case_id_cases FOREIGN KEY(case_id) REFERENCES cases (id),
	CONSTRAINT uq_approvals_operation_id UNIQUE (operation_id),
	CONSTRAINT fk_approvals_operation_id_operations FOREIGN KEY(operation_id) REFERENCES operations (id),
	CONSTRAINT fk_approvals_author_id_users FOREIGN KEY(author_id) REFERENCES users (id)
)""",
    """CREATE TABLE artifacts (
	artifact_set_id UUID NOT NULL,
	role VARCHAR(32) NOT NULL,
	download_filename VARCHAR(240) NOT NULL,
	storage_key VARCHAR(160) NOT NULL,
	size_bytes BIGINT NOT NULL,
	sha256 VARCHAR(64) NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE NOT NULL,
	CONSTRAINT pk_artifacts PRIMARY KEY (id),
	CONSTRAINT uq_artifacts_set_role UNIQUE (artifact_set_id, role),
	CONSTRAINT fk_artifacts_artifact_set_id_artifact_sets FOREIGN KEY(artifact_set_id) REFERENCES artifact_sets (id)
)""",
    """CREATE INDEX ix_artifacts_artifact_set_id ON artifacts (artifact_set_id)""",
    """ALTER TABLE cases ADD CONSTRAINT fk_cases_head_in_case FOREIGN KEY(id, head_revision_id) REFERENCES processing_revisions (case_id, id) DEFERRABLE""",
]

IMMUTABLE_TABLES = ("source_assets", "source_profile_versions", "processing_revisions", "artifact_sets", "artifacts", "approvals", "audit_events")

def upgrade():
    for statement in DDL:
        op.execute(statement)
    op.execute("""CREATE FUNCTION dogtags_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'immutable record'; END; $$""")
    for table in IMMUTABLE_TABLES:
        op.execute(f"CREATE TRIGGER immutable_{table} BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION dogtags_reject_mutation()")
    op.execute(sa.text("INSERT INTO source_profile_versions (id, created_at, version, config_hash, snapshot) VALUES (CAST(:id AS uuid), now(), :version, :hash, CAST(:snapshot AS jsonb))").bindparams(
        id="11111111-1111-4111-8111-111111111111", version="hub-v1",
        hash="3a0dd1a59b3925ce3c3a60a032677e3b3b69df9d43b041010b353313d7aa01be", snapshot=json.dumps({"id": "hub-v1", "name": "RTK HUB", "SPREADING": "0", "INTERNAL_OPERATOR_NAME": "hubRTK"}, ensure_ascii=False)))


def downgrade():
    op.execute("ALTER TABLE cases DROP CONSTRAINT fk_cases_head_in_case")
    for table in ['artifacts', 'approvals', 'outbox', 'artifact_sets', 'processing_runs', 'audit_events', 'processing_revisions', 'source_assets', 'operations', 'sessions', 'cases', 'users', 'source_profile_versions']:
        op.execute(f"DROP TABLE {table}")
    op.execute("DROP FUNCTION dogtags_reject_mutation()")
