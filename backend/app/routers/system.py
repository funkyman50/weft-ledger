from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, File, Form, Request, Response, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app.auth import change_password, require_session, set_session_cookie
from app.db import database_generation
from app.diagnostics import diagnostics
from app.errors import AppError
from app.schemas import RestorePreview, StatusRestored
from app.services import account_logos, backup_package, backup_state, database_backup
from app.services.ledger_history import LedgerHistoryManager

router = APIRouter(prefix="/api/system", tags=["system"])


class UploadLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        limits = {
            "/api/system/restore": (database_backup.MAX_UPLOAD_BYTES + 64 * 1024, "backup_too_large", "Backup files must be 256 MB or smaller."),
            "/api/system/restore/preview": (database_backup.MAX_UPLOAD_BYTES + 64 * 1024, "backup_too_large", "Backup files must be 256 MB or smaller."),
            "/api/account-logos": (account_logos.MAX_UPLOAD_BYTES, "account_logo_upload_too_large", "This image is too large to process. Try a smaller copy."),
        }
        limit = limits.get(scope.get("path", "").rstrip("/"))
        if scope["type"] == "http" and scope["method"] == "POST" and limit:
            request = Request(scope, receive)
            try:
                require_session(request)
                try:
                    length = int(request.headers.get("content-length", ""))
                except ValueError:
                    raise AppError("upload_length_required", "Uploads require a known content length.", 411) from None
                if length < 0 or length > limit[0]:
                    raise AppError(limit[1], limit[2], 413)
            except AppError as error:
                response = JSONResponse({"error": {"code": error.code, "message": error.message}}, status_code=error.status)
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


class PasswordRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(max_length=4096)


class KeyRequest(PasswordRequest):
    recovery_key: str = Field(max_length=128)
    expected_key_id: str | None = Field(max_length=16)


class BackupRequest(PasswordRequest):
    key_id: str = Field(min_length=16, max_length=16)


def _password(request: Request, value: str) -> None:
    request.app.state.password_store.confirm(value)


def _live_path(request: Request) -> Path:
    return Path(request.app.state.settings.db_path)


class PasswordChange(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    revision: str = Field(pattern=r"^[0-9a-f]{32}$")
    current_password: str = Field(default="", max_length=4096)
    new_password: str | None = Field(max_length=4096)


@router.get("/password")
def password_status(request: Request, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return request.app.state.password_store.load().status()


@router.post("/password")
def password_change(payload: PasswordChange, request: Request, response: Response) -> dict:
    result = change_password(request, payload.revision, payload.current_password, payload.new_password)
    set_session_cookie(response, request.app.state.settings, result["revision"])
    return result


@router.get("/diagnostics", response_class=JSONResponse)
def diagnostic_report() -> JSONResponse:
    return JSONResponse(diagnostics.report(), headers={"Cache-Control": "no-store"})


@router.get("/backup/status")
def backup_status(request: Request) -> JSONResponse:
    with request.app.state.database_gate.admit():
        return JSONResponse({**backup_state.status(_live_path(request)), "password_required": request.app.state.password_store.load().digest is not None}, headers={"Cache-Control": "no-store"})


@router.post("/backup/key/new")
def new_backup_key(payload: PasswordRequest, request: Request) -> JSONResponse:
    _password(request, payload.password)
    return JSONResponse(backup_package.generate_key(), headers={"Cache-Control": "no-store"})


@router.post("/backup/key")
def configure_backup_key(payload: KeyRequest, request: Request) -> JSONResponse:
    _password(request, payload.password)
    key = backup_package.identity(payload.recovery_key)
    with request.app.state.database_gate.admit():
        result = backup_state.configure(_live_path(request), str(key.to_public()), payload.expected_key_id)
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@router.post("/backup", response_class=Response)
def backup(payload: BackupRequest, request: Request) -> Response:
    _password(request, payload.password)
    with request.app.state.database_gate.admit():
        content, identifier = database_backup.create_package(_live_path(request), request.app.state.settings, payload.key_id)
    filename = f"weft-backup-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{identifier}-{uuid4().hex[:8]}.age"
    return Response(content, media_type="application/octet-stream", headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"})


@router.post("/restore/preview", response_model=RestorePreview)
def restore_preview(request: Request, recovery_key: str = Form(..., max_length=128), backup: UploadFile = File(...)) -> dict:
    with request.app.state.database_gate.admit():
        path, digest = database_backup.upload_to_temp(backup)
        try:
            with backup_package.decrypt_database(path, recovery_key, request.app.state.settings) as (prepared, metadata):
                database_backup.validate_restore(_live_path(request), prepared, request.app.state.settings.secret)
                return {"digest": digest, "generation": database_generation(_live_path(request)), **metadata, **database_backup.preview(prepared, request.app.state.settings)}
        finally:
            path.unlink(missing_ok=True)


@router.post("/restore", response_model=StatusRestored)
def restore(request: Request, digest: str = Form(..., min_length=64, max_length=64), generation: str = Form(..., max_length=36), password: str = Form("", max_length=4096), recovery_key: str = Form(..., max_length=128), backup: UploadFile = File(...)) -> dict:
    _password(request, password)
    path, uploaded_digest = database_backup.upload_to_temp(backup)
    try:
        if uploaded_digest != digest:
            raise AppError("restore_digest_mismatch", "The selected backup differs from the previewed file.", 409)
        with backup_package.decrypt_database(path, recovery_key, request.app.state.settings) as (prepared, metadata):
            with request.app.state.database_gate.maintenance():
                with request.app.state.plaid_sync_jobs.maintenance():
                    live_path = _live_path(request)
                    if database_generation(live_path) != generation:
                        raise AppError("restore_preview_stale", "The database changed after preview. Reload and preview the backup again.", 409)
                    request.app.state.engine.dispose()
                    try:
                        database_backup.promote_restore(live_path, prepared, request.app.state.settings.secret, metadata["recipient"])
                    except AppError as error:
                        if error.code == "restore_recovery_failed":
                            request.app.state.plaid_sync_jobs.stop_for_maintenance()
                            request.app.state.database_gate.keep_closed()
                        raise
                    finally:
                        current = database_generation(live_path)
                        if current != generation:
                            request.app.state.ledger_history = LedgerHistoryManager(current)
                    return {"status": "restored"}
    finally:
        path.unlink(missing_ok=True)
