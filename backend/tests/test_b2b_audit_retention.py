from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

from app.b2b_audit_retention import purge_old_b2b_audit_records


def test_purge_old_b2b_audit_records_deletes_from_all_tables(monkeypatch) -> None:
    monkeypatch.setattr("app.b2b_audit_retention.settings.b2b_audit_retention_days", 28)
    db = MagicMock()
    db.execute.side_effect = [
        MagicMock(rowcount=3),
        MagicMock(rowcount=1),
        MagicMock(rowcount=0),
        MagicMock(rowcount=2),
    ]

    deleted = purge_old_b2b_audit_records(db)

    assert deleted == {
        "b2b_product_status_history": 3,
        "b2b_product_status_snapshot": 1,
        "b2b_news_history": 0,
        "b2b_news_snapshot": 2,
    }
    assert db.execute.call_count == 4
    db.commit.assert_called_once()

    cutoff = db.execute.call_args_list[0].args[1]["cutoff"]
    assert cutoff < datetime.now(UTC)
    assert cutoff > datetime.now(UTC) - timedelta(days=29)

    for call in db.execute.call_args_list:
        sql = str(call.args[0])
        assert "DELETE FROM" in sql
        assert "b2b_product_status_row" not in sql
        assert "b2b_news_row" not in sql


def test_purge_respects_minimum_retention_days(monkeypatch) -> None:
    monkeypatch.setattr("app.b2b_audit_retention.settings.b2b_audit_retention_days", 0)
    db = MagicMock()
    db.execute.side_effect = [MagicMock(rowcount=0)] * 4

    purge_old_b2b_audit_records(db)

    cutoff = db.execute.call_args_list[0].args[1]["cutoff"]
    assert cutoff < datetime.now(UTC)
    assert cutoff > datetime.now(UTC) - timedelta(days=2)
