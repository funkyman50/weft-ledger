from uuid import UUID

from fastapi import Request
from sqlalchemy.orm import Session

from app.errors import AppError
from app.services.ledger_history import PageRequest, write_context


def _header_context(request: Request) -> PageRequest | None:
    headers = request.headers
    values = {
        "session": headers.get("X-Ledger-Session"),
        "request_id": headers.get("X-Ledger-Request"),
        "sequence": headers.get("X-Ledger-Sequence"),
        "epoch": headers.get("X-Ledger-Epoch"),
    }
    if not any(values.values()):
        return None
    if not all(values.values()):
        raise AppError("history_metadata_invalid", "Ledger history request metadata is incomplete.", 422)
    try:
        UUID(values["session"])
        UUID(values["request_id"])
        sequence = int(values["sequence"])
        UUID(values["epoch"])
    except (ValueError, TypeError) as error:
        raise AppError("history_metadata_invalid", "Ledger history request metadata is invalid.", 422) from error
    if sequence <= 0:
        raise AppError("history_metadata_invalid", "Ledger history sequence must be positive.", 422)
    return PageRequest(session=values["session"], request_id=values["request_id"], sequence=sequence, epoch=values["epoch"])


def _get_db(request: Request, *, command: bool):
    session_local = request.app.state.session_local
    with request.app.state.database_gate.admit():
        db: Session = session_local()
        try:
            if command:
                context = write_context(db)
                context.command = True
                context.request = _header_context(request)
            yield db
        finally:
            if db.in_transaction():
                db.rollback()
            db.close()


def get_db(request: Request):
    yield from _get_db(request, command=False)


def get_command_db(request: Request):
    yield from _get_db(request, command=True)
