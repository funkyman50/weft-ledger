from uuid import UUID

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.errors import AppError
from app.routers.deps import get_command_db, get_db
from app.schemas import LedgerHistoryReplay, LedgerHistoryReplayOut, LedgerHistoryStateOut
from app.services import commands, ledger_history


router = APIRouter(prefix="/api/ledger-history", tags=["ledger-history"])


def _session_header(request: Request) -> str:
    value = request.headers.get("X-Ledger-Session")
    try:
        UUID(value or "")
    except ValueError as error:
        raise AppError("history_metadata_invalid", "Ledger history session is invalid.", 422) from error
    return value


@router.get("", response_model=LedgerHistoryStateOut, response_model_exclude_unset=True)
def state(
    request: Request,
    request_id: str | None = None,
    request_sequence: int | None = None,
    epoch: str | None = None,
    request_session: str | None = None,
    request_generation: str | None = None,
    db: Session = Depends(get_db),
) -> dict:
    for value in (request_id, epoch, request_session, request_generation):
        if value is not None:
            try:
                UUID(value)
            except ValueError as error:
                raise AppError("history_metadata_invalid", "Ledger history request identity is invalid.", 422) from error
    if request_id is not None and (request_sequence is None or request_sequence <= 0 or not epoch or not request_session or not request_generation):
        raise AppError("history_metadata_invalid", "Ledger history request identity is incomplete.", 422)
    manager = request.app.state.ledger_history
    session = _session_header(request)
    outcome = commands.inspect_outcome(db, manager, ledger_history.PageRequest(
        session=request_session, request_id=request_id, sequence=request_sequence, epoch=epoch,
    ), request_generation) if request_id is not None else None
    with manager.locked_page(session, create=True) as page:
        state = {**manager.state(page), "database_generation": manager.database_generation, "outcome": outcome}
        if request_id is None and epoch is not None and epoch != page.epoch:
            state["notice"] = "Earlier Undo history is no longer available. Your unsaved work is still here."
        return state


def _replay(request: Request, payload: LedgerHistoryReplay, direction: str, db: Session):
    return commands.replay(
        db, request.app.state.ledger_history,
        action_id=payload.action_id,
        expected_revision=payload.expected_revision,
        direction=direction,
    )


@router.post("/undo", response_model=LedgerHistoryReplayOut, response_model_exclude_unset=True)
def undo(payload: LedgerHistoryReplay, request: Request, db: Session = Depends(get_command_db)):
    return _replay(request, payload, "undo", db)


@router.post("/redo", response_model=LedgerHistoryReplayOut, response_model_exclude_unset=True)
def redo(payload: LedgerHistoryReplay, request: Request, db: Session = Depends(get_command_db)):
    return _replay(request, payload, "redo", db)
