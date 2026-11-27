"""Initialize only this installation; preserve existing published rules and data."""
from alembic import command
from alembic.config import Config

from app.admin.publish_rules import active_snapshot, publish_rules
from app.auth.accounts import local_operator
from app.db import make_engine, make_session_factory
from app.domain.rules import seed_config
from app.settings import Settings


def main():
    command.upgrade(Config('alembic.ini'), 'head')
    engine = make_engine(Settings.from_environment().database_url)
    try:
        with make_session_factory(engine)() as db:
            if active_snapshot(db) is None:
                author = local_operator(db)
                publish_rules(db, author, seed_config(), reason='Initial Reporting Dogtags installation')
                db.commit()
    finally:
        engine.dispose()
    print('Dogtags schema and published processing rules are ready.')


if __name__ == '__main__':
    main()
