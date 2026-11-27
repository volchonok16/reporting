from alembic import context

from app.db import make_engine
from app.models import Base
from app.settings import Settings

config = context.config


def run_migrations(connection):
    context.configure(connection=connection, target_metadata=Base.metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    context.configure(url=Settings.from_environment().database_url, target_metadata=Base.metadata,
                      literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()
elif config.attributes.get("connection") is not None:
    run_migrations(config.attributes["connection"])
else:
    engine = make_engine(Settings.from_environment().database_url)
    with engine.connect() as connection:
        run_migrations(connection)
    engine.dispose()
