from uuid import uuid4

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, *, retryable: bool = False,
                 operation_id: str | None = None):
        self.status, self.code, self.message = status, code, message
        self.retryable, self.operation_id = retryable, operation_id


def error_response(error: ApiError, trace_id: str | None = None):
    detail = {"code": error.code, "message": error.message, "retryable": error.retryable}
    if error.operation_id:
        detail["operation_id"] = error.operation_id
    return JSONResponse({"error": detail, "trace_id": trace_id or str(uuid4())}, status_code=error.status)


def install_error_handlers(app):
    @app.exception_handler(ApiError)
    async def api_error(request: Request, error: ApiError):
        response = error_response(error, getattr(request.state, "trace_id", None))
        if error.code == "session_expired":
            response.delete_cookie(request.app.state.settings.cookie_name, path="/", httponly=True,
                                   samesite="strict", secure=request.url.scheme == "https")
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request: Request, error: RequestValidationError):
        return error_response(ApiError(422, "invalid_request", "Проверьте формат полей запроса."))

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, error: HTTPException):
        codes = {400: "invalid_request", 401: "authentication_required", 403: "forbidden", 404: "not_found"}
        return error_response(ApiError(error.status_code, codes.get(error.status_code, "request_failed"),
                                       "Запрос не может быть выполнен."))

    @app.exception_handler(SQLAlchemyError)
    async def database_error(request: Request, error: SQLAlchemyError):
        return error_response(ApiError(503, "database_unavailable", "Хранилище метаданных недоступно.",
                                       retryable=True))

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, error: Exception):
        return error_response(ApiError(500, "internal_error", "Операция не завершена. Проверьте её состояние."))
