import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from app.tfs_auth import TfsAuth
from app.tfs_client import TfsClient


def _client() -> TfsClient:
    return TfsClient(
        TfsAuth(
            base_url="https://tfs.example/tfs/Main",
            project="Tele2",
            pat="token",
        )
    )


def test_error_batch_field_list_excludes_zni_only_fields() -> None:
    client = _client()
    fields = set(client._error_batch_field_list())
    assert "Logrocon.PO" not in fields
    assert "Microsoft.VSTS.Common.BusinessValue" not in fields
    assert "System.WorkItemType" in fields


def test_fetch_work_items_chunk_retries_without_fields_on_400() -> None:
    client = _client()
    bad = MagicMock(status_code=400, text="Unknown field")
    ok = MagicMock(status_code=200)
    ok.json.return_value = {"value": [{"id": 1, "fields": {"System.Title": "Err"}}]}

    with patch.object(client, "_post_with_api_versions", new_callable=AsyncMock) as post:
        post.side_effect = [bad, ok]
        items = asyncio.run(
            client._fetch_work_items_chunk(
                [1],
                fields=client._error_batch_field_list(),
                with_relations=False,
                allow_expand_retry=False,
            )
        )

    assert len(items) == 1
    assert post.await_count == 2
    assert "fields" not in post.await_args_list[1].kwargs["json"]
