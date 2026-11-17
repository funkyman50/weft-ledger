from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.db import read_snapshot
from app.routers.deps import get_command_db, get_db
from app.schemas import LedgerRow, LoanDetailsSave, LoanResolve
from app.services import commands, loans

router = APIRouter(prefix="/api/loans", tags=["loans"])


@router.get("/{account_id}")
def account(account_id: int, db: Session = Depends(get_db)) -> dict:
    with read_snapshot(db):
        return loans.account_context(db, account_id)


@router.put("/{account_id}/details")
def save_details(
    account_id: int,
    payload: LoanDetailsSave,
    request: Request,
    db: Session = Depends(get_command_db),
) -> dict:
    with commands.ordinary(db, request.app.state.ledger_history, history="preserve", label="Loan details saved"):
        result = loans.save_details(db, account_id, payload)
    return result


@router.post("/{account_id}/resolve", response_model=LedgerRow)
def resolve(
    account_id: int,
    payload: LoanResolve,
    request: Request,
    db: Session = Depends(get_command_db),
):
    with commands.ordinary(db, request.app.state.ledger_history, history="capture", label="Bank difference resolved"):
        result = LedgerRow.model_validate(loans.resolve(db, account_id, payload))
    return result
