from collections.abc import Generator
import logging
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings

logger = logging.getLogger(__name__)

# Serialize startup DDL when uvicorn runs multiple workers (see docker-compose.prod.yml).
_STARTUP_MIGRATION_LOCK_ID = 847291736
_B2B_AUDIT_RETENTION_LOCK_ID = 847291737


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


def _ensure_app_user_grants(conn) -> None:
    """Права alex/ivan на все таблицы (в т.ч. org), созданные при старте backend."""
    object_grants = [
        "GRANT USAGE, CREATE ON SCHEMA public TO alex, ivan",
        "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO alex, ivan",
        "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO alex, ivan",
        "GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO alex, ivan",
    ]
    reporting_default_privileges = [
        "ALTER DEFAULT PRIVILEGES FOR ROLE reporting IN SCHEMA public "
        "GRANT ALL PRIVILEGES ON TABLES TO alex, ivan",
        "ALTER DEFAULT PRIVILEGES FOR ROLE reporting IN SCHEMA public "
        "GRANT ALL PRIVILEGES ON SEQUENCES TO alex, ivan",
        "ALTER DEFAULT PRIVILEGES FOR ROLE reporting IN SCHEMA public "
        "GRANT ALL PRIVILEGES ON ROUTINES TO alex, ivan",
    ]
    alex_default_privileges = [
        "ALTER DEFAULT PRIVILEGES FOR ROLE alex IN SCHEMA public "
        "GRANT ALL PRIVILEGES ON TABLES TO alex, ivan",
        "ALTER DEFAULT PRIVILEGES FOR ROLE alex IN SCHEMA public "
        "GRANT ALL PRIVILEGES ON SEQUENCES TO alex, ivan",
        "ALTER DEFAULT PRIVILEGES FOR ROLE alex IN SCHEMA public "
        "GRANT ALL PRIVILEGES ON ROUTINES TO alex, ivan",
    ]

    current_user = conn.execute(text("SELECT current_user")).scalar_one()
    can_set_reporting = bool(
        conn.execute(
            text("SELECT pg_has_role(:user, 'reporting', 'member')"),
            {"user": current_user},
        ).scalar_one()
    )

    def _run_statements(statements: list[str]) -> None:
        for stmt in statements:
            conn.execute(text(stmt))

    try:
        if current_user == "reporting":
            _run_statements(object_grants + reporting_default_privileges)
        elif can_set_reporting:
            conn.execute(text("SET LOCAL ROLE reporting"))
            try:
                _run_statements(object_grants + reporting_default_privileges)
            finally:
                conn.execute(text("RESET ROLE"))
        else:
            _run_statements(object_grants)
            logger.warning(
                "Пользователь %s не член роли reporting — default privileges reporting "
                "не обновлены; выполните: bash scripts/grant-db-users.sh",
                current_user,
            )

        if current_user == "alex":
            _run_statements(alex_default_privileges)

        logger.info("Права alex/ivan на объекты public обновлены")
    except DBAPIError:
        logger.warning(
            "Не удалось выдать права от reporting — выполните bash scripts/grant-db-users.sh",
            exc_info=True,
        )
        try:
            conn.execute(text("RESET ROLE"))
        except DBAPIError:
            pass


def ensure_startup_schema() -> None:
    """Idempotent DDL on app startup. Safe with multiple uvicorn workers."""
    org_migration_names = (
        "005_org_structure.sql",
        "006_vacation_schedule.sql",
        "008_workspace_booking.sql",
        "009_employee_office_days.sql",
        "010_org_chart_layout.sql",
        "011_youjail.sql",
        "013_b2b_product_status.sql",
        "014_b2b_product_status_snapshots.sql",
        "015_b2b_news.sql",
        "016_b2b_product_status_merge_why_columns.sql",
        "017_youjail_boards_fuzzy.sql",
        "018_youjail_assignee.sql",
        "019_youjail_teams.sql",
        "020_youjail_tags.sql",
        "021_youjail_card_number.sql",
        "022_youjail_personal_board.sql",
        "023_youjail_board_member.sql",
        "024_youjail_card_zni.sql",
        "025_youjail_card_activity.sql",
        "026_youjail_card_comments.sql",
    )
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
            _ensure_app_user_grants(conn)


def purge_stale_b2b_audit_records() -> None:
    """Удаляет историю и снимки версий B2B старше срока хранения (при старте, один воркер)."""
    from app.b2b_audit_retention import purge_old_b2b_audit_records

    with engine.connect() as conn:
        with conn.begin():
            conn.execute(
                text("SELECT pg_advisory_xact_lock(:lock_id)"),
                {"lock_id": _B2B_AUDIT_RETENTION_LOCK_ID},
            )
            session = Session(bind=conn)
            try:
                purge_old_b2b_audit_records(session)
            finally:
                session.close()


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def close_db_session(db: Session | None) -> None:
    if db is not None:
        db.close()
