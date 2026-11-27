"""Publish GPBM defaults without changing existing immutable rule snapshots."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from uuid import uuid4

from alembic import op
import sqlalchemy as sa

revision = '0011'
down_revision = '0010'
branch_labels = None
depends_on = None


def upgrade():
    db = op.get_bind()
    db.execute(sa.text('SELECT pg_advisory_xact_lock(731946204)'))
    old = db.execute(sa.text('SELECT snapshot, created_by FROM rule_publications '
                            'ORDER BY publication_order DESC LIMIT 1')).mappings().first()
    if old is None or 'ГПБМ' in old['snapshot']['config']['profiles']:
        return
    config = deepcopy(old['snapshot']['config'])
    config['version'] = 'gpbm-migration-' + old['snapshot']['digest'][:24]
    config['profiles']['ГПБМ'] = {'SPREADING': '1', 'INTERNAL_OPERATOR_NAME': ''}
    digest = hashlib.sha256(json.dumps(config, ensure_ascii=False, sort_keys=True,
                                      separators=(',', ':')).encode()).hexdigest()
    snapshot = {'version': config['version'], 'digest': digest, 'config': config}
    metadata = sa.MetaData()
    publications = sa.Table('rule_publications', metadata, autoload_with=db)
    profiles = sa.Table('source_profile_versions', metadata, autoload_with=db)
    now = datetime.now(timezone.utc)
    db.execute(publications.insert().values(id=uuid4(), created_at=now, version=config['version'],
        digest=digest, snapshot=snapshot, created_by=old['created_by'],
        reason='Добавлен партнёр ГПБМ: SPREADING=1, пустое INTERNAL_OPERATOR_NAME'))
    for partner, values in config['profiles'].items():
        profile = {'id': f"{config['version']}:{partner}", 'partner': partner, **values,
                   'rule_version': config['version'], 'rule_digest': digest}
        db.execute(profiles.insert().values(id=uuid4(), created_at=now,
            version=f'rules:{digest}:{partner}', config_hash=digest, snapshot=profile))


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT EXISTS (SELECT 1 FROM rule_publications "
                                    "WHERE version LIKE 'gpbm-migration-%')")):
        raise RuntimeError('GPBM publication is immutable; use a forward migration to change partner rules.')
