"""Immutable explicit CHANGE scope and linked output stages; v1 rows stay untouched."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None


def identity():
    return [sa.Column('id', UUID(), primary_key=True),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False)]


def upgrade():
    op.create_unique_constraint('uq_artifacts_set_id', 'artifacts', ['artifact_set_id', 'id'])
    op.create_unique_constraint('uq_artifact_sets_case_revision_id', 'artifact_sets', ['case_id', 'revision_id', 'id'])
    op.create_table('change_scopes', *identity(),
        sa.Column('owner_id', UUID(), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('case_id', UUID(), nullable=False), sa.Column('revision_id', UUID(), nullable=False, unique=True),
        sa.Column('source_case_id', UUID(), nullable=False),
        sa.Column('source_artifact_set_id', UUID(), nullable=False), sa.Column('source_artifact_id', UUID(), nullable=False),
        sa.Column('snapshot', JSONB(), nullable=False), sa.Column('digest', sa.String(64), nullable=False),
        sa.ForeignKeyConstraint(['owner_id', 'case_id'], ['cases.owner_id', 'cases.id']),
        sa.ForeignKeyConstraint(['owner_id', 'source_case_id'], ['cases.owner_id', 'cases.id'], name='fk_change_scope_source_owner'),
        sa.ForeignKeyConstraint(['case_id', 'revision_id'], ['processing_revisions.case_id', 'processing_revisions.id']),
        sa.ForeignKeyConstraint(['source_case_id', 'source_artifact_set_id'], ['artifact_sets.case_id', 'artifact_sets.id']),
        sa.ForeignKeyConstraint(['source_artifact_set_id', 'source_artifact_id'], ['artifacts.artifact_set_id', 'artifacts.id']))
    op.create_table('output_stages', *identity(),
        sa.Column('case_id', UUID(), nullable=False), sa.Column('revision_id', UUID(), nullable=False),
        sa.Column('artifact_set_id', UUID(), nullable=False), sa.Column('name', sa.String(32), nullable=False),
        sa.Column('depends_on_id', UUID(), nullable=True),
        sa.UniqueConstraint('artifact_set_id', 'id', name='uq_output_stages_set_id'),
        sa.UniqueConstraint('artifact_set_id', 'name', name='uq_output_stages_set_name'),
        sa.ForeignKeyConstraint(['case_id', 'revision_id', 'artifact_set_id'],
            ['artifact_sets.case_id', 'artifact_sets.revision_id', 'artifact_sets.id']),
        sa.ForeignKeyConstraint(['artifact_set_id', 'depends_on_id'], ['output_stages.artifact_set_id', 'output_stages.id']),
        sa.CheckConstraint("(name = 'DELETE' AND depends_on_id IS NULL) OR "
                           "(name = 'ADD' AND depends_on_id IS NOT NULL AND depends_on_id <> id)", name='change_stage_order'))
    op.create_table('stage_artifacts', *identity(),
        sa.Column('artifact_set_id', UUID(), nullable=False), sa.Column('stage_id', UUID(), nullable=False),
        sa.Column('artifact_id', UUID(), nullable=False, unique=True),
        sa.ForeignKeyConstraint(['artifact_set_id', 'stage_id'], ['output_stages.artifact_set_id', 'output_stages.id']),
        sa.ForeignKeyConstraint(['artifact_set_id', 'artifact_id'], ['artifacts.artifact_set_id', 'artifacts.id']))
    for table in ('change_scopes', 'output_stages', 'stage_artifacts'):
        op.execute(f'CREATE TRIGGER immutable_{table} BEFORE UPDATE OR DELETE ON {table} '
                   'FOR EACH ROW EXECUTE FUNCTION dogtags_reject_mutation()')


def downgrade():
    for table in ('stage_artifacts', 'output_stages', 'change_scopes'):
        if op.get_bind().scalar(sa.text(f'SELECT EXISTS (SELECT 1 FROM {table})')):
            raise RuntimeError('CHANGE history requires a data-preserving forward migration.')
    for table in ('stage_artifacts', 'output_stages', 'change_scopes'):
        op.drop_table(table)
    op.drop_constraint('uq_artifact_sets_case_revision_id', 'artifact_sets', type_='unique')
    op.drop_constraint('uq_artifacts_set_id', 'artifacts', type_='unique')
