"""Reference mnemonic names; published profiles remain immutable snapshots."""
from datetime import datetime, timezone
from uuid import uuid4

from alembic import op
import sqlalchemy as sa

revision = '0010'
down_revision = '0009'
branch_labels = None
depends_on = None


def upgrade():
    table = op.create_table('processing_mnemonics',
        sa.Column('id', sa.Uuid(), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('code', sa.String(120), nullable=False, unique=True),
        sa.Column('description', sa.String(500), nullable=False))
    names = {'hubRTK': 'RTK HUB', 'fRTK': 'RTK ABC', 'none': 'RTK MVNO'}
    snapshot = op.get_bind().scalar(sa.text(
        'SELECT snapshot FROM rule_publications ORDER BY publication_order DESC LIMIT 1'))
    for partner, profile in (snapshot or {}).get('config', {}).get('profiles', {}).items():
        names.setdefault(profile['INTERNAL_OPERATOR_NAME'], partner)
    op.bulk_insert(table, [{'id': uuid4(), 'created_at': datetime.now(timezone.utc),
                           'code': code, 'description': description} for code, description in names.items()])


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM audit_events WHERE action LIKE 'dictionary.%')")):
        raise RuntimeError('Saved dictionary changes would be lost by downgrade.')
    op.drop_table('processing_mnemonics')
