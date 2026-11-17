import argparse
import getpass
import hashlib
import os
import re
import secrets
import shutil
import stat
import tempfile
import threading
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import Request
from itsdangerous import BadSignature, URLSafeSerializer
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from starlette.datastructures import Headers
from starlette.responses import JSONResponse

from app.config import Settings
from app.errors import AppError

COOKIE_NAME = "weft_session"



def _local_origin(scheme: str, authority: str) -> tuple[str, str, int] | None:
    match = re.fullmatch(r"(localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?", authority.lower())
    if scheme not in {"http", "https"} or not match:
        return None
    port = int(match[2]) if match[2] else (443 if scheme == "https" else 80)
    return (scheme, match[1], port) if port <= 65535 else None


class LocalBrowserAdmission:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        hosts = headers.getlist("host")
        expected = _local_origin(scope["scheme"], hosts[0]) if len(hosts) == 1 else None
        origins = headers.getlist("origin")
        origin_parts = origins[0].split("://", 1) if len(origins) == 1 else []
        origin = _local_origin(*origin_parts) if len(origin_parts) == 2 else None
        protected = scope["path"] == "/login" or scope["path"] == "/api" or scope["path"].startswith("/api/")
        sites = headers.getlist("sec-fetch-site")
        unsafe = scope["method"] not in {"GET", "HEAD", "OPTIONS"}
        if not expected:
            response = JSONResponse({"error": {"code": "invalid_host", "message": "Use a local Weft address."}}, status_code=400)
        elif (origins and (len(origins) != 1 or origin != expected)) or (protected and (
            (unsafe and not origins) or len(sites) > 1 or (sites and sites[0] not in {"same-origin", "none"})
        )):
            response = JSONResponse({"error": {"code": "invalid_origin", "message": "Open Weft directly and retry from its own page."}}, status_code=403)
        else:
            await self.app(scope, receive, send)
            return
        await response(scope, receive, send)


class PasswordState(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    version: Literal[1]
    revision: str = Field(pattern=r"^[0-9a-f]{32}$")
    salt: str | None = Field(pattern=r"^[0-9a-f]{32}$", repr=False)
    digest: str | None = Field(pattern=r"^[0-9a-f]{64}$", repr=False)

    @model_validator(mode="after")
    def paired_hash(self):
        if (self.salt is None) != (self.digest is None):
            raise ValueError("Incomplete password hash.")
        return self

    def status(self) -> dict:
        return {"revision": self.revision, "password_required": self.digest is not None}


def _digest(password: str, salt: str) -> str:
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2**15, r=8, p=3, dklen=32, maxmem=64*1024*1024).hex()


def _matches(state: PasswordState, password: str) -> bool:
    return state.digest is None or bool(password and secrets.compare_digest(_digest(password, state.salt), state.digest))


def _new_state(password: str | None) -> PasswordState:
    if password is None:
        return PasswordState(version=1, revision=uuid4().hex, salt=None, digest=None)
    if len(password.strip()) < 12 or len(password) > 4096 or password.strip().lower() in {"your-password-here", "change-this-password"}:
        raise AppError("invalid_password", "Use a unique password with 12 to 4096 characters.", 422)
    salt = secrets.token_hex(16)
    return PasswordState(version=1, revision=uuid4().hex, salt=salt, digest=_digest(password, salt))


class PasswordStore:
    def __init__(self, database: str | Path):
        self.database = Path(database)
        self.path = self.database.with_suffix(".auth.json")
        self.lock = threading.RLock()

    def load(self) -> PasswordState:
        try:
            if self.path.is_symlink():
                raise ValueError()
            with self.path.open("rb") as source:
                if stat.S_IMODE(os.fstat(source.fileno()).st_mode) & 0o077:
                    raise ValueError()
                content = source.read(8193)
            if len(content) > 8192:
                raise ValueError()
            return PasswordState.model_validate_json(content)
        except (OSError, ValueError, ValidationError) as error:
            raise AppError("password_settings_unreadable", "Password settings cannot be read. Preserve the file and use the local password reset instructions in docs/OPERATIONS.md. Saved data has not been replaced.", 503) from error

    def _persist(self, state: PasswordState) -> None:
        temporary = None
        try:
            if self.path.is_symlink():
                raise OSError("Password settings cannot be a symbolic link.")
            self.path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(prefix=f".{self.path.name}-", dir=self.path.parent)
            with os.fdopen(descriptor, "wb") as output:
                output.write(state.model_dump_json().encode())
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
            temporary = None
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            if self.load() != state:
                raise OSError("Password settings readback differs.")
        except (OSError, AppError) as error:
            raise AppError("password_save_uncertain", "The password save could not be confirmed. Reload, sign in if needed, and inspect Security settings before trying again.", 503) from error
        finally:
            if temporary:
                Path(temporary).unlink(missing_ok=True)

    def initialize(self) -> None:
        if not self.path.exists() and not self.database.exists():
            self._persist(_new_state(None))
        self.load()

    def login(self, password: str) -> PasswordState:
        with self.lock:
            state = self.load()
            if not _matches(state, password):
                raise AppError("bad_password" if password else "password_required", "Incorrect password" if password else "Enter your Weft password.", 401)
            return state

    def confirm(self, password: str) -> None:
        with self.lock:
            if not _matches(self.load(), password):
                raise AppError("bad_password", "Incorrect password", 403)

    def change(self, revision: str, current_password: str, new_password: str | None) -> PasswordState:
        with self.lock:
            current = self.load()
            if current.revision != revision:
                raise AppError("password_settings_stale", "Password settings changed. Refresh them before trying again.", 409)
            if not _matches(current, current_password):
                raise AppError("bad_password", "Incorrect current password", 403)
            updated = _new_state(new_password)
            self._persist(updated)
            return updated

    def reset(self, password: str | None) -> None:
        with self.lock:
            updated = _new_state(password)
            if self.path.is_symlink():
                raise AppError("password_settings_unreadable", "Preserve and remove the symbolic link before resetting password settings.", 503)
            if self.path.exists():
                recovery = self.path.with_name(f"{self.path.name}.before-reset-{uuid4().hex}")
                descriptor = os.open(recovery, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "wb") as output, self.path.open("rb") as source:
                    shutil.copyfileobj(source, output)
                    output.flush()
                    os.fsync(output.fileno())
            self._persist(updated)


def make_session_cookie(settings: Settings, revision: str) -> str:
    return URLSafeSerializer(settings.secret, salt="weft-session").dumps(revision)


def verify_session_cookie(settings: Settings, cookie_value: str, revision: str) -> bool:
    try:
        value = URLSafeSerializer(settings.secret, salt="weft-session").loads(cookie_value)
        return isinstance(value, str) and secrets.compare_digest(value, revision)
    except BadSignature:
        return False


def set_session_cookie(response, settings: Settings, revision: str) -> None:
    response.set_cookie(COOKIE_NAME, make_session_cookie(settings, revision), httponly=True, samesite="lax")
    response.headers["Cache-Control"] = "no-store"


def require_session(request: Request) -> None:
    state = request.app.state.password_store.load()
    cookie = request.cookies.get(COOKIE_NAME)
    if not cookie or not verify_session_cookie(request.app.state.settings, cookie, state.revision):
        raise AppError("unauthorized", "Login required", 401)


def change_password(request: Request, revision: str, current_password: str, new_password: str | None) -> dict:
    store = request.app.state.password_store
    with store.lock:
        require_session(request)
        return store.change(revision, current_password, new_password).status()


def main() -> None:
    parser = argparse.ArgumentParser(description="Reset Weft login protection locally while the app is stopped. Financial data and encryption keys are unchanged.")
    parser.add_argument("--database", type=Path, default=os.environ.get("WEFT_DB_PATH"), help="Absolute path to the existing database.")
    parser.add_argument("--remove", action="store_true", help="Explicitly remove login password protection.")
    args = parser.parse_args()
    if not args.database or not args.database.is_absolute() or not args.database.is_file():
        parser.error("Supply an absolute path to the existing database with --database or WEFT_DB_PATH.")
    password = None
    if not args.remove:
        password = getpass.getpass("New password (at least 12 characters): ")
        if password != getpass.getpass("Confirm new password: "):
            parser.error("Passwords do not match; nothing changed.")
    PasswordStore(args.database).reset(password)
    print("Login password removed." if args.remove else "Login password updated.")
    print("Older sessions are invalid. Existing password settings, if present, were copied privately beside the password file. Start Weft normally.")


if __name__ == "__main__":
    try:
        main()
    except AppError as error:
        raise SystemExit(error.message) from None
