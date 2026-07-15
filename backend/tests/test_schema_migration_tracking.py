from __future__ import annotations

from unittest.mock import MagicMock

from app.db import _applied_migrations, _mark_migration_applied


def test_applied_migrations_reads_names() -> None:
    conn = MagicMock()
    conn.execute.return_value = [("031_revenue_activities.sql",), ("035_revenue_activities_filters_columns.sql",)]
    assert _applied_migrations(conn) == {
        "031_revenue_activities.sql",
        "035_revenue_activities_filters_columns.sql",
    }


def test_mark_migration_applied_inserts_name() -> None:
    conn = MagicMock()
    _mark_migration_applied(conn, "035_revenue_activities_filters_columns.sql")
    assert conn.execute.called
    sql = str(conn.execute.call_args.args[0])
    assert "INSERT INTO schema_migration" in sql
    assert conn.execute.call_args.args[1]["name"] == "035_revenue_activities_filters_columns.sql"
