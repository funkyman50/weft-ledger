import hashlib
import os
import sqlite3
import tempfile
import threading
import time
from contextlib import closing, contextmanager
from pathlib import Path
from uuid import uuid4

from sqlalchemy import select

from app import schema_admission
from app.db import make_session_factory, rotate_database_generation
from app.errors import AppError
from app.models import Account
from app.services import backup_package, backup_state, ledger_projection, plaid_settings
from app.services.plaid_client import decrypt_access_token

MAX_UPLOAD_BYTES = 256 * 1024 * 1024


class MaintenanceGate:
    def __init__(self):
        self._condition = threading.Condition()
        self._closed = False
        self._fatal = False
        self._active = 0

    @contextmanager
    def admit(self):
        with self._condition:
            if self._closed:
                raise AppError("restore_in_progress", "Database maintenance is in progress. Retry shortly.", 409)
            self._active += 1
        try:
            yield
        finally:
            with self._condition:
                self._active -= 1
                self._condition.notify_all()

    @contextmanager
    def maintenance(self, timeout=30):
        with self._condition:
            if self._closed:
                raise AppError("restore_in_progress", "Database maintenance is already in progress.", 409)
            self._closed = True
            deadline = time.monotonic() + timeout
            while self._active:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._closed = False
                    self._condition.notify_all()
                    raise AppError("restore_busy", "Database work did not finish in time. Retry shortly.", 409)
                self._condition.wait(remaining)
        try:
            yield
        finally:
            with self._condition:
                if not self._fatal:
                    self._closed = False
                    self._condition.notify_all()

    def keep_closed(self) -> None:
        with self._condition:
            self._fatal = True
            self._closed = True


def _incompatible(message):
    raise AppError("backup_incompatible", message, 422)


def validate_database(path: Path) -> None:
    try:
        schema_admission.validate(path)
    except schema_admission.SchemaError as error:
        _incompatible(str(error))


def custody(path: Path, secret: str):
    try:
        with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as connection:
            if connection.execute("SELECT 1 FROM account_conversion_attempts LIMIT 1").fetchone():
                _incompatible("Backups cannot be used while an account conversion is staged.")
            items = []
            for identifier, item_id, token, client_id_hash, environment in connection.execute(
                "SELECT id, item_id, access_token_enc, client_id_hash, environment FROM plaid_items ORDER BY id"
            ):
                try:
                    items.append((identifier, item_id, client_id_hash, environment, decrypt_access_token(secret, token)))
                except AppError:
                    _incompatible("This backup's bank connection custody cannot be verified here.")
            links = set(connection.execute(
                "SELECT plaid_item_id, plaid_account_id, account_id FROM plaid_account_links"
            ))
            return tuple(items), links
    except AppError:
        raise
    except sqlite3.Error:
        _incompatible("This backup's bank connection custody cannot be read.")


def validate_restore(live_path: Path, backup_path: Path, secret: str) -> bool:
    validate_database(backup_path)
    incoming = custody(backup_path, secret)
    if not live_path.exists():
        return True
    validate_database(live_path)
    current = custody(live_path, secret)
    with closing(sqlite3.connect(live_path)) as connection:
        empty = not connection.execute("SELECT 1 FROM accounts LIMIT 1").fetchone() and not connection.execute("SELECT 1 FROM plaid_items LIMIT 1").fetchone()
    if not empty and current != incoming:
        _incompatible("Bank connections changed since this backup. Restore requires unchanged bank custody.")
    return empty


def prepare_restore_copy(path: Path) -> None:
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("DELETE FROM plaid_sync_state")
        connection.execute("DELETE FROM command_confirmations")
        connection.commit()
    validate_database(path)


def snapshot(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        raise ValueError("Backup destination cannot be a symbolic link.")
    if destination.exists():
        os.chmod(destination, 0o600)
    else:
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
    try:
        with closing(sqlite3.connect(source)) as source_connection, closing(sqlite3.connect(destination)) as destination_connection:
            source_connection.backup(destination_connection)
        validate_database(destination)
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def upload_to_temp(upload) -> tuple[Path, str]:
    descriptor, name = tempfile.mkstemp(prefix="weft-restore-", suffix=".db")
    path = Path(name)
    digest = hashlib.sha256()
    size = 0
    try:
        with os.fdopen(descriptor, "wb") as output:
            while chunk := upload.file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise AppError("backup_too_large", "Backup files must be 256 MB or smaller.", 413)
                digest.update(chunk)
                output.write(chunk)
        os.chmod(path, 0o600)
        return path, digest.hexdigest()
    except Exception:
        path.unlink(missing_ok=True)
        raise


def preview(path: Path, settings) -> dict:
    engine, sessions = make_session_factory(str(path))
    db = sessions()
    try:
        accounts = []
        for account in db.scalars(select(Account).order_by(Account.sort_order, Account.id)).all():
            uninitialized = ledger_projection.account_requires_initialization(db, account.id)
            rows = ledger_projection.visible_rows(db, account.id)
            latest = max((row.date for row in rows if row.source != "starting_balance"), default=None)
            accounts.append({
                "id": account.id,
                "name": account.name,
                "working_balance_cents": None if uninitialized else ledger_projection.balances(db, account.id)["working_balance_cents"],
                "latest_transaction_date": latest.isoformat() if latest else None,
            })
        try:
            credentials = plaid_settings.load(settings)
            configuration_matches = credentials.configured and plaid_settings.matches(db, credentials)
        except AppError as error:
            if error.code != "plaid_settings_unreadable":
                raise
            configuration_matches = False
        return {"accounts": accounts, "provider_configuration_matches": configuration_matches}
    finally:
        db.close()
        engine.dispose()


def safety_snapshot(live_path: Path) -> Path:
    path = live_path.with_name(f"{live_path.stem}.before-restore-{uuid4().hex}.db")
    snapshot(live_path, path)
    return path


def copy_into_live(backup_path: Path, live_path: Path) -> None:
    if live_path.is_symlink():
        raise AppError("restore_failed", "The database destination cannot be a symbolic link.", 422)
    live_path.parent.mkdir(parents=True, exist_ok=True)
    if not live_path.exists():
        descriptor = os.open(live_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
    with closing(sqlite3.connect(backup_path)) as source, closing(sqlite3.connect(live_path)) as destination:
        source.backup(destination)
    validate_database(live_path)


def create_package(live_path: Path, settings, expected_key_id: str) -> tuple[bytes, str]:
    state = backup_state.status(live_path)
    if state["recipient"] is None or state["key_id"] != expected_key_id:
        raise AppError("backup_key_changed", "The backup key is not configured or has changed. Reopen Download backup and check its key identifier.", 409)
    validate_database(live_path)
    descriptor, name = tempfile.mkstemp(prefix="weft-backup-", suffix=".db")
    os.close(descriptor)
    temporary = Path(name)
    try:
        snapshot(live_path, temporary)
        custody(temporary, settings.secret)
        return backup_package.encrypt_snapshot(temporary, settings, state["recipient"]), state["key_id"]
    finally:
        temporary.unlink(missing_ok=True)
        for sidecar in schema_admission.recovery_files(temporary):
            sidecar.unlink(missing_ok=True)


def promote_restore(live_path: Path, prepared: Path, secret: str, recipient: str) -> str:
    fresh = validate_restore(live_path, prepared, secret)
    if schema_admission.recovery_files(live_path):
        raise AppError("restore_sidecars_present", "The current database has SQLite recovery files. Stop the app and follow the SQLite recovery instructions in docs/OPERATIONS.md; do not delete those files.", 409)
    prepare_restore_copy(prepared)
    safety = safety_snapshot(live_path) if live_path.exists() else None
    previous = backup_state.load(live_path)
    restored = {**previous, "bank_sync_paused": True}
    if fresh:
        restored["recipient"] = recipient
    backup_state.save(live_path, restored)
    try:
        generation = rotate_database_generation(live_path)
    except Exception as error:
        try:
            backup_state.save(live_path, previous)
        except Exception:
            raise AppError("restore_recovery_failed", "Restore could not recover its backup settings. Stop the app and preserve its database and backup settings.", 500) from error
        raise AppError("restore_failed", "Restore could not update the database generation. The database was not replaced.", 500) from error
    try:
        copy_into_live(prepared, live_path)
    except Exception as error:
        if safety is None:
            raise AppError("restore_recovery_failed", "Restore could not complete on the empty destination. Preserve the backup and destination files and use a new empty destination.", 500) from error
        try:
            rotate_database_generation(live_path)
            copy_into_live(safety, live_path)
            backup_state.save(live_path, {**previous, "bank_sync_paused": True})
        except Exception:
            raise AppError("restore_recovery_failed", f"Restore failed and the safety copy could not be recovered. Stop the app and preserve {safety} with the installation secret.", 500, {"safety_copy": str(safety)}) from error
        raise AppError("restore_failed", "Restore failed; the safety copy was restored. Bank activity remains paused until Sync Plaid.", 500) from error
    return generation
