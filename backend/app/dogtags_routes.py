"""Authenticated streaming gateway to the configured Dogtags installation."""
from http.cookies import SimpleCookie

import anyio
import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from app.app_access import require_app_page
from app.config import settings

router = APIRouter(prefix="/api/dogtags-manager", dependencies=[Depends(require_app_page("dogtags-manager"))])


@router.api_route("/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
async def dogtags_proxy(path: str, request: Request):
    base = settings.dogtags_manager_url.strip().rstrip("/")
    if not base:
        return JSONResponse({"error": {"code": "dogtags_not_configured", "message": "Подключение Dogtags Manager ещё не настроено."}}, status_code=503)
    if any(part in {".", ".."} for part in path.split("/")) or "\\" in path:
        return JSONResponse({"error": {"code": "invalid_path", "message": "Некорректный путь запроса."}}, status_code=400)

    # Keep Reporting credentials out of Dogtags, and retain its own CSRF policy.
    origin = settings.dogtags_manager_origin.rstrip("/")
    upstream_origin = httpx.URL(origin)
    headers = {"Host": upstream_origin.netloc.decode(), "Origin": origin,
               "X-Forwarded-Proto": upstream_origin.scheme, "Accept-Encoding": "identity"}
    for name in ("content-type", "content-length", "x-csrf-token", "x-operation-id", "accept", "range", "if-range"):
        if value := request.headers.get(name):
            headers[name] = value
    if token := request.cookies.get("dogtags_session"):
        cookie = SimpleCookie()
        cookie["dogtags_session"] = token
        headers["Cookie"] = cookie.output(header="").strip()

    client = httpx.AsyncClient(timeout=httpx.Timeout(300, connect=5), follow_redirects=False)
    upstream = None

    async def close():
        with anyio.CancelScope(shield=True):
            if upstream is not None:
                await upstream.aclose()
            await client.aclose()

    try:
        url = httpx.URL(f"{base}/api/{path}", query=request.url.query.encode())
        upstream = await client.send(client.build_request(request.method, url, headers=headers, content=request.stream()), stream=True)
    except httpx.RequestError:
        await close()
        return JSONResponse({"error": {"code": "dogtags_unavailable", "message": "Dogtags Manager недоступен. Проверьте подключение к его API и состояние сервисов обработки.", "retryable": True}}, status_code=502)

    except BaseException:
        await close()
        raise

    async def body():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await close()

    response_headers = {name: value for name, value in upstream.headers.items() if name in {
        "content-type", "content-length", "content-disposition", "content-range", "accept-ranges", "etag", "content-encoding",
    }}
    response_headers["Cache-Control"] = "no-store"
    response = StreamingResponse(body(), status_code=upstream.status_code, headers=response_headers, background=BackgroundTask(close))
    for value in upstream.headers.get_list("set-cookie"):
        cookie = SimpleCookie()
        cookie.load(value)
        if "dogtags_session" in cookie:
            item = cookie["dogtags_session"]
            item["path"] = "/api/dogtags-manager"
            item["domain"] = ""
            response.raw_headers.append((b"set-cookie", item.OutputString().encode("latin1")))
    return response
