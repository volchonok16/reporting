import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from app.auth_service import login_with_app_user, probe_tfs, resolve_working_auth
from app.tfs_auth import TfsAuth


def _auth() -> TfsAuth:
    return TfsAuth(
        base_url="https://tfs.example/tfs/Main",
        project="Tele2",
        pat="secret",
    )


def test_probe_tfs_accepts_projects_200() -> None:
    client = MagicMock()
    client.client.get = AsyncMock(return_value=MagicMock(status_code=200))

    ok, status = asyncio.run(probe_tfs(client))

    assert ok is True
    assert status == 200
    client.client.get.assert_awaited_once()


def test_probe_tfs_rejects_401_without_wiql() -> None:
    client = MagicMock()
    client.client.get = AsyncMock(
        side_effect=[
            MagicMock(status_code=401),
            MagicMock(status_code=401),
        ]
    )

    ok, status = asyncio.run(probe_tfs(client))

    assert ok is False
    assert status == 401
    assert client.client.get.await_count == 1


def test_login_with_app_user_skips_tfs_probe() -> None:
    with (
        patch("app.auth_service.settings") as settings,
        patch("app.auth_service.verify_app_user", return_value=True),
        patch("app.auth_service.create_session", return_value="session-1") as create_session,
        patch("app.auth_service.resolve_working_auth", new_callable=AsyncMock) as resolve_auth,
    ):
        settings.app_auth_users_map = {"alice": "hash"}
        settings.tfs_sync_pat = "sync-pat"

        result = asyncio.run(
            login_with_app_user(
                username="alice",
                password="secret",
                project="Tele2",
            )
        )

    assert result.sessionId == "session-1"
    assert result.authMode == "app_user"
    resolve_auth.assert_not_awaited()
    create_session.assert_called_once()


def test_resolve_working_auth_uses_short_timeout_client() -> None:
    with patch("app.auth_service.TfsClient") as client_cls:
        instance = MagicMock()
        instance.client.get = AsyncMock(return_value=MagicMock(status_code=200))
        instance.close = AsyncMock()
        client_cls.return_value = instance

        auth = asyncio.run(resolve_working_auth(_auth()))

    assert auth.pat == "secret"
    client_cls.assert_called_once()
    assert client_cls.call_args.kwargs["timeout"] is not None
