from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.db import read_snapshot
from app.routers.deps import get_command_db, get_db
from app.schemas import (
    AccountClosePreview,
    AccountCloseRequest,
    AccountCreate,
    AccountDeletionPreview,
    AccountDeletionRequest,
    AccountOut,
    AccountReorder,
    AccountUpdate,
    StartingBalanceConfirmRequest,
    StartingBalanceContext,
    StartingBalancePreview,
    StartingBalancePreviewRequest,
    StartingBalanceSuggestion,
    StartingBalanceSuggestionRequest,
    StatusDeleted,
)
from app.services import account_conversion, commands
from app.services import account_initialization as initialization
from app.services import accounts as account_service
from app.services.plaid_client import PlaidClient

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


@router.get("", response_model=list[AccountOut])
def list_accounts(db: Session = Depends(get_db)):
    with read_snapshot(db):
        return account_service.list_accounts(db)


@router.get("/{account_id}/starting-balance", response_model=StartingBalanceContext)
def get_starting_balance(account_id: int, db: Session = Depends(get_db)):
    with read_snapshot(db):
        return initialization.starting_balance_context(db, account_id)


@router.post(
    "/{account_id}/starting-balance/preview", response_model=StartingBalancePreview
)
def preview_starting_balance(
    account_id: int,
    payload: StartingBalancePreviewRequest,
    db: Session = Depends(get_db),
):
    with read_snapshot(db):
        return initialization.starting_balance_preview(
            db,
            account_id,
            payload.context_token,
            payload.reference_balance_cents,
            payload.included_pending,
        )


@router.post(
    "/{account_id}/starting-balance/suggestion", response_model=StartingBalanceSuggestion
)
def suggest_starting_balance(
    account_id: int,
    payload: StartingBalanceSuggestionRequest,
    db: Session = Depends(get_db),
):
    with read_snapshot(db):
        return initialization.starting_balance_suggestion(
            db, account_id, payload.context_token, payload.reference_balance_cents
        )


@router.post("/{account_id}/starting-balance/confirm", response_model=StartingBalanceContext)
def confirm_starting_balance(
    account_id: int,
    payload: StartingBalanceConfirmRequest,
    request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="invalidate", label="A saved change ended earlier undo history."):
        result = initialization.confirm_starting_balance(
            db,
            account_id,
            payload.preview_token,
            payload.reference_balance_cents,
            payload.included_pending,
        )
    return result


@router.post("", status_code=201, response_model=AccountOut)
def create_account(
    payload: AccountCreate, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="invalidate", label="A saved change ended earlier undo history."):
        result = AccountOut.model_validate(account_service.create(db, payload))
    return result


@router.patch("/{account_id}", response_model=AccountOut)
def update_account(
    account_id: int, payload: AccountUpdate, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="invalidate", label="A saved change ended earlier undo history."):
        result = AccountOut.model_validate(account_service.update(db, account_id, payload))
    return result


@router.get("/{account_id}/close-preview", response_model=AccountClosePreview)
def close_preview(account_id: int, db: Session = Depends(get_db)):
    return account_service.close_preview(db, account_id)


@router.post("/{account_id}/close", response_model=AccountOut)
def close_account(
    account_id: int,
    payload: AccountCloseRequest,
    request: Request,
    db: Session = Depends(get_command_db),
):
    if payload.disconnect_bank:
        with commands.page_operation(db, request.app.state.ledger_history, label="Account closed.", history="invalidate", completion="commit"):
            account = account_conversion.close(
                db,
                account_id,
                lambda: PlaidClient(request.app.state.settings, db),
                request.app.state.settings.secret,
                payload.preview_token,
            )
            result = AccountOut.model_validate(account_service.serialize(db, account))
    else:
        with commands.ordinary(db, request.app.state.ledger_history, history="invalidate", label="Account closed."):
            result = AccountOut.model_validate(account_service.close(db, account_id, payload.preview_token))
    return result


@router.post("/{account_id}/reopen", response_model=AccountOut)
def reopen_account(
    account_id: int, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="invalidate", label="A saved change ended earlier undo history."):
        result = AccountOut.model_validate(account_service.reopen(db, account_id))
    return result


@router.put("/reorder", response_model=list[AccountOut])
def reorder_accounts(
    payload: AccountReorder, request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="invalidate", label="A saved change ended earlier undo history."):
        result = [AccountOut.model_validate(account) for account in account_service.reorder(db, payload)]
    return result


@router.get("/{account_id}/deletion-preview", response_model=AccountDeletionPreview)
def get_deletion_preview(account_id: int, db: Session = Depends(get_db)):
    with read_snapshot(db):
        return account_service.deletion_preview(db, account_id)


@router.post("/{account_id}/delete", response_model=StatusDeleted)
def delete_account(
    account_id: int,
    payload: AccountDeletionRequest,
    request: Request,
    db: Session = Depends(get_command_db),
) -> dict:
    with commands.page_operation(db, request.app.state.ledger_history, label="Account deleted.", history="invalidate"):
        result = account_service.delete(
            db,
            account_id,
            payload.preview_token,
            lambda: PlaidClient(request.app.state.settings, db),
            request.app.state.settings.secret,
        )
    return result
