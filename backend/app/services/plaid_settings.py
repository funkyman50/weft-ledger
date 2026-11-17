import base64
import hashlib
import os
import stat
import tempfile
from pathlib import Path
from typing import Literal
from uuid import uuid4

from cryptography.fernet import Fernet, InvalidToken
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select

from app.errors import AppError
from app.models import PlaidItem
from app.services import backup_state


class Credentials(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    link_user_id: str = Field(min_length=1, max_length=128)
    revision: str = Field(default="unconfigured", min_length=1, max_length=64)
    client_id: str = Field(default="", max_length=256)
    secret: str = Field(default="", max_length=256, repr=False)
    environment: Literal["production", "sandbox"] = "production"

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.secret)

    @property
    def identity(self) -> dict:
        return {"client_id_hash": hashlib.sha256(self.client_id.encode()).hexdigest(), "environment": self.environment}

    @property
    def identity_token(self) -> str:
        identity = self.identity
        return hashlib.sha256(f"{identity['environment']}:{identity['client_id_hash']}".encode()).hexdigest()


def _path(settings) -> Path:
    path = Path(settings.db_path)
    return path.with_name(f"{path.name}.plaid.enc")


def _cipher(settings) -> Fernet:
    # Existing .plaid.enc files are keyed with this context string; changing it orphans them.
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(f"weft-plaid:{settings.secret}".encode()).digest()))


def load(settings) -> Credentials:
    path = _path(settings)
    try:
        if path.is_symlink():
            raise ValueError()
        with path.open("rb") as source:
            if stat.S_IMODE(os.fstat(source.fileno()).st_mode) & 0o077:
                raise ValueError()
            content = source.read(16385)
        if len(content) > 16384:
            raise ValueError()
        return Credentials.model_validate_json(_cipher(settings).decrypt(content))
    except FileNotFoundError:
        return Credentials(link_user_id=uuid4().hex)
    except (OSError, ValueError, InvalidToken, ValidationError) as error:
        raise AppError("plaid_settings_unreadable", "Plaid settings cannot be read. Preserve the credential file and restore its installation secret or permissions. Saved financial data has not been replaced.", 503) from error


def _persist(settings, credentials: Credentials) -> None:
    path = _path(settings)
    temporary = None
    try:
        if path.is_symlink():
            raise OSError("Credential file cannot be a symbolic link.")
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
        with os.fdopen(descriptor, "wb") as output:
            output.write(_cipher(settings).encrypt(credentials.model_dump_json().encode()))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        temporary = None
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        if load(settings) != credentials:
            raise OSError("Credential readback differs.")
    except (OSError, AppError) as error:
        raise AppError("plaid_settings_save_uncertain", "The Plaid settings save could not be confirmed. Refresh settings before continuing.", 503) from error
    finally:
        if temporary:
            Path(temporary).unlink(missing_ok=True)


def custody_identity(db) -> dict | None:
    identities = db.execute(select(PlaidItem.client_id_hash, PlaidItem.environment).distinct()).mappings().all()
    if len(identities) > 1:
        raise AppError("plaid_custody_conflict", "Saved bank connections have different Plaid owners. Preserve the data and resolve provider custody before changing setup or using bank connections.", 409)
    return dict(identities[0]) if identities else None


def matches(db, credentials: Credentials) -> bool:
    owner = custody_identity(db)
    return owner is None or owner == credentials.identity


def require_configured(db, settings) -> Credentials:
    credentials = load(settings)
    if not credentials.configured:
        raise AppError("plaid_not_configured", "Set up Plaid in System settings → Plaid before using bank connections.", 424)
    if not matches(db, credentials):
        raise AppError("plaid_configuration_mismatch", "These bank connections belong to a different Plaid account or environment. Enter their original credentials in System settings → Plaid. Your history is preserved.", 409)
    return credentials


def expect_identity(settings, identity: str) -> None:
    if load(settings).identity_token != identity:
        raise AppError("plaid_link_stale", "Plaid setup changed while bank sign-in was open. Start bank sign-in again; this token was not exchanged.", 409)


def expect_revision(settings, revision: str) -> Credentials:
    credentials = load(settings)
    if credentials.revision != revision:
        raise AppError("plaid_settings_changed", "Plaid settings changed. Refresh settings before continuing.", 409)
    return credentials


def status(db, settings) -> dict:
    credentials = load(settings)
    owner = custody_identity(db)
    matching = matches(db, credentials)
    return {
        "revision": credentials.revision, "client_id": credentials.client_id,
        "has_secret": bool(credentials.secret), "configured": credentials.configured,
        "environment": credentials.environment, "configuration_matches": matching,
        "identity_locked": owner is not None and matching,
        "custody_environment": owner["environment"] if owner else None,
        "bank_sync_paused": backup_state.bank_sync_paused(settings.db_path),
    }


def save(db, settings, revision: str, client_id: str, secret: str | None, environment: str) -> dict:
    current = expect_revision(settings, revision)
    client_id = client_id.strip()
    secret = secret.strip() if secret is not None else None
    if not client_id or secret == "":
        raise AppError("plaid_credentials_required", "Enter a Client ID and a nonblank Secret. Leave the Secret empty only to keep the saved Secret for the same account and environment.", 422)
    same_identity = client_id == current.client_id and environment == current.environment
    if secret is None and not same_identity:
        raise AppError("plaid_secret_required", "Enter the Secret for this Plaid account and environment.", 422)
    updated = Credentials(revision=str(uuid4()), link_user_id=current.link_user_id, client_id=client_id, secret=secret if secret is not None else current.secret, environment=environment)
    if not updated.configured:
        raise AppError("plaid_secret_required", "Enter your Plaid Secret.", 422)
    if not matches(db, updated):
        raise AppError("plaid_identity_locked", "Saved bank connections require their original Plaid account and environment. Disconnect those feeds and resolve staged connections before switching. Financial history will remain.", 409)
    if (updated.client_id, updated.secret, updated.environment, updated.link_user_id) != (current.client_id, current.secret, current.environment, current.link_user_id):
        _persist(settings, updated)
    return status(db, settings)
