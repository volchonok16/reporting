"""Persist operator database marks outside immutable export metadata."""
from alembic import op
import sqlalchemy as sa

revision = '0009'
down_revision = '0008'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('intakes', sa.Column('database_status', sa.String(16), nullable=False,
                                      server_default='IN_PROGRESS'))
    op.create_check_constraint('ck_intakes_database_status', 'intakes',
                               "database_status IN ('IN_PROGRESS', 'LOADED')")
    op.create_table('artifact_database_statuses',
        sa.Column('artifact_id', sa.Uuid(), sa.ForeignKey('artifacts.id'), primary_key=True),
        sa.Column('database_status', sa.String(16), nullable=False, server_default='IN_PROGRESS'),
        sa.CheckConstraint("database_status IN ('IN_PROGRESS', 'LOADED')", name='valid_database_status'))


def downgrade():
    for table in ('intakes', 'artifact_database_statuses'):
        if op.get_bind().scalar(sa.text(f"SELECT EXISTS (SELECT 1 FROM {table} WHERE database_status != 'IN_PROGRESS')")):
            raise RuntimeError('Database status marks would be lost by downgrade.')
    op.drop_table('artifact_database_statuses')
    op.drop_constraint('ck_intakes_database_status', 'intakes', type_='check')
    op.drop_column('intakes', 'database_status')
