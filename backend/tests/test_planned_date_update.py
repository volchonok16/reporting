import asyncio
from datetime import date
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.models import Task
from app.planned_date_service import update_task_planned_date
from app.tfs_client import build_target_date_patch


def test_build_target_date_patch_set() -> None:
    ops = build_target_date_patch(date(2026, 8, 11))
    assert ops == [
        {
            "op": "add",
            "path": "/fields/Microsoft.VSTS.Scheduling.TargetDate",
            "value": "2026-08-11",
        }
    ]


def test_build_target_date_patch_clear() -> None:
    ops = build_target_date_patch(None)
    assert ops == [{"op": "remove", "path": "/fields/Microsoft.VSTS.Scheduling.TargetDate"}]


def test_update_task_planned_date_writes_tfs_and_db() -> None:
    async def run() -> None:
        task = Task(
            id=42,
            source_system_id=1,
            project_id=1,
            external_id="999516",
            title="Test",
            task_type="change_request",
            source_team="B2B Product",
            extra_json={"board_code": "b2b_product_core"},
        )

        class FakeSession:
            def get(self, _model, task_id):
                assert task_id == 42
                return task

            def add(self, _task):
                return None

            def commit(self):
                return None

            def refresh(self, _task):
                return None

        mock_client = AsyncMock()
        mock_client.update_target_date = AsyncMock(return_value={})
        mock_client.close = AsyncMock()

        with patch("app.planned_date_service.TfsClient", return_value=mock_client):
            result = await update_task_planned_date(
                FakeSession(),
                task_id=42,
                planned_date=date(2026, 9, 1),
                pat="token",
            )

        mock_client.update_target_date.assert_awaited_once_with(999516, date(2026, 9, 1))
        assert task.release_date == date(2026, 9, 1)
        assert task.extra_json["planned_date"] == "2026-09-01"
        assert task.extra_json["plan_quarter"] == "2026-Q3"
        assert result.plannedDate == date(2026, 9, 1)
        assert result.planQuarter == "Q3 2026"

    asyncio.run(run())


def test_update_task_planned_date_not_found() -> None:
    async def run() -> None:
        class FakeSession:
            def get(self, _model, _task_id):
                return None

        with pytest.raises(HTTPException) as exc:
            await update_task_planned_date(
                FakeSession(),
                task_id=1,
                planned_date=date(2026, 1, 1),
                pat="token",
            )
        assert exc.value.status_code == 404

    asyncio.run(run())
