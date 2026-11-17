import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from uuid import UUID, uuid4

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session, declarative_base, sessionmaker

from app import schema_admission

# History queries bind each ID up to three times; stay below 999 including fixed parameters.
SQL_ID_BATCH_SIZE = 300

Base = declarative_base()
CATEGORY_SEED_SQL = Path(__file__).with_name("category_seeds.sql").read_text()


def rotate_database_generation(path: Path) -> str:
    marker = path.with_name(f"{path.name}.generation")
    temporary = marker.with_name(f"{marker.name}-{uuid4().hex}")
    value = str(uuid4())
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            output.write(value + "\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, marker)
        directory = os.open(marker.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
    return value


def database_generation(path: Path) -> str:
    marker = path.with_name(f"{path.name}.generation")
    try:
        return str(UUID(marker.read_text().strip()))
    except FileNotFoundError:
        return rotate_database_generation(path)
    except ValueError as error:
        raise RuntimeError("Database generation marker is invalid.") from error


def make_session_factory(db_path: str):
    engine = create_engine(f"sqlite:///{db_path}")

    @event.listens_for(engine, "connect")
    def _enable_foreign_keys(connection, _record):
        connection.execute("PRAGMA foreign_keys=ON")

    return engine, sessionmaker(bind=engine, autoflush=False, autocommit=False)


@contextmanager
def read_snapshot(db: Session):
    try:
        db.execute(text("BEGIN"))
        yield
    finally:
        db.rollback()


def _path_for(engine) -> Path:
    path = engine.url.database
    if not path or path == ":memory:":
        raise RuntimeError("Weft requires a file-backed SQLite database")
    return Path(path)


def _create_schema(path: Path) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.executescript(schema_admission.SCHEMA_SQL)
        connection.executescript(CATEGORY_SEED_SQL)
        connection.commit()
    finally:
        connection.close()


def _initialize_managed_payees(path: Path) -> None:
    from app.services.payees import initialize_managed_payees

    engine, session_local = make_session_factory(str(path))
    db = session_local()
    try:
        initialize_managed_payees(db)
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
        engine.dispose()


def init_db(engine) -> None:
    path = _path_for(engine)
    path.parent.mkdir(parents=True, exist_ok=True)
    engine.dispose()
    if path.with_name(f"{path.name}.generation").exists():
        database_generation(path)

    if path.exists():
        try:
            schema_admission.validate(path)
        except schema_admission.SchemaError as error:
            raise RuntimeError(f"{error} Saved data was preserved; normal startup is blocked.") from error
        database_generation(path)
        return

    temporary = path.with_name(f"{path.stem}.create-{uuid4().hex}.db")
    try:
        _create_schema(temporary)
        _initialize_managed_payees(temporary)
        schema_admission.validate(temporary)
        os.replace(temporary, path)
        rotate_database_generation(path)
    finally:
        temporary.unlink(missing_ok=True)
