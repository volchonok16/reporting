from uuid import uuid4

from app.errors import ApiError, error_response
from app.settings import loopback_host


class IngressMiddleware:
    """Count ASGI bytes before multipart spooling, independently of Content-Length."""
    def __init__(self, app, settings):
        self.app, self.settings = app, settings

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        scope.setdefault("state", {})["trace_id"] = str(uuid4())
        headers = dict(scope["headers"])
        host = headers.get(b"host", b"").decode("latin1").split(":")[0]
        if headers.get(b"host", b"").startswith(b"["):
            host = headers[b"host"].decode("latin1").split("]")[0][1:]
        if scope.get("scheme") == "http" and not loopback_host(host):
            return await error_response(ApiError(403, "https_required", "HTTP разрешён только на loopback."))(
                scope, receive, send)
        limit = self.settings.max_upload_bytes + self.settings.multipart_overhead_bytes
        declared = None
        if b"content-length" in headers:
            try:
                declared = int(headers[b"content-length"])
                if declared < 0:
                    raise ValueError
            except ValueError:
                return await error_response(ApiError(400, "invalid_body_length", "Неверная длина запроса."))(
                    scope, receive, send)
            if declared > limit:
                return await error_response(ApiError(413, "request_too_large", "Размер запроса превышает лимит."))(
                    scope, receive, send)
        total = 0
        body_complete = scope["method"] in {"GET", "HEAD"} and declared in {None, 0}

        async def counted_receive():
            nonlocal total, body_complete
            message = await receive()
            if message["type"] == "http.disconnect" and not body_complete:
                raise ApiError(400, "incomplete_upload", "Передача файла не завершена.", retryable=True)
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > limit:
                    raise ApiError(413, "request_too_large", "Размер запроса превышает лимит.")
                if not message.get("more_body", False) and declared is not None and total != declared:
                    raise ApiError(400, "body_length_mismatch", "Фактическая длина запроса не совпадает с заявленной.")
                if not message.get("more_body", False):
                    body_complete = True
            return message

        await self.app(scope, counted_receive, send)
