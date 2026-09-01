import asyncio
from unittest.mock import AsyncMock, MagicMock

from app.config import settings
from app.tfs_client import TfsClient, wiql_quote


async def _run_product_links_test(client: TfsClient, area_path: str) -> None:
    result = await client.get_product_zni_links_for_area(area_path)
    assert result == {200: 100, 201: 101}

    call_args = client.run_wiql.call_args
    query = call_args[0][0]
    project = wiql_quote(client.project)
    area = wiql_quote(area_path)
    change_types = ", ".join(wiql_quote(item) for item in settings.change_type_list)
    product_type = wiql_quote(settings.product_type_list[0])
    normalized = " ".join(query.split())
    assert (
        f"WHERE ([Source].[System.TeamProject] = {project} "
        f"AND [Source].[System.WorkItemType] = {product_type} "
        f"AND [Source].[System.AreaPath] UNDER {area}) "
        f"AND ([Target].[System.TeamProject] = {project} "
        f"AND [Target].[System.WorkItemType] IN ({change_types})) "
        "ORDER BY [System.Id] MODE (MustContain)"
    ) in normalized


def test_get_product_zni_links_wiql_matches_har() -> None:
    auth = MagicMock()
    auth.has_credentials.return_value = True
    auth.project = "Tele2"
    auth.project_id = "proj"
    auth.base_url = "https://tfs.example/tfs"
    auth.cookie = None
    auth.extra_headers = None

    client = TfsClient(auth)
    client.run_wiql = AsyncMock(
        return_value={
            "workItemRelations": [
                {"source": {"id": 100}, "target": {"id": 200}},
                {"source": {"id": 101}, "target": {"id": 201}},
            ]
        }
    )

    asyncio.run(_run_product_links_test(client, settings.product_area_path))
