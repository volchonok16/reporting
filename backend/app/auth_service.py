import httpx
from fastapi import HTTPException

from app.app_users import verify_app_user
from app.auth_sessions import create_session
from app.config import settings
from app.http_auth import auth_attempts
from app.schemas import AuthLoginOut
from app.tfs_auth import TfsAuth, build_tfs_auth
from app.tfs_client import TfsClient


async def probe_tfs(client: TfsClient) -> tuple[bool, int | None]:
    """Быстрая проверка PAT: один лёгкий запрос вместо цепочки из connectionData/projects/WIQL."""
    response = await client.client.get(
        "/_apis/projects",
        params={"$top": "1", "api-version": "5.1"},
    )
    status = response.status_code
    if status == 200:
        return True, status
    if status in {401, 403}:
        return False, status

    fallback = await client.client.get(
        "/_apis/connectionData",
        params={"connectOptions": "includeServices", "lastChangeId": "-1", "api-version": "5.0"},
    )
    status = fallback.status_code
    if status == 200:
        return True, status
    if status in {401, 403}:
        return False, status
    return False, status


async def resolve_working_auth(auth: TfsAuth) -> TfsAuth:
    attempts = auth_attempts(auth)
    if not attempts:
        raise HTTPException(status_code=400, detail="Укажите PAT-токен TFS.")

    errors: list[str] = []
    for attempt in attempts:
        client = TfsClient(attempt.auth, timeout=settings.tfs_auth_probe_timeout_seconds)
        try:
            ok, status = await probe_tfs(client)
            if ok:
                return attempt.auth
            errors.append(f"{attempt.label}: HTTP {status or '?'}")
        except httpx.HTTPError as exc:
            errors.append(f"{attempt.label}: {exc}")
        finally:
            await client.close()

    raise HTTPException(
        status_code=401,
        detail=(
            f"TFS не принял токен ({'; '.join(errors[:4])}). "
            "Создайте PAT: TFS → Personal access tokens → Work Items (Read)."
        ),
    )


async def login_with_pat(auth: TfsAuth) -> AuthLoginOut:
    resolved = await resolve_working_auth(auth)
    session_id = create_session(resolved, auth_mode="pat")
    return AuthLoginOut(sessionId=session_id, authMode="pat")


async def login_with_app_user(
    *,
    username: str,
    password: str,
    base_url: str | None = None,
    project: str | None = None,
    project_id: str | None = None,
) -> AuthLoginOut:
    login = username.strip()
    if not login or not password:
        raise HTTPException(status_code=400, detail="Укажите логин и пароль.")

    users = settings.app_auth_users_map
    if not users:
        raise HTTPException(status_code=500, detail="Пользователи приложения не настроены (APP_AUTH_USERS).")
    if not verify_app_user(users, login, password):
        raise HTTPException(status_code=401, detail="Неверный логин или пароль.")

    sync_pat = settings.tfs_sync_pat.strip()
    if not sync_pat:
        raise HTTPException(status_code=500, detail="TFS_SYNC_PAT не настроен на сервере.")

    auth = build_tfs_auth(
        base_url=base_url,
        project=project,
        project_id=project_id,
        pat=sync_pat,
    )
    session_id = create_session(auth, auth_mode="app_user", app_login=login)
    return AuthLoginOut(sessionId=session_id, authMode="app_user", username=login)
