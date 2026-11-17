from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import Account, Category, LoanDetails
from app.schemas import LoanResolve, SingleCategorization, SplitCategorization, TransactionCreate
from app.services import ledger
from app.services import transaction_matching as matching
from app.services import ledger_projection as projection

CATEGORY_NAMES = {"interest": "interest & fees", "escrow": "escrow"}


def _account(db: Session, account_id: int) -> Account:
    account = db.get(Account, account_id)
    if account is None or account.type != "loan":
        raise AppError("loan_unavailable", "Choose a saved loan account.", 422)
    return account


def _category(db: Session, name_key: str) -> int | None:
    parents = select(Category.id).where(
        Category.parent_id.is_(None), Category.name_key == "debt", Category.archived.is_(False)
    )
    identifiers = db.scalars(
        select(Category.id).where(
            Category.parent_id.in_(parents), Category.name_key == name_key, Category.archived.is_(False)
        )
    ).all()
    return identifiers[0] if len(identifiers) == 1 else None


def _difference(db: Session, account: Account) -> int | None:
    if projection.account_requires_initialization(db, account.id) or account.plaid_current_balance_cents is None:
        return None
    return projection.balances(db, account.id)["cleared_balance_cents"] - account.plaid_current_balance_cents


def _payee(db: Session, account: Account) -> dict | None:
    rows = [row for _, _, row in projection.parent_projection(db, {account.id}).values() if row["source"] != "starting_balance"]
    if not rows:
        return None
    latest = max(rows, key=lambda row: (row["date"], row["id"]))
    return {"id": latest["payee_id"], "name": latest["payee_name"], "assignable": latest["payee_kind"] in ("ordinary", "myself")}


def account_context(db: Session, account_id: int) -> dict:
    account = _account(db, account_id)
    details = db.get(LoanDetails, account.id)
    return {
        "account_id": account.id,
        "account_name": account.name,
        "details": {"kind": details.kind, "escrow_cents": details.escrow_cents} if details else None,
        "difference_cents": _difference(db, account),
        "bank_updated_at": account.plaid_balance_updated_at,
        "payee": _payee(db, account),
        "interest_category_id": _category(db, CATEGORY_NAMES["interest"]),
        "escrow_category_id": _category(db, CATEGORY_NAMES["escrow"]),
        "today": date.today(),
    }


def save_details(db: Session, account_id: int, payload) -> dict:
    account = _account(db, account_id)
    current = db.get(LoanDetails, account.id)
    if payload.details is None:
        if current is not None:
            db.delete(current)
    elif current is None:
        db.add(LoanDetails(account_id=account.id, **payload.details.model_dump()))
    else:
        current.kind, current.escrow_cents = payload.details.kind, payload.details.escrow_cents
    db.flush()
    return account_context(db, account.id)


def resolve(db: Session, account_id: int, payload: LoanResolve) -> dict:
    account = _account(db, account_id)
    if db.get(LoanDetails, account.id) is None:
        raise AppError("loan_details_required", "Add loan details first.", 422)
    difference = _difference(db, account)
    if difference != payload.expected_difference_cents:
        raise AppError("loan_difference_changed", "The bank difference changed. Refresh and review it again.", 409)
    if payload.escrow_cents + payload.interest_cents != difference:
        raise AppError("loan_parts_invalid", "Escrow and interest must add up to the difference.", 422)
    payee = _payee(db, account)
    if payee is None or not payee["assignable"]:
        raise AppError("loan_payee_unavailable", "The latest transaction has no Payee to reuse. Enter this charge manually.", 422)
    parts = [
        (_category(db, CATEGORY_NAMES[key]), -amount)
        for key, amount in (("escrow", payload.escrow_cents), ("interest", payload.interest_cents))
        if amount
    ]
    categorization = (
        SingleCategorization(kind="single", category_id=parts[0][0])
        if len(parts) == 1
        else SplitCategorization(
            kind="split",
            allocations=[{"category_id": category_id, "amount_cents": amount, "memo": ""} for category_id, amount in parts],
        )
    )
    txn = ledger.create_manual_transaction(
        db,
        TransactionCreate(
            account_id=account.id, date=date.today(), payee_id=payee["id"], categorization=categorization, amount_cents=-difference
        ),
    )
    txn.status = "cleared"
    db.flush()
    # Automatic matching could pair the charge with a bank row and turn it Uncleared, undoing the correction.
    matching.reconcile(db, {account.id}, allow_automatic=False, expire_stale=False, transaction_ids={txn.id})
    db.flush()
    if _difference(db, account) != 0:
        raise AppError("loan_difference_unresolved", "The charge did not balance this account. Nothing was saved.", 409)
    return projection.row(db, projection.resolve_relationship(db, txn).parent)
