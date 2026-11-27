"""Private durable upload publication intent, separate from public operation result."""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = '0004'
down_revision = '0003'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('operations', sa.Column('private_pending', JSONB(), nullable=True))


def downgrade():
    if op.get_bind().scalar(sa.text('SELECT EXISTS (SELECT 1 FROM operations WHERE private_pending IS NOT NULL)')):
        raise RuntimeError('Pending upload receipts require a data-preserving forward migration.')
    op.drop_column('operations', 'private_pending')
