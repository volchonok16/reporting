from collections.abc import Generator
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


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


def ensure_auth_session_table() -> None:
    with engine.connect() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS auth_session (
                    id VARCHAR(64) PRIMARY KEY,
                    payload JSONB NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
        )
        conn.commit()


def ensure_org_tables() -> None:
    for migration_name in ("005_org_structure.sql", "006_vacation_schedule.sql"):
        candidates = [
            Path(__file__).resolve().parents[2] / "db" / "migrations" / migration_name,
            Path(__file__).resolve().parents[1] / "migrations" / migration_name,
        ]
        migration_path = next((path for path in candidates if path.is_file()), None)
        if migration_path is None:
            continue
        sql = migration_path.read_text(encoding="utf-8")
        with engine.connect() as conn:
            conn.execute(text(sql))
            conn.commit()


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def close_db_session(db: Session | None) -> None:
    if db is not None:
        db.close()
