from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.diagnostics import diagnostics


class AppError(Exception):
    def __init__(self, code: str, message: str, status: int, detail=None):
        self.code = code
        self.message = message
        self.status = status
        self.detail = detail
        super().__init__(message)


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        diagnostics.emit("http.domain_error", "error" if exc.status >= 500 else "warning", error=exc, code=exc.code, status=exc.status)
        return JSONResponse(
            status_code=exc.status,
            content={
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                    "detail": exc.detail,
                }
            },
        )
