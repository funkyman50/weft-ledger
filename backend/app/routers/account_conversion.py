from fastapi import APIRouter, Depends, Request
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.db import read_snapshot
from app.routers.deps import get_command_db, get_db
from app.schemas import (
    ConversionAttempt,
    ConversionDisconnectOut,
    ConversionLinkTokenStatus,
    ConversionReview,
    ExistingItemAccounts,
    LinkTokenOut,
    StatusAbandoned,
    StatusConnected,
)
from app.services import account_conversion, commands, plaid_settings
from app.services.plaid_client import PlaidClient


router = APIRouter(prefix="/api", tags=["account-conversion"])


def _client(request: Request, db: Session) -> PlaidClient:
    return PlaidClient(request.app.state.settings, db)


class ExchangeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    public_token: str
    configuration_identity: str = Field(min_length=64, max_length=64)
    provider_account_id: str
    institution: str = ""
    institution_id: str | None = None


class PairDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    feed_id: str
    history_id: int = Field(gt=0)
    state: str
    choices: dict | None = None


class ReadyDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    accepted: bool


class CommitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preview_token: str
    acknowledge_late_history: bool = False
    acknowledge_pending_overlap: bool = False


class ExistingItemStageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider_account_id: str


class DisconnectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    freeze_pending: bool = False


class LocalDisconnectRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    freeze_pending: Literal[True]


@router.post(
    "/accounts/{account_id}/conversion/link-token",
    response_model=ConversionLinkTokenStatus,
    response_model_exclude_unset=True,
)
def conversion_link_token(account_id: int, request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.page_operation(db, request.app.state.ledger_history, label="Bank conversion link token prepared."):
        client = _client(request, db)
        account_conversion.cleanup_orphaned_items(
            db,
            client,
            request.app.state.settings.secret,
        )
        result = account_conversion.link_token_status(db, account_id)
        if result["attempt"] is None:
            db.rollback()
            result["link_token"] = client.create_link_token()
            result["configuration_identity"] = client.credentials.identity_token
    return result


@router.post("/accounts/{account_id}/conversion/exchange", status_code=201, response_model=ConversionAttempt)
def conversion_exchange(account_id: int, payload: ExchangeRequest, request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.page_operation(db, request.app.state.ledger_history, label="Bank conversion staged.", completion="manual_commit") as mark_terminal_commit:
        plaid_settings.expect_identity(request.app.state.settings, payload.configuration_identity)
        result = account_conversion.exchange(db, account_id, payload.public_token, payload.institution, payload.institution_id, payload.provider_account_id, _client(request, db), request.app.state.settings.secret, request.app.state.plaid_sync_jobs, mark_terminal_commit)
    return result


@router.get("/accounts/{account_id}/conversion/existing-items/{item_id}/accounts", response_model=ExistingItemAccounts)
def existing_item_accounts(account_id: int, item_id: int, request: Request, db: Session = Depends(get_db)) -> dict:
    return account_conversion.existing_item_accounts(
        db, account_id, item_id, _client(request, db), request.app.state.settings.secret
    )


@router.post("/accounts/{account_id}/conversion/existing-items/{item_id}/update-link-token", response_model=LinkTokenOut)
def existing_item_update_link_token(account_id: int, item_id: int, request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.page_operation(db, request.app.state.ledger_history, label="Existing bank access token prepared."):
        result = account_conversion.existing_item_update_link_token(
            db, account_id, item_id, _client(request, db), request.app.state.settings.secret
        )
    return result


@router.post("/accounts/{account_id}/conversion/existing-items/{item_id}/stage", status_code=201, response_model=ConversionAttempt)
def stage_existing_item(
    account_id: int,
    item_id: int,
    payload: ExistingItemStageRequest,
    request: Request,
    db: Session = Depends(get_command_db),
) -> dict:
    with commands.page_operation(db, request.app.state.ledger_history, label="Bank conversion staged.", completion="commit"):
        result = account_conversion.stage_existing_item(
            db,
            account_id,
            item_id,
            payload.provider_account_id,
            _client(request, db),
            request.app.state.settings.secret,
            request.app.state.plaid_sync_jobs,
        )
    return result


@router.get("/account-conversion", response_model=ConversionAttempt | None)
def current_conversion(db: Session = Depends(get_db)) -> dict | None:
    attempt = account_conversion._active_attempt(db)
    return account_conversion.summary(db, attempt) if attempt else None


@router.post("/account-conversion/{attempt_id}/refresh", response_model=ConversionAttempt)
def refresh_conversion(attempt_id: str, request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.page_operation(db, request.app.state.ledger_history, label="Bank conversion refresh request saved.", completion="commit"):
        result = account_conversion.request_fetch(db, attempt_id, request.app.state.plaid_sync_jobs)
    return result


@router.get("/account-conversion/{attempt_id}/review", response_model=ConversionReview, response_model_exclude_unset=True)
def conversion_review(
    attempt_id: str,
    bucket: str = "ready",
    feed_cursor: str | None = None,
    history_cursor: str | None = None,
    feed_text: str | None = None,
    history_text: str | None = None,
    feed_date: str | None = None,
    history_date: str | None = None,
    feed_amount: int | None = None,
    history_amount: int | None = None,
    selected_feed_id: str | None = None,
    selected_history_id: int | None = None,
    db: Session = Depends(get_db),
) -> dict:
    with read_snapshot(db):
        return account_conversion.review(db, attempt_id, bucket, feed_cursor=feed_cursor, history_cursor=history_cursor, feed_text=feed_text, history_text=history_text, feed_date=feed_date, history_date=history_date, feed_amount=feed_amount, history_amount=history_amount, selected_feed_id=selected_feed_id, selected_history_id=selected_history_id)


@router.post("/account-conversion/{attempt_id}/pair", response_model=ConversionAttempt)
def conversion_pair(attempt_id: str, payload: PairDecision, request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.ordinary(db, request.app.state.ledger_history, history="preserve", label="Bank conversion pair decision saved."):
        result = account_conversion.decide(db, attempt_id, payload.feed_id, payload.history_id, payload.state, payload.choices)
    return result


@router.post("/account-conversion/{attempt_id}/ready", response_model=ConversionAttempt)
def conversion_ready(attempt_id: str, payload: ReadyDecision, request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.ordinary(db, request.app.state.ledger_history, history="preserve", label="Bank conversion ready decision saved."):
        result = account_conversion.set_ready(db, attempt_id, payload.accepted)
    return result


@router.post("/account-conversion/{attempt_id}/review-new", response_model=ConversionAttempt)
def conversion_review_new(attempt_id: str, payload: ReadyDecision, request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.ordinary(db, request.app.state.ledger_history, history="preserve", label="Bank conversion new-row review saved."):
        result = account_conversion.review_new(db, attempt_id, payload.accepted)
    return result


@router.post("/account-conversion/{attempt_id}/commit", response_model=StatusConnected)
def conversion_commit(attempt_id: str, payload: CommitRequest, request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.page_operation(db, request.app.state.ledger_history, label="Bank connection completed.", history="invalidate"):
        result = request.app.state.plaid_sync_jobs.commit_conversion(
            db,
            attempt_id,
            payload.preview_token,
            payload.acknowledge_late_history,
            payload.acknowledge_pending_overlap,
            _client(request, db),
            request.app.state.settings.secret,
        )
    return result


@router.delete("/account-conversion/{attempt_id}", response_model=StatusAbandoned)
def abandon_conversion(attempt_id: str, request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.page_operation(db, request.app.state.ledger_history, label="Bank conversion abandoned."):
        result = account_conversion.abandon(db, attempt_id, _client(request, db), request.app.state.settings.secret)
    return result


@router.post("/accounts/{account_id}/disconnect-bank", response_model=ConversionDisconnectOut)
def disconnect_bank(account_id: int, payload: DisconnectRequest, request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.page_operation(db, request.app.state.ledger_history, label="Bank disconnected.", history="invalidate"):
        result = account_conversion.disconnect(db, account_id, payload.freeze_pending, lambda: _client(request, db), request.app.state.settings.secret)
    return result


@router.post("/accounts/{account_id}/disconnect-bank-locally", response_model=ConversionDisconnectOut)
def disconnect_bank_locally(
    account_id: int,
    payload: LocalDisconnectRequest,
    request: Request,
    db: Session = Depends(get_command_db),
) -> dict:
    with commands.page_operation(db, request.app.state.ledger_history, label="Bank disconnected locally.", history="invalidate"):
        result = account_conversion.disconnect_locally(
            db, account_id, payload.freeze_pending, request.app.state.settings.secret
        )
    return result
