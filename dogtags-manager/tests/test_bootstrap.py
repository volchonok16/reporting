"""Exercise bootstrap against an isolated PostgreSQL schema, never the live schema."""
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

from sqlalchemy import func, select, text

import bootstrap
from app.admin.publish_rules import active_snapshot, publish_rules
from app.auth.accounts import local_operator
from app.db import make_engine, make_session_factory
from app.domain.rules import seed_config
from app.models import RulePublication, User
from app.settings import Settings


class BootstrapTests(unittest.TestCase):
    def test_empty_install_and_restart_preserve_custom_rules_and_owner(self):
        admin = make_engine(Settings.from_environment().database_url)
        schema = 'test_reporting_bootstrap_' + uuid4().hex
        try:
            with admin.begin() as connection:
                connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            with patch.dict(os.environ, {'PGOPTIONS': f'-c search_path={schema}'}):
                bootstrap.main()
                engine = make_engine(Settings.from_environment().database_url)
                try:
                    sessions = make_session_factory(engine)
                    with sessions() as db:
                        self.assertEqual(db.execute(text('SELECT current_schema()')).scalar_one(), schema)
                        self.assertEqual(db.scalar(select(func.count()).select_from(RulePublication)), 1)
                        owner = local_operator(db)
                        owner_id = owner.id
                        custom = seed_config()
                        custom['version'] = 'bootstrap-preservation-test'
                        publication = publish_rules(db, owner, custom, reason='Synthetic bootstrap regression')
                        digest = publication.digest
                        db.commit()
                    bootstrap.main()
                    with sessions() as db:
                        self.assertEqual(active_snapshot(db)['digest'], digest)
                        self.assertEqual(db.scalar(select(func.count()).select_from(RulePublication)), 2)
                        self.assertEqual(db.scalar(select(func.count()).select_from(User)), 1)
                        self.assertEqual(local_operator(db).id, owner_id)
                finally:
                    engine.dispose()
        finally:
            with admin.begin() as connection:
                connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
            admin.dispose()


if __name__ == '__main__':
    unittest.main()
