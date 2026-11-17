from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from app.db import read_snapshot
from app.errors import AppError
from app.routers.deps import get_command_db, get_db
from app.schemas import (
    AccountScopeFilter,
    TransactionConnectionsContext,
    BankContinuityReject,
    LedgerFilter,
    LedgerFilterChoices,
    LedgerFilterSuggestionQuery,
    LedgerFilterSuggestions,
    LedgerPageQuery,
    LedgerHistoryPreview,
    LedgerPage,
    LedgerRow,
    MatchFinderContext,
    PendingLifecycleContext,
    PendingLifecycleDisappear,
    PendingLifecycleResolve,
    StatusOk,
    Target,
    TransactionBulkApply,
    TransactionBulkApplyResult,
    TransactionBulkMove,
    TransactionClearance,
    TransactionCreate,
    LedgerExport,
    TransactionManualClearance,
    TransactionMatchContext,
    TransactionMatchCreate,
    TransactionUnmatch,
    TransactionReview,
    TransactionTargets,
    TransactionUpdate,
    TransferCommand,
    TransferContext,
    TransferCounterpartCommand,
    TransferDraftCommand,
    TransferDraftContextRequest,
    TransferLinkCommand,
    TransferResult,
    TransferReviewCommand,
    TransferReviewContextRequest,
)
from app.services import (
    bank_continuity,
    commands,
    ledger,
    ledger_export,
    ledger_history,
    ledger_projection,
    payee_identity,
    pending_lifecycle,
    transfers,
)
from app.services import (
    transaction_matching as matching,
)

router = APIRouter(prefix="/api/transactions", tags=["transactions"])
exports_router = APIRouter(prefix="/api/exports", tags=["exports"])
matches_router = APIRouter(
    prefix="/api/transaction-matches", tags=["transaction-matches"]
)


@router.get("/transfer-payee-suggestion")
def transfer_payee_suggestion(account_id: int, transfer_account_id: int, direction: int, on_date: date, db: Session = Depends(get_db)) -> dict[str, int | None]:
    if direction not in (-1, 1):
        raise AppError("transfer_direction_invalid", "Choose an inflow or outflow direction.", 422)
    with read_snapshot(db):
        return {"payee_id": payee_identity.suggested_payee_id(db, account_id, transfer_account_id, direction, on_date)}


@router.get("/filter-choices", response_model=LedgerFilterChoices)
def filter_choices(scope: Annotated[AccountScopeFilter, Query()], db: Session = Depends(get_db)):
    with read_snapshot(db):
        return ledger_projection.filter_choices(db, scope.account_id, scope.group_name)


@router.get("/filter-suggestions", response_model=LedgerFilterSuggestions)
def filter_suggestions(query: Annotated[LedgerFilterSuggestionQuery, Query()], db: Session = Depends(get_db)):
    with read_snapshot(db):
        return {"values": ledger_projection.filter_suggestions(db, query.account_id, query.group_name, query.field, query.q)}


@router.get("", response_model=LedgerPage)
def list_transactions(
    filters: Annotated[LedgerPageQuery, Query()],
    db: Session = Depends(get_db),
):
    with read_snapshot(db):
        return ledger_projection.read_page(
            db,
            filters,
            page_size=filters.page_size,
            before_date=filters.before_date,
            before_id=filters.before_id,
            before_order=filters.before_order,
            include_pinned=filters.include_pinned,
            through_date=filters.through_date,
        )


@router.get("/selection", response_model=list[LedgerRow])
def list_transaction_selection(
    filters: Annotated[LedgerFilter, Query()],
    db: Session = Depends(get_db),
):
    with read_snapshot(db):
        return ledger_projection.read_selection(db, filters)


@router.post("/history-preview", response_model=LedgerHistoryPreview)
def preview_history(payload: TransactionTargets, db: Session = Depends(get_db)):
    ledger_projection.selected_snapshots(db, payload.targets, set())
    return {
        "warning": ledger_history.preview_receipt_warning(
            db, {target.id for target in payload.targets}
        )
    }


@exports_router.post("", response_class=Response)
def export_ledger(payload: LedgerExport, db: Session = Depends(get_db)) -> Response:
    with read_snapshot(db):
        content, filename, media_type = ledger_export.download_export(db, **payload.model_dump())
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("", status_code=201, response_model=LedgerRow)
def create_transaction(
    payload: TransactionCreate, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Transaction created"):
        result = LedgerRow.model_validate(ledger.create_transaction(db, payload))
    return result


@router.patch("/{transaction_id}", response_model=LedgerRow)
def edit_transaction(
    transaction_id: int, payload: TransactionUpdate, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Transaction edit"):
        result = LedgerRow.model_validate(ledger.edit_transaction(db, transaction_id, payload))
    return result


@router.get("/{transaction_id:int}", response_model=LedgerRow)
def get_transaction(transaction_id: int, db: Session = Depends(get_db)):
    return ledger_projection.read_transaction(db, transaction_id)


@router.post("/bulk-apply", response_model=TransactionBulkApplyResult)
def bulk_apply_transactions(
    payload: TransactionBulkApply, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Bulk transaction change"):
        result = TransactionBulkApplyResult.model_validate(ledger.bulk_apply(db, payload))
    return result


@router.post("/bulk-move", response_model=StatusOk)
def bulk_move_transactions(
    payload: TransactionBulkMove, request: Request,
    db: Session = Depends(get_command_db),
) -> dict:
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Transaction move"):
        ledger.bulk_move(db, payload.targets, payload.destination_account_id)
    return {"status": "ok"}


@router.post("/bulk-delete", response_model=StatusOk)
def bulk_delete_transactions(
    payload: TransactionTargets, request: Request,
    db: Session = Depends(get_command_db),
) -> dict:
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Transaction deletion"):
        ledger.bulk_delete(db, payload.targets)
    return {"status": "ok"}


@router.post("/exclude", response_model=LedgerRow)
def exclude_transaction(
    payload: TransactionTargets, request: Request,
    db: Session = Depends(get_command_db),
):
    if len(payload.targets) != 1:
        raise AppError("transaction_exclude_single_row", "Exclude one bank transaction at a time.", 422)
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Bank transaction exclusion"):
        value = ledger.exclude(db, payload.targets[0])
        db.flush()
        result = LedgerRow.model_validate(value)
    return result


@router.post("/restore", response_model=StatusOk)
def restore_transactions(
    payload: TransactionTargets, request: Request,
    db: Session = Depends(get_command_db),
) -> dict:
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Bank transaction restore"):
        ledger.restore(db, payload.targets)
    return {"status": "ok"}


@router.post("/{transaction_id}/clearance", response_model=LedgerRow)
def set_clearance(
    transaction_id: int, payload: TransactionClearance, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Clearance change"):
        result = LedgerRow.model_validate(ledger.set_clearance(db, transaction_id, payload.intent))
    return result


@router.post("/{transaction_id}/manual-clearance", response_model=LedgerRow)
def set_manual_clearance(
    transaction_id: int,
    payload: TransactionManualClearance,
    request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Manual clearance change"):
        value = ledger.manual_clearance(
            db,
            Target(id=transaction_id, edit_token=payload.expected_edit_token),
            payload.intent,
        )
        result = LedgerRow.model_validate(value)
    return result


@router.post("/review", response_model=StatusOk)
def review_transactions(
    payload: TransactionReview, request: Request,
    db: Session = Depends(get_command_db),
) -> dict:
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Review change"):
        ledger.review_transactions(db, payload)
    return {"status": "ok"}


@matches_router.get("/context", response_model=TransactionMatchContext)
def match_context(
    feed_transaction_id: int,
    history_transaction_id: int,
    db: Session = Depends(get_db),
):
    return matching.read_pair_context(db, feed_transaction_id, history_transaction_id)


@matches_router.get("/find-context", response_model=MatchFinderContext)
def find_match_context(
    source_transaction_id: int,
    scope: str = "nearby",
    candidate_id: int | None = None,
    cursor: str | None = None,
    db: Session = Depends(get_db),
):
    return matching.finder_context(db, source_transaction_id, scope, candidate_id, cursor)


@matches_router.get("/{match_id}", response_model=TransactionMatchContext)
def get_match(match_id: int, db: Session = Depends(get_db)):
    return matching.read_match_context(db, match_id)


@matches_router.post("", response_model=LedgerRow)
def create_match(
    payload: TransactionMatchCreate, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Match change"):
        result = LedgerRow.model_validate(matching.create_match(db, payload))
    return result


@matches_router.post("/{match_id}/dismiss", response_model=TransactionMatchContext)
def dismiss_match(
    match_id: int, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Match dismissal"):
        result = matching.dismiss_match(db, match_id)
    return result


@matches_router.post("/{match_id}/unmatch", response_model=TransactionMatchContext)
def unmatch_match(
    match_id: int, payload: TransactionUnmatch, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Match removal"):
        result = matching.unmatch_match(db, match_id, payload.context_token)
    return result


@router.get("/connections/context", response_model=TransactionConnectionsContext)
def transaction_connections(transaction_id: int, db: Session = Depends(get_db)):
    with read_snapshot(db):
        return TransactionConnectionsContext.model_validate(bank_continuity.read_connections(db, transaction_id))


@router.post("/bank-continuity/reject", response_model=StatusOk)
def reject_bank_continuity(payload: BankContinuityReject, request: Request, db: Session = Depends(get_command_db)):
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Bank association rejection"):
        bank_continuity.reject(db, payload.transaction_id, payload.record_id, payload.context_token)
    return {"status": "ok"}


@router.get(
    "/pending-lifecycle/context",
    response_model=PendingLifecycleContext,
)
def pending_context(
    pending_transaction_id: int,
    cleared_transaction_id: int | None = None,
    db: Session = Depends(get_db),
):
    return pending_lifecycle.read_context(db, pending_transaction_id, cleared_transaction_id)


@router.post("/pending-lifecycle/resolve", response_model=LedgerRow)
def resolve_pending(
    payload: PendingLifecycleResolve, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="invalidate", label="A saved change ended earlier undo history."):
        txn = pending_lifecycle.resolve(
            db,
            payload.pending_transaction_id,
            payload.cleared_transaction_id,
            payload.context_token,
            payload.selections.model_dump(),
            payload.row_edits,
        )
        result = LedgerRow.model_validate(ledger_projection.row(db, txn))
    return result


@router.post("/pending-lifecycle/disappear", response_model=StatusOk)
def disappear_pending(
    payload: PendingLifecycleDisappear, request: Request,
    db: Session = Depends(get_command_db),
) -> dict:
    with commands.ordinary(db, request.app.state.ledger_history, history="invalidate", label="A saved change ended earlier undo history."):
        pending_lifecycle.disappear(
            db,
            payload.pending_transaction_id,
            payload.context_token,
            payload.cleared_transaction_id,
        )
    return {"status": "ok"}


@router.get("/{transaction_id}/transfer-context", response_model=TransferContext)
def transfer_context(
    transaction_id: int,
    scope: str = "nearby",
    candidate_id: int | None = None,
    cursor: str | None = None,
    db: Session = Depends(get_db),
):
    return transfers.context(db, transaction_id, scope, candidate_id, cursor)


@router.post("/{transaction_id}/transfer-review-context", response_model=TransferContext)
def transfer_review_context(
    transaction_id: int,
    payload: TransferReviewContextRequest,
    db: Session = Depends(get_db),
):
    return transfers.review_context(
        db,
        transaction_id,
        payload.proposal,
        payload.expected_edit_token,
        payload.scope,
        payload.candidate_id,
        payload.cursor,
    )


@router.post("/{transaction_id}/transfer-review", response_model=TransferResult)
def review_transfer(
    transaction_id: int,
    payload: TransferReviewCommand,
    request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Transfer review"):
        value = transfers.review(
            db,
            transaction_id,
            payload.proposal,
            payload.context_token,
            payload.intent,
            payload.candidate_id,
            payload.row_edits,
        )
        result = TransferResult.model_validate(value)
    return result


@router.post("/transfer-draft-context", response_model=TransferContext)
def transfer_draft_context(
    payload: TransferDraftContextRequest, db: Session = Depends(get_db)
):
    return transfers.draft_context(
        db,
        payload.account_id,
        payload.proposal,
        payload.scope,
        payload.candidate_id,
        payload.cursor,
    )


@router.post("/transfer-draft", response_model=TransferResult)
def create_transfer_draft(
    payload: TransferDraftCommand, request: Request, db: Session = Depends(get_command_db)
):
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Transfer creation"):
        value = transfers.draft_review(
            db,
            payload.account_id,
            payload.proposal,
            payload.context_token,
            payload.intent,
            payload.candidate_id,
            payload.row_edits,
        )
        result = TransferResult.model_validate(value)
    return result


@router.post("/{transaction_id}/transfer-link", response_model=TransferResult)
def link_transfer(
    transaction_id: int, payload: TransferLinkCommand, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Transfer link"):
        value = transfers.link(db, transaction_id, payload.candidate_id, payload.context_token, payload.row_edits)
        result = TransferResult.model_validate(value)
    return result


@router.post("/{transaction_id}/transfer-counterpart", response_model=TransferResult)
def create_transfer_counterpart(
    transaction_id: int,
    payload: TransferCounterpartCommand,
    request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Transfer counterpart"):
        value = transfers.counterpart(
            db, transaction_id, payload.context_token, payload.candidate_id, payload.row_edits
        )
        result = TransferResult.model_validate(value)
    return result


@router.post("/{transaction_id}/transfer-unlink", response_model=TransferResult)
def unlink_transfer(
    transaction_id: int, payload: TransferCommand, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Transfer unlink"):
        value = transfers.unlink(db, transaction_id, payload.context_token)
        result = TransferResult.model_validate(value)
    return result
