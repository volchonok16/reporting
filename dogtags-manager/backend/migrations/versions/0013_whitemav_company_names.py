"""Company names for the user's WhiteMAV INN directory."""
from alembic import op
import sqlalchemy as sa

revision = '0013'
down_revision = '0012'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('whitemav_inns', sa.Column('company_name', sa.String(500), nullable=False, server_default=''))


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM whitemav_inns WHERE company_name <> '')")):
        raise RuntimeError('Saved company names would be lost by downgrade.')
    op.drop_column('whitemav_inns', 'company_name')
