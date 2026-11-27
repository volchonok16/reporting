"""Recoverable removal from Archive preserves source and external provenance."""
from alembic import op
import sqlalchemy as sa

revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('intakes', sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True))


def downgrade():
    if op.get_bind().scalar(sa.text('SELECT EXISTS (SELECT 1 FROM intakes WHERE deleted_at IS NOT NULL)')):
        raise RuntimeError('Restore deleted archive entries before removing deletion state.')
    op.drop_column('intakes', 'deleted_at')
