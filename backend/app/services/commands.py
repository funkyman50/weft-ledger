from contextlib import contextmanager, nullcontext
from datetime import UTC, datetime, timedelta
from typing import Literal

from sqlalchemy import delete, insert, select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import CommandConfirmation
from app.services import ledger_history
from app.services import transaction_matching as matching


def _confirm(db: Session, manager: ledger_history.LedgerHistoryManager, context: ledger_history.PageRequest | None, label: str):
    db.flush()
    if context is None:
        return
    table = CommandConfirmation.__table__
    now = datetime.now(UTC).replace(tzinfo=None)
    db.execute(insert(table).values(
        request_id=context.request_id, database_generation=manager.database_generation,
        page_session=context.session, epoch=context.epoch, sequence=context.sequence,
        completed_at=now, label=label,
    ))
    db.execute(delete(table).where(table.c.completed_at < now - timedelta(days=14)))
    overflow = select(table.c.request_id).order_by(table.c.completed_at.desc(), table.c.request_id.desc()).offset(10_000)
    db.execute(delete(table).where(table.c.request_id.in_(overflow)))


def inspect_outcome(db: Session, manager: ledger_history.LedgerHistoryManager, context: ledger_history.PageRequest, generation: str) -> dict:
    outcome = {"request_id": context.request_id, "status": "expired", "message": "The previous save result is not recorded. Inspect the current data before continuing."}
    if generation != manager.database_generation:
        return outcome
    try:
        with manager.locked_page(context.session) as page:
            if page.epoch == context.epoch:
                outcome = manager.state(page, context.request_id, context.sequence)["outcome"]
    except AppError as error:
        if error.code != "history_expired":
            raise
    if outcome["status"] == "expired":
        confirmation = db.scalar(select(CommandConfirmation).where(
            CommandConfirmation.request_id == context.request_id,
            CommandConfirmation.database_generation == generation,
            CommandConfirmation.page_session == context.session,
            CommandConfirmation.epoch == context.epoch,
            CommandConfirmation.sequence == context.sequence,
            CommandConfirmation.completed_at >= datetime.now(UTC).replace(tzinfo=None) - timedelta(days=14),
        ))
        if confirmation is not None:
            return {"request_id": context.request_id, "status": "committed", "message": confirmation.label}
    return outcome


@contextmanager
def _page(db: Session, manager: ledger_history.LedgerHistoryManager):
    if not ledger_history.write_context(db).command:
        raise RuntimeError("Explicit commands require get_command_db.")
    context = ledger_history.write_context(db).request
    page_lock = manager.locked_page(context.session) if context else nullcontext()
    with page_lock as page:
        if context:
            if page.epoch != context.epoch:
                raise AppError("history_epoch_stale", "The register session changed. Your unsaved work is still here. Try again once the register finishes refreshing.", 409)
            if context.sequence <= page.highwater:
                raise AppError("history_request_stale", "This save request was already inspected or completed.", 409)
        yield page, context


@contextmanager
def ordinary(
    db: Session,
    manager: ledger_history.LedgerHistoryManager,
    *,
    history: Literal["capture", "invalidate", "preserve"],
    label: str,
):
    with _page(db, manager) as (page, context):
        try:
            if context:
                if history == "capture":
                    ledger_history.start_capture(db, manager, page, context.request_id, context.sequence, label)
                else:
                    ledger_history.start_completion(
                        db, manager, page, context.request_id, context.sequence,
                        message=label, preserve_history=history == "preserve",
                    )
            ledger_history.reserve_write(db)
            if history == "capture":
                matching.expire_stale_matches(db)
                db.flush()
            yield
            _confirm(db, manager, context, label)
            db.commit()
        except Exception:
            db.rollback()
            raise


@contextmanager
def page_operation(
    db: Session,
    manager: ledger_history.LedgerHistoryManager,
    *,
    label: str,
    history: Literal["preserve", "invalidate"] = "preserve",
    completion: Literal["return", "commit", "manual_commit"] = "return",
):
    with _page(db, manager) as (page, context):
        def mark_terminal_commit():
            if context:
                completion_state = ledger_history.start_completion(
                    db, manager, page, context.request_id, context.sequence,
                    message=label, preserve_history=history == "preserve",
                )
                completion_state.changed = True

        if context and completion == "commit":
            ledger_history.start_completion(
                db, manager, page, context.request_id, context.sequence,
                message=label, preserve_history=history == "preserve",
            )
        yield mark_terminal_commit
        if context and completion == "return":
            if history == "invalidate":
                manager.clear(page, context.request_id, context.sequence, label)
            else:
                manager.complete(page, context.request_id, context.sequence, label)
        elif context and ledger_history.write_context(db).completion:
            raise RuntimeError("Terminal command returned without committing.")


def replay(
    db: Session,
    manager: ledger_history.LedgerHistoryManager,
    *,
    action_id: str,
    expected_revision: int,
    direction: Literal["undo", "redo"],
) -> dict:
    with _page(db, manager) as (page, context):
        if context is None:
            raise AppError("history_metadata_invalid", "Undo request metadata is required.", 422)
        ledger_history.reserve_write(db)
        try:
            receipt, message = ledger_history.replay(db, page, action_id, expected_revision, direction)
            matching.reconcile(db, set(receipt.account_ids), allow_automatic=False, expire_stale=False)
            _confirm(db, manager, context, "Undo" if direction == "undo" else "Redo")
            ledger_history.record_lifecycle(db, "ledger_history", direction, "user_replay", account_count=len(receipt.account_ids))
            db.commit()
        except Exception:
            db.rollback()
            raise
        ledger_history.publish_replay(page, direction, message)
        manager.complete(page, context.request_id, context.sequence, message)
        return {**manager.state(page), "message": message, "account_ids": receipt.account_ids}


@contextmanager
def background(db: Session):
    try:
        ledger_history.reserve_write(db)
        yield
        db.commit()
    except Exception:
        db.rollback()
        raise
