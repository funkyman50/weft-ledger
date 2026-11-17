import hashlib
import json
import os
import sqlite3
import struct
import tempfile
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path

import pyrage
from cryptography.fernet import Fernet, InvalidToken
from pyrage import x25519

from app import schema_admission
from app.errors import AppError
from app.services import backup_state
from app.services.plaid_client import decrypt_access_token, encrypt_access_token

MAX_BYTES = 256 * 1024 * 1024
MAX_MANIFEST_BYTES = 16 * 1024
# Existing backup packages carry this marker; renaming it makes them unreadable.
_MAGIC = b"WEFT-BACKUP\x00\x01"
_SCHEMA_HASH = hashlib.sha256(json.dumps(schema_admission.CURRENT_SCHEMA, separators=(",", ":")).encode()).hexdigest()
_FIELDS = {"version", "schema_revision", "schema_hash", "created_at", "recipient", "token_key"}


def _invalid(message="The file is not a supported current Weft backup."):
    raise AppError("backup_incompatible", message, 422)


def identity(recovery_key: str):
    try:
        if len(recovery_key) > 128:
            raise ValueError()
        return x25519.Identity.from_str(recovery_key.strip())
    except Exception as error:
        raise AppError("backup_key_invalid", "The recovery key is malformed or its checksum is invalid. Paste the complete saved key.", 422) from error


def generate_key() -> dict:
    key = x25519.Identity.generate()
    recipient = str(key.to_public())
    return {"recovery_key": str(key), "recipient": recipient, "key_id": backup_state.key_id(recipient)}


def _read_bounded(path: Path) -> bytes:
    with path.open("rb") as source:
        value = source.read(MAX_BYTES + 1)
    if len(value) > MAX_BYTES:
        raise AppError("backup_too_large", "Backup files and decrypted data must be 256 MB or smaller.", 413)
    return value


def _validate_database(path: Path) -> None:
    try:
        schema_admission.validate(path)
    except schema_admission.SchemaError as error:
        _invalid(str(error))


def _rewrap(path: Path, unwrap, wrap, *, clean=False) -> None:
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("PRAGMA temp_store=MEMORY")
        connection.execute("PRAGMA secure_delete=ON")
        for identifier, protected in connection.execute("SELECT id, access_token_enc FROM plaid_items").fetchall():
            if not isinstance(protected, str):
                _invalid("A saved bank credential is invalid.")
            token = unwrap(protected)
            connection.execute("UPDATE plaid_items SET access_token_enc=? WHERE id=?", (wrap(token), identifier))
        if clean:
            connection.execute("DELETE FROM command_confirmations")
            connection.execute("DELETE FROM plaid_sync_state")
        connection.commit()
        connection.execute("VACUUM")
    _validate_database(path)


def encrypt_snapshot(path: Path, settings, recipient: str) -> bytes:
    token_key = Fernet.generate_key()
    protection = Fernet(token_key)
    _rewrap(path, lambda value: decrypt_access_token(settings.secret, value), lambda token: protection.encrypt(token.encode()).decode(), clean=True)
    manifest = {
        "version": 1, "schema_revision": schema_admission.SCHEMA_REVISION, "schema_hash": _SCHEMA_HASH,
        "created_at": datetime.now(UTC).isoformat(), "recipient": recipient, "token_key": token_key.decode(),
    }
    header = json.dumps(manifest, separators=(",", ":")).encode()
    if len(header) > MAX_MANIFEST_BYTES:
        raise AppError("backup_metadata_invalid", "Backup metadata exceeds the supported size limit. Check the provider configuration.", 422)
    payload = _MAGIC + struct.pack(">I", len(header)) + header + _read_bounded(path)
    if len(payload) > MAX_BYTES:
        raise AppError("backup_too_large", "This database exceeds the 256 MB backup payload limit.", 422)
    encrypted = pyrage.encrypt(payload, [x25519.Recipient.from_str(recipient)])
    if len(encrypted) > MAX_BYTES:
        raise AppError("backup_too_large", "The encrypted backup exceeds the 256 MB file limit.", 422)
    return encrypted


@contextmanager
def decrypt_database(path: Path, recovery_key: str, settings):
    key = identity(recovery_key)
    try:
        payload = pyrage.decrypt(_read_bounded(path), [key])
    except pyrage.DecryptError as error:
        raise AppError("backup_decryption_failed", "This key cannot open the backup, or the file is damaged. Check the saved key and backup file.", 422) from error
    offset = len(_MAGIC)
    if len(payload) > MAX_BYTES or not payload.startswith(_MAGIC) or len(payload) < offset + 4:
        _invalid()
    length = struct.unpack(">I", payload[offset:offset + 4])[0]
    offset += 4
    if not 0 < length <= MAX_MANIFEST_BYTES or offset + length >= len(payload):
        _invalid()
    try:
        manifest = json.loads(payload[offset:offset + length])
        if not isinstance(manifest, dict) or set(manifest) != _FIELDS:
            raise ValueError()
        if type(manifest["version"]) is not int or manifest["version"] != 1:
            raise ValueError()
        if type(manifest["schema_revision"]) is not int or manifest["schema_revision"] != schema_admission.SCHEMA_REVISION or manifest["schema_hash"] != _SCHEMA_HASH:
            raise ValueError()
        if not all(isinstance(manifest[field], str) for field in _FIELDS - {"version", "schema_revision"}):
            raise ValueError()
        if manifest["recipient"] != str(key.to_public()) or datetime.fromisoformat(manifest["created_at"]).tzinfo is None:
            raise ValueError()
        protection = Fernet(manifest["token_key"].encode())
    except Exception:
        _invalid("The backup metadata or schema is unsupported. Only the current backup format and schema can be restored.")
    descriptor, name = tempfile.mkstemp(prefix="weft-restore-data-", suffix=".db")
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(memoryview(payload)[offset + length:])
        del payload
        _validate_database(temporary)
        try:
            _rewrap(temporary, lambda value: protection.decrypt(value.encode()).decode(), lambda token: encrypt_access_token(settings.secret, token))
        except (InvalidToken, UnicodeError, ValueError):
            _invalid("The backup's protected bank credentials are invalid.")
        public = {
            "recipient": manifest["recipient"], "key_id": backup_state.key_id(manifest["recipient"]),
            "created_at": manifest["created_at"],
        }
        yield temporary, public
    finally:
        temporary.unlink(missing_ok=True)
        for sidecar in schema_admission.recovery_files(temporary):
            sidecar.unlink(missing_ok=True)
