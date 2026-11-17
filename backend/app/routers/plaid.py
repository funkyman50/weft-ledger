from typing import Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.db import read_snapshot
from app.routers.deps import get_command_db, get_db
from app.schemas import AccountCreate, LinkTokenOut, PlaidExchangeOut, PlaidStatus
from app.services import account_conversion, backup_state, commands, plaid_settings
from app.services.plaid_client import PlaidClient
from app.services.plaid_sync import status as sync_status

router = APIRouter(prefix="/api/plaid", tags=["plaid"])


def _client(request: Request, db: Session) -> PlaidClient:
    return PlaidClient(request.app.state.settings, db)


@router.post("/link-token", response_model=LinkTokenOut)
def create_link_token(request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.page_operation(db, request.app.state.ledger_history, label="Bank link token prepared."):
        client = _client(request, db)
        result = {"link_token": account_conversion.new_link_token(db, client, request.app.state.settings.secret), "configuration_identity": client.credentials.identity_token}
    return result


@router.post("/accounts/{account_id}/repair-link-token", response_model=LinkTokenOut)
def create_repair_link_token(
    account_id: int, request: Request, db: Session = Depends(get_command_db)
) -> dict:
    with commands.page_operation(db, request.app.state.ledger_history, label="Bank repair token prepared."):
        result = {"link_token": account_conversion.repair_link_token(db, account_id, lambda: _client(request, db), request.app.state.settings.secret)}
    return result


class ExchangeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    public_token: str
    configuration_identity: str = Field(min_length=64, max_length=64)
    institution: str = ""
    institution_id: str | None = None
    accounts: dict[str, AccountCreate] = Field(min_length=1)


@router.post("/exchange", status_code=201, response_model=PlaidExchangeOut)
def exchange(payload: ExchangeRequest, request: Request, db: Session = Depends(get_command_db)) -> dict:
    with commands.page_operation(db, request.app.state.ledger_history, label="Bank connection created.", history="invalidate", completion="manual_commit") as mark_terminal_commit:
        plaid_settings.expect_identity(request.app.state.settings, payload.configuration_identity)
        return account_conversion.connect_new_accounts(
            db, payload.public_token, payload.institution, payload.institution_id,
            payload.accounts, lambda: _client(request, db),
            request.app.state.settings.secret, mark_terminal_commit,
        )


@router.post("/sync", response_model=PlaidStatus)
def sync_now(request: Request, db: Session = Depends(get_command_db)) -> PlaidStatus:
    with commands.page_operation(db, request.app.state.ledger_history, label="Bank sync invocation finished."):
        if plaid_settings.custody_identity(db) is not None:
            plaid_settings.require_configured(db, request.app.state.settings)
        backup_state.resume_bank_sync(request.app.state.settings.db_path)
        result = PlaidStatus.model_validate(
            request.app.state.plaid_sync_jobs.run(db=db)
        )
    return result


@router.get("/status", response_model=PlaidStatus)
def status(request: Request, db: Session = Depends(get_db)):
    return {
        **sync_status(db),
        "bank_sync_paused": backup_state.bank_sync_paused(request.app.state.settings.db_path),
        "initial_import_account_ids": request.app.state.plaid_sync_jobs.initial_import_account_ids(db),
    }


class SettingsRevision(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_revision: str = Field(min_length=1, max_length=64)


class SettingsRequest(SettingsRevision):
    client_id: str = Field(min_length=1, max_length=256)
    secret: str | None = Field(default=None, min_length=1, max_length=256)
    environment: Literal["production", "sandbox"]


@router.get("/settings")
def settings_status(request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    response.headers["Cache-Control"] = "no-store"
    with read_snapshot(db):
        return plaid_settings.status(db, request.app.state.settings)


@router.post("/settings")
def save_settings(payload: SettingsRequest, request: Request, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    with request.app.state.database_gate.maintenance():
        with request.app.state.plaid_sync_jobs.maintenance():
            with request.app.state.session_local() as db:
                return plaid_settings.save(db, request.app.state.settings, payload.expected_revision, payload.client_id, payload.secret, payload.environment)


@router.post("/settings/check")
def check_settings(payload: SettingsRevision, request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    response.headers["Cache-Control"] = "no-store"
    plaid_settings.expect_revision(request.app.state.settings, payload.expected_revision)
    _client(request, db).check_credentials()
    return {"message": "Plaid accepted the saved credentials. Bank coverage and Transactions access depend on your Plaid account. No bank connection was created."}
