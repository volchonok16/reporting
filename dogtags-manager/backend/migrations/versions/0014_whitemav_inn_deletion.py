"""Remove INNs from the user's choices without changing saved processing versions."""
from alembic import op
import sqlalchemy as sa

revision = '0014'
down_revision = '0013'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('whitemav_inns', sa.Column('is_deleted', sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade():
    if op.get_bind().scalar(sa.text('SELECT EXISTS (SELECT 1 FROM whitemav_inns WHERE is_deleted)')):
        raise RuntimeError('Deleted WhiteMAV INNs would reappear after downgrade.')
    op.drop_column('whitemav_inns', 'is_deleted')
