from unittest.mock import AsyncMock, MagicMock, patch

from app.business_value_service import update_business_value
from app.models import Task
from app.tfs_client import build_business_value_patch


def test_build_business_value_patch_sets_value() -> None:
    patch_ops = build_business_value_patch(35)
    assert patch_ops == [
        {"op": "add", "path": "/fields/Microsoft.VSTS.Common.BusinessValue", "value": 35},
    ]


def test_build_business_value_patch_clears_value() -> None:
    patch_ops = build_business_value_patch(None)
    assert patch_ops == [{"op": "remove", "path": "/fields/Microsoft.VSTS.Common.BusinessValue"}]


async def _run_update(value: int | None) -> Task:
    task = Task(
        id=1,
        source_system_id=1,
        external_id="1115252",
        project_id=1,
        title="Test ZNI",
        task_type="change_request",
        extra_json={"board_code": "digital_streams_b2b", "business_value": 10},
    )
    db = MagicMock()
    db.scalar.return_value = task

    with patch("app.business_value_service.TfsClient") as client_cls:
        client = client_cls.return_value
        client.patch_work_item = AsyncMock(return_value={})
        updated = await update_business_value(
            db,
            pat="token",
            external_id="1115252",
            value=value,
        )

    client.patch_work_item.assert_awaited_once()
    return updated


def test_update_business_value_patches_tfs_and_updates_db() -> None:
    import asyncio

    updated = asyncio.run(_run_update(35))
    assert updated.extra_json["business_value"] == 35


def test_update_business_value_clears_field() -> None:
    import asyncio

    updated = asyncio.run(_run_update(None))
    assert "business_value" not in (updated.extra_json or {})
