"""Saved user choices for WhiteMAV INN."""
from alembic import op
import sqlalchemy as sa

revision = '0012'
down_revision = '0011'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('whitemav_inns',
        sa.Column('id', sa.Uuid(), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('owner_id', sa.Uuid(), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('inn', sa.String(12), nullable=False),
        sa.UniqueConstraint('owner_id', 'inn'),
        sa.CheckConstraint("inn ~ '^([0-9]{10}|[0-9]{12})$'", name='inn_digits'))


def downgrade():
    if op.get_bind().scalar(sa.text('SELECT EXISTS (SELECT 1 FROM whitemav_inns)')):
        raise RuntimeError('Saved WhiteMAV INN choices would be lost by downgrade.')
    op.drop_table('whitemav_inns')
