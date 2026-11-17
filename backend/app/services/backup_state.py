import hashlib
import json
import os
import stat
import tempfile
import threading
from pathlib import Path

from pyrage import x25519

from app.errors import AppError

_lock = threading.RLock()


def key_id(recipient: str | None) -> str | None:
    return hashlib.sha256(recipient.encode()).hexdigest()[:16] if recipient else None


def state_path(database: str | Path) -> Path:
    path = Path(database)
    return path.with_name(f"{path.stem}.backup.json")


def _validate(value: dict) -> dict:
    if not isinstance(value, dict) or set(value) != {"version", "recipient", "bank_sync_paused"}:
        raise ValueError()
    if type(value["version"]) is not int or value["version"] != 1 or type(value["bank_sync_paused"]) is not bool:
        raise ValueError()
    if value["recipient"] is not None:
        if not isinstance(value["recipient"], str) or len(value["recipient"]) > 100:
            raise ValueError()
        if str(x25519.Recipient.from_str(value["recipient"])) != value["recipient"]:
            raise ValueError()
    return value


def load(database: str | Path) -> dict:
    with _lock:
        path = state_path(database)
        try:
            if path.is_symlink():
                raise ValueError()
            with path.open("rb") as source:
                if stat.S_IMODE(os.fstat(source.fileno()).st_mode) & 0o077:
                    raise ValueError()
                content = source.read(8193)
                if len(content) > 8192:
                    raise ValueError()
                return _validate(json.loads(content))
        except FileNotFoundError:
            return {"version": 1, "recipient": None, "bank_sync_paused": False}
        except Exception as error:
            raise AppError("backup_state_invalid", "Backup settings cannot be read. Preserve the settings file and repair it before starting Weft; bank activity remains blocked.", 503) from error


def save(database: str | Path, value: dict) -> None:
    with _lock:
        _validate(value)
        path = state_path(database)
        if path.is_symlink():
            raise AppError("backup_state_invalid", "Backup settings cannot be a symbolic link.", 503)
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "w") as output:
                json.dump(value, output)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)


def status(database: str | Path) -> dict:
    state = load(database)
    return {"recipient": state["recipient"], "key_id": key_id(state["recipient"])}


def configure(database: str | Path, recipient: str, expected_key_id: str | None) -> dict:
    with _lock:
        state = load(database)
        if key_id(state["recipient"]) != expected_key_id:
            raise AppError("backup_key_changed", "The backup key changed. Reopen backup setup before replacing it.", 409)
        state["recipient"] = recipient
        save(database, state)
        return status(database)


def bank_sync_paused(database: str | Path) -> bool:
    return load(database)["bank_sync_paused"]


def require_bank_activity(database: str | Path) -> None:
    if bank_sync_paused(database):
        raise AppError("bank_sync_paused", "Bank sync is paused after restore. Press Sync Plaid to resume before using this bank action.", 409)


def resume_bank_sync(database: str | Path) -> None:
    with _lock:
        state = load(database)
        if state["bank_sync_paused"]:
            state["bank_sync_paused"] = False
            save(database, state)
