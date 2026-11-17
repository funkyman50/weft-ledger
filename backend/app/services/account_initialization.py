import hashlib
import json
from datetime import date, datetime, timedelta
from typing import TypedDict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import Account, Transaction
from app.schemas import Target
from app.services import ledger_projection, payees

MAX_SAFE_CENTS = 9007199254740991


class StartingBalanceState(TypedDict):
    account: Account
    starting_balance: Transaction | None
    rows: list[Transaction]
    pending: list[tuple[Transaction, dict]]
    eligible_ids: set[int]
    before: dict[str, int] | None
    context_token: str
    missing_pending: list[dict]


def _safe_cents(value: int, label: str) -> int:
    if not -MAX_SAFE_CENTS <= value <= MAX_SAFE_CENTS:
        raise AppError(
            "starting_balance_cents_out_of_range",
            f"{label} exceeds the supported cents range.",
            422,
        )
    return value


def _eligible_initial_pending(transaction: Transaction) -> bool:
    return (
        transaction.source == "plaid"
        and transaction.status == "pending"
        and transaction.plaid_removed_at is None
        and transaction.plaid_excluded_at is None
        and not ledger_projection.missing_pending(transaction)
    )


def _starting_balance_totals(
    rows: list[Transaction],
    starting_balance: Transaction | None,
    starting_balance_cents: int,
    selected_pending_ids: set[int],
    eligible_pending_ids: set[int],
) -> dict[str, int]:
    cleared, uncleared = starting_balance_cents, 0
    for transaction in rows:
        if ledger_projection.missing_pending(transaction):
            continue
        if starting_balance is not None and transaction.id == starting_balance.id:
            continue
        amount_cents = transaction.amount_cents
        is_cleared = (
            transaction.id in selected_pending_ids
            if transaction.id in eligible_pending_ids
            else ledger_projection.cleared_membership(transaction)
        )
        if is_cleared:
            cleared += amount_cents
        else:
            uncleared += amount_cents
    starting_balance_cents = _safe_cents(
        starting_balance_cents, "Starting balance"
    )
    cleared = _safe_cents(cleared, "Cleared balance")
    uncleared = _safe_cents(uncleared, "Uncleared balance")
    return {
        "starting_balance_cents": starting_balance_cents,
        "cleared_balance_cents": cleared,
        "uncleared_balance_cents": uncleared,
        "working_balance_cents": _safe_cents(cleared + uncleared, "Working balance"),
    }


def _cleared_starting_balance_contribution(rows: list[Transaction]) -> int:
    return sum(
        row.amount_cents
        for row in rows
        if row.source != "starting_balance"
        and row.plaid_excluded_at is None
        and not ledger_projection.missing_pending(row)
        and not (row.source == "plaid" and row.status == "pending")
        and ledger_projection.cleared_membership(row)
    )


def _starting_balance_state(db: Session, account_id: int) -> StartingBalanceState:
    account = db.get(Account, account_id)
    if account is None:
        raise AppError("account_not_found", "Account not found", 404)
    if not ledger_projection.uses_plaid_workflow(db, account.id):
        raise AppError(
            "starting_balance_not_available",
            "Starting balance confirmation is only available for Plaid-workflow accounts.",
            422,
        )
    if account.plaid_history_imported_at is None:
        raise AppError(
            "starting_balance_history_incomplete",
            "Account history is still downloading. Retry after the import completes.",
            422,
        )
    starting_rows = db.scalars(
        select(Transaction).where(
            Transaction.account_id == account.id,
            Transaction.source == "starting_balance",
        )
    ).all()
    initialized = account.starting_balance_initialized_at is not None
    if len(starting_rows) != (1 if initialized else 0):
        raise AppError(
            "starting_balance_invalid",
            "This account has an inconsistent starting-balance state.",
            409,
        )
    starting_balance = starting_rows[0] if starting_rows else None
    projection = ledger_projection.parent_projection(db, {account.id})
    shown = [item[2] for item in projection.values()]
    ledger_projection.fill_tokens(db, projection, shown)
    if starting_balance is not None and starting_balance.id not in projection:
        raise AppError(
            "starting_balance_invalid",
            "The starting-balance entry is not available in this account ledger.",
            409,
        )
    pending = [
        (transaction, projected)
        for transaction, _relationship, projected in projection.values()
        if _eligible_initial_pending(transaction)
    ]
    pending.sort(key=lambda item: ledger_projection.chronology_key(item[1]["date"], item[1]["amount_cents"], item[0].id, item[1]["source"]))
    rows = [item[0] for item in projection.values()]
    eligible_ids = {transaction.id for transaction, _projected in pending}
    before = (
        _starting_balance_totals(
            rows,
            starting_balance,
            starting_balance.amount_cents,
            {transaction.id for transaction, _projected in pending if transaction.manually_cleared},
            eligible_ids,
        )
        if initialized
        else None
    )
    context_value = {
        "account": {
            "id": account.id,
            "type": account.type,
            "starting_balance_initialized_at": account.starting_balance_initialized_at,
            "plaid_history_imported_at": account.plaid_history_imported_at,
            "plaid_current_balance_cents": account.plaid_current_balance_cents,
            "plaid_available_balance_cents": account.plaid_available_balance_cents,
            "plaid_limit_cents": account.plaid_limit_cents,
            "plaid_balance_iso_currency_code": account.plaid_balance_iso_currency_code,
            "plaid_balance_updated_at": account.plaid_balance_updated_at,
            "linked": ledger_projection.uses_plaid_workflow(db, account.id),
        },
        "starting_balance_id": starting_balance.id if starting_balance else None,
        "rows": [
            {"id": projected["id"], "edit_token": projected["edit_token"]}
            for _transaction, _relationship, projected in sorted(
                projection.values(), key=lambda item: item[0].id
            )
        ],
    }
    context_token = hashlib.sha256(
        json.dumps(context_value, default=str, sort_keys=True).encode()
    ).hexdigest()
    return {
        "account": account,
        "starting_balance": starting_balance,
        "rows": rows,
        "pending": pending,
        "eligible_ids": eligible_ids,
        "before": before,
        "context_token": context_token,
        "missing_pending": [
            projected
            for _transaction, _relationship, projected in projection.values()
            if projected["missing_pending"]
        ],
    }


def _starting_balance_context(state: StartingBalanceState) -> dict:
    account = state["account"]
    bank_balance = account.plaid_current_balance_cents
    if bank_balance is not None:
        bank_balance = _safe_cents(bank_balance, "Bank balance")
    return {
        "account_id": account.id,
        "context_token": state["context_token"],
        "bank_balance_cents": bank_balance,
        "bank_balance_fetched_at": account.plaid_balance_updated_at,
        "initialized_at": account.starting_balance_initialized_at,
        "before": state["before"],
        "pending_rows": [projected for _transaction, projected in state["pending"]],
        "missing_pending_rows": state["missing_pending"],
    }


def starting_balance_context(db: Session, account_id: int) -> dict:
    return _starting_balance_context(_starting_balance_state(db, account_id))


def _validated_pending_ids(state: StartingBalanceState, targets: list[Target]) -> set[int]:
    if state["missing_pending"]:
        raise AppError(
            "starting_balance_missing_pending",
            "Resolve missing pending transactions before confirming the starting balance.",
            422,
            {"missing_pending_rows": [item["id"] for item in state["missing_pending"]]},
        )
    expected = {
        transaction.id: projected["edit_token"]
        for transaction, projected in state["pending"]
    }
    rejected = []
    for target in targets:
        token = expected.get(target.id)
        if token is None:
            rejected.append({"id": target.id, "reason": "missing or not eligible"})
        elif token != target.edit_token:
            rejected.append({"id": target.id, "reason": "changed"})
    if rejected:
        raise AppError(
            "starting_balance_selection_changed",
            "Selected pending transactions changed. Refresh and review them again.",
            409,
            {"rejected": rejected},
        )
    return {target.id for target in targets}


def _starting_balance_preview(
    state: StartingBalanceState, reference_balance_cents: int, selected_pending_ids: set[int]
) -> dict:
    reference_balance_cents = _safe_cents(
        reference_balance_cents, "Reference balance"
    )
    posted = _cleared_starting_balance_contribution(state["rows"])
    included_pending = sum(
        transaction.amount_cents
        for transaction, _projected in state["pending"]
        if transaction.id in selected_pending_ids
    )
    new_starting_balance = _safe_cents(
        reference_balance_cents
        - _safe_cents(posted, "Posted contribution")
        - _safe_cents(included_pending, "Included pending contribution"),
        "Starting balance",
    )
    after = _starting_balance_totals(
        state["rows"],
        state["starting_balance"],
        new_starting_balance,
        selected_pending_ids,
        state["eligible_ids"],
    )
    return {"starting_balance_cents": new_starting_balance, "after": after}


def _preview_token(
    context_token: str, reference_balance_cents: int, targets: list[Target]
) -> str:
    value = {
        "context_token": context_token,
        "reference_balance_cents": reference_balance_cents,
        "included_pending": sorted(
            ({"id": target.id, "edit_token": target.edit_token} for target in targets),
            key=lambda target: target["id"],
        ),
    }
    return hashlib.sha256(
        json.dumps(value, default=str, sort_keys=True).encode()
    ).hexdigest()


def starting_balance_preview(
    db: Session,
    account_id: int,
    context_token: str,
    reference_balance_cents: int,
    targets: list[Target],
) -> dict:
    state = _starting_balance_state(db, account_id)
    if context_token != state["context_token"]:
        raise AppError(
            "starting_balance_context_stale",
            "Starting-balance details changed. Refresh before previewing again.",
            409,
        )
    selected_pending_ids = _validated_pending_ids(state, targets)
    preview = _starting_balance_preview(
        state, reference_balance_cents, selected_pending_ids
    )
    return {
        "preview_token": _preview_token(
            state["context_token"], reference_balance_cents, targets
        ),
        "before": state["before"],
        "after": preview["after"],
    }


def _create_starting_balance(
    account: Account,
    rows: list[Transaction],
    amount_cents: int,
    today: date,
    db: Session,
) -> Transaction:
    imported = [row.date for row in rows if row.source == "plaid"]
    oldest = min(imported, default=None)
    row = Transaction(
        account_id=account.id,
        date=oldest - timedelta(days=1) if oldest else today,
        description="Starting Balance",
        amount_cents=amount_cents,
        status="cleared",
        approved=True,
        source="starting_balance",
        payee_id=payees.system_payee(db, "starting_balance").id,
    )
    db.add(row)
    account.starting_balance_initialized_at = datetime.now()
    return row


def confirm_starting_balance(
    db: Session,
    account_id: int,
    preview_token: str,
    reference_balance_cents: int,
    targets: list[Target],
) -> dict:
    state = _starting_balance_state(db, account_id)
    selected_pending_ids = _validated_pending_ids(state, targets)
    expected_preview_token = _preview_token(
        state["context_token"], reference_balance_cents, targets
    )
    if preview_token != expected_preview_token:
        raise AppError(
            "starting_balance_preview_stale",
            "Starting-balance details or the preview selection changed. Refresh and preview again.",
            409,
        )
    preview = _starting_balance_preview(
        state, reference_balance_cents, selected_pending_ids
    )
    for transaction, _projected in state["pending"]:
        transaction.manually_cleared = transaction.id in selected_pending_ids
    if state["starting_balance"] is None:
        state["starting_balance"] = _create_starting_balance(
            state["account"],
            state["rows"],
            preview["starting_balance_cents"],
            date.today(),
            db,
        )
    else:
        state["starting_balance"].amount_cents = preview["starting_balance_cents"]
    db.flush()
    from app.services import transfers

    transfers.reconcile_automatic(db, {account_id})
    return _starting_balance_context(_starting_balance_state(db, account_id))


def _suggestion_unsupported(state: StartingBalanceState, reason: str, available_balance_cents=None) -> dict:
    return {
        "status": "unsupported",
        "included_pending": _suggestion_targets(state),
        "available_balance_cents": available_balance_cents,
        "reason": reason,
    }


def _suggestion_targets(
    state: StartingBalanceState, pending=None, *, selected_only: bool = True
) -> list[dict]:
    return [
        {"id": transaction.id, "edit_token": projected["edit_token"]}
        for transaction, projected in (pending if pending is not None else state["pending"])
        if not selected_only or transaction.manually_cleared
    ]


def _unique_signed_subset(values: list[int], target: int) -> tuple[str, int]:
    middle = len(values) // 2
    left, right = values[:middle], values[middle:]
    sums: dict[int, list[int]] = {}
    for mask in range(1 << len(left)):
        total = sum(value for index, value in enumerate(left) if mask & (1 << index))
        entries = sums.setdefault(total, [])
        if len(entries) < 2:
            entries.append(mask)
    found: list[int] = []
    for mask in range(1 << len(right)):
        total = sum(value for index, value in enumerate(right) if mask & (1 << index))
        for left_mask in sums.get(target - total, []):
            found.append(left_mask | (mask << len(left)))
            if len(found) == 2:
                return "ambiguous", 0
    return ("none", 0) if not found else ("unique", found[0])


def starting_balance_suggestion(
    db: Session, account_id: int, context_token: str, reference_balance_cents: int
) -> dict:
    state = _starting_balance_state(db, account_id)
    if context_token != state["context_token"]:
        raise AppError(
            "starting_balance_context_stale",
            "Starting-balance details changed. Refresh before asking for a suggestion.",
            409,
        )
    account = state["account"]
    if not ledger_projection.uses_plaid_workflow(db, account.id):
        return _suggestion_unsupported(state, "This account is no longer connected.")
    if account.type == "loan":
        return _suggestion_unsupported(state, "Pending suggestions are not available for loan accounts.")
    if account.plaid_balance_iso_currency_code != "USD":
        return _suggestion_unsupported(state, "Pending suggestions require complete USD balance and transaction currency data.")
    if account.plaid_current_balance_cents is None:
        return _suggestion_unsupported(state, "The current bank balance is unavailable.")
    if reference_balance_cents != account.plaid_current_balance_cents:
        return _suggestion_unsupported(state, "The entered balance differs from the cached bank snapshot.")
    if state["missing_pending"]:
        return _suggestion_unsupported(state, "Resolve missing pending transactions first.")
    pending = state["pending"]
    if len(pending) > 32:
        return {
            "status": "limit",
            "included_pending": _suggestion_targets(state),
            "available_balance_cents": None,
            "reason": "There are too many pending transactions to calculate a safe suggestion.",
        }
    if account.plaid_available_balance_cents is None:
        return _suggestion_unsupported(state, "The available bank balance is unavailable.")
    if account.type == "credit":
        if account.plaid_limit_cents is None:
            return _suggestion_unsupported(state, "The credit limit is unavailable.")
        available = _safe_cents(
            account.plaid_available_balance_cents - account.plaid_limit_cents,
            "Available credit",
        )
    else:
        available = _safe_cents(account.plaid_available_balance_cents, "Available balance")
    if any(
        not isinstance(transaction.plaid_raw, dict)
        or transaction.plaid_raw.get("iso_currency_code") != "USD"
        for transaction, _projected in pending
    ):
        return _suggestion_unsupported(state, "Pending transaction currency data is incomplete.", available)
    if any(abs(transaction.amount_cents) > MAX_SAFE_CENTS for transaction, _projected in pending):
        return _suggestion_unsupported(state, "Pending transaction amounts exceed the supported cents range.", available)
    existing = [item for item in pending if item[0].manually_cleared]
    candidates = [item for item in pending if not item[0].manually_cleared]
    pending_sum = sum(item[0].amount_cents for item in pending)
    selected_sum = sum(item[0].amount_cents for item in existing)
    target = reference_balance_cents + pending_sum - available
    remaining = target - selected_sum
    if any(abs(value) > MAX_SAFE_CENTS for value in (pending_sum, selected_sum, target, remaining)):
        return _suggestion_unsupported(state, "Pending amounts cannot be represented safely.", available)
    status, mask = _unique_signed_subset([item[0].amount_cents for item in candidates], remaining)
    if status != "unique":
        return {
            "status": status,
            "included_pending": _suggestion_targets(state),
            "available_balance_cents": available,
            "reason": "No exact pending selection matches the available-balance hypothesis."
            if status == "none"
            else "More than one pending selection matches the available-balance hypothesis.",
        }
    included = [*existing]
    included.extend(item for index, item in enumerate(candidates) if mask & (1 << index))
    return {
        "status": "unique",
        "included_pending": _suggestion_targets(state, included, selected_only=False),
        "available_balance_cents": available,
        "reason": None,
    }


def initialize_starting_balance_if_eligible(
    db: Session, account: Account, today: date
) -> bool:
    db.flush()
    if (
        account.starting_balance_initialized_at is not None
        or account.plaid_history_imported_at is None
        or account.plaid_current_balance_cents is None
        or not ledger_projection.uses_plaid_workflow(db, account.id)
    ):
        return False
    if not -MAX_SAFE_CENTS <= account.plaid_current_balance_cents <= MAX_SAFE_CENTS:
        return False
    all_rows = db.scalars(
        select(Transaction).where(Transaction.account_id == account.id)
    ).all()
    if any(row.source == "starting_balance" for row in all_rows):
        return False
    if any(ledger_projection.source_visible(row) and (_eligible_initial_pending(row) or ledger_projection.missing_pending(row)) for row in all_rows):
        return False
    projection = ledger_projection.parent_projection(db, {account.id})
    rows = [row for row, _relationship, _projected in projection.values()]
    posted = _cleared_starting_balance_contribution(rows)
    starting_balance = account.plaid_current_balance_cents - posted
    if not (
        -MAX_SAFE_CENTS <= posted <= MAX_SAFE_CENTS
        and -MAX_SAFE_CENTS <= starting_balance <= MAX_SAFE_CENTS
    ):
        return False
    _create_starting_balance(account, rows, starting_balance, today, db)
    return True
