from contextlib import closing
from pathlib import Path
import sqlite3


SCHEMA_SQL = Path(__file__).with_name("schema.sql").read_text()


class SchemaError(ValueError):
    pass


def recovery_files(path: Path) -> list[Path]:
    return [candidate for suffix in ("-journal", "-wal", "-shm") if (candidate := path.with_name(path.name + suffix)).exists()]


def _schema_objects(connection: sqlite3.Connection) -> tuple:
    return tuple(
        (kind, name, " ".join((sql or "").split()))
        for kind, name, sql in connection.execute(
            "SELECT type, name, sql FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
        )
    )


with closing(sqlite3.connect(":memory:")) as _template:
    _template.executescript(SCHEMA_SQL)
    SCHEMA_REVISION = _template.execute("PRAGMA user_version").fetchone()[0]
    CURRENT_SCHEMA = _schema_objects(_template)


def _integrity(connection: sqlite3.Connection) -> None:
    if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise SchemaError("The database failed SQLite integrity validation.")
    if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise SchemaError("The database has invalid references.")


def validate(path: Path) -> None:
    try:
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
            revision = connection.execute("PRAGMA user_version").fetchone()[0]
            if revision != SCHEMA_REVISION:
                raise SchemaError(f"Database revision {revision} is unsupported; current revision is {SCHEMA_REVISION}.")
            _integrity(connection)
            if _schema_objects(connection) != CURRENT_SCHEMA:
                raise SchemaError(f"The database structure does not match revision {revision}.")
            from app.services.account_logos import validate_saved_library

            try:
                validate_saved_library(connection)
            except ValueError as error:
                raise SchemaError(str(error)) from error
            if len(connection.execute("SELECT DISTINCT client_id_hash, environment FROM plaid_items LIMIT 2").fetchall()) > 1:
                raise SchemaError("Saved bank connections have conflicting Plaid owners.")
            if connection.execute(
                "SELECT 1 FROM payee_rules WHERE json_type(amount) = 'object' "
                "AND COALESCE(json_extract(amount, '$.direction'), '') NOT IN ('inflow', 'outflow') LIMIT 1"
            ).fetchone() is not None:
                raise SchemaError("A saved payee rule has an unsupported amount direction. Amount conditions require Inflow or Outflow.")
    except sqlite3.Error as error:
        if sidecars := recovery_files(path):
            raise SchemaError(
                f"SQLite could not read the database while recovery files are present ({', '.join(file.name for file in sidecars)}). "
                "Stop the app and follow the SQLite recovery instructions in docs/OPERATIONS.md. Preserve the database and recovery files together; do not delete them."
            ) from error
        raise SchemaError("The file is not a readable Weft database.") from error
