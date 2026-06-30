from collections.abc import Generator
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings

# Serialize startup DDL when uvicorn runs multiple workers (see docker-compose.prod.yml).
_STARTUP_MIGRATION_LOCK_ID = 847291736


class Base(DeclarativeBase):
    pass


engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
    pool_timeout=60,
    pool_recycle=1800,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def _is_duplicate_pg_type_error(exc: IntegrityError) -> bool:
    orig = exc.orig
    if orig is None:
        return False
    return getattr(orig, "sqlstate", None) == "23505" and "pg_type_typname_nsp_index" in str(orig)


def _execute_startup_sql(conn, sql: str) -> None:
    try:
        conn.execute(text(sql))
    except IntegrityError as exc:
        # Another worker may have won a concurrent CREATE TABLE IF NOT EXISTS race.
        if _is_duplicate_pg_type_error(exc):
            return
        raise


def ensure_startup_schema() -> None:
    """Idempotent DDL on app startup. Safe with multiple uvicorn workers."""
    org_migration_names = ("005_org_structure.sql", "006_vacation_schedule.sql")
    org_migrations: list[str] = []
    for migration_name in org_migration_names:
        candidates = [
            Path(__file__).resolve().parents[2] / "db" / "migrations" / migration_name,
            Path(__file__).resolve().parents[1] / "migrations" / migration_name,
        ]
        migration_path = next((path for path in candidates if path.is_file()), None)
        if migration_path is not None:
            org_migrations.append(migration_path.read_text(encoding="utf-8"))

    auth_session_sql = """
        CREATE TABLE IF NOT EXISTS auth_session (
            id VARCHAR(64) PRIMARY KEY,
            payload JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """

    with engine.connect() as conn:
        with conn.begin():
            conn.execute(
                text("SELECT pg_advisory_xact_lock(:lock_id)"),
                {"lock_id": _STARTUP_MIGRATION_LOCK_ID},
            )
            _execute_startup_sql(conn, auth_session_sql)
            for sql in org_migrations:
                _execute_startup_sql(conn, sql)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def close_db_session(db: Session | None) -> None:
    if db is not None:
        db.close()
