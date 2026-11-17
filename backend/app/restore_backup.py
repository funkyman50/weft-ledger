import argparse
import getpass
import os
import sys
from pathlib import Path

from app import schema_admission
from app.auth import PasswordStore
from app.config import Settings, validate_installation_secret
from app.errors import AppError
from app.services import backup_package, backup_state, database_backup


def main():
    parser = argparse.ArgumentParser(description="Restore a current encrypted Weft backup while the app is stopped.")
    parser.add_argument("backup", type=Path)
    args = parser.parse_args()
    secret = os.environ.get("WEFT_SECRET", "")
    try:
        validate_installation_secret(secret)
    except ValueError as error:
        raise AppError("installation_secret_invalid", str(error), 503) from None
    settings = Settings(secret=secret, db_path=os.environ["WEFT_DB_PATH"])
    live_path = Path(settings.db_path)
    backup_state.load(live_path)
    if schema_admission.recovery_files(live_path):
        raise AppError("restore_sidecars_present", "Current database has SQLite recovery files. Preserve them and follow the SQLite recovery instructions in docs/OPERATIONS.md before restoring.", 409)
    recovery_key = getpass.getpass("Recovery key: ")
    with backup_package.decrypt_database(args.backup, recovery_key, settings) as (prepared, metadata):
        if not live_path.exists():
            PasswordStore(live_path).initialize()
        database_backup.promote_restore(live_path, prepared, settings.secret, metadata["recipient"])
    print(f"Restored {live_path}. Bank activity is paused until the first manual Sync Plaid press. Existing safety copies were retained.")


if __name__ == "__main__":
    try:
        main()
    except AppError as error:
        print(error.message, file=sys.stderr)
        raise SystemExit(1) from None
