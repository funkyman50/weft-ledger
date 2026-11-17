import hashlib
import json
from itertools import batched

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import SQL_ID_BATCH_SIZE
from app.errors import AppError
from app.models import (
    Account,
    AccountConversionAttempt,
    LoanDetails,
    PlaidAccountLink,
    PlaidItem,
    Payee,
    Transaction,
)
from app.schemas import AccountCreate, AccountReorder, AccountUpdate
from app.services import account_logos, ledger_history, ledger_projection, payees
from app.services import scheduled_transactions as schedules
from app.services.plaid_client import decrypt_access_token


def revoke_last_mapping_item(
    db: Session, link: PlaidAccountLink, client_factory, secret: str
) -> PlaidItem | None:
    if db.scalar(
        select(PlaidAccountLink.id).where(
            PlaidAccountLink.plaid_item_id == link.plaid_item_id,
            PlaidAccountLink.id != link.id,
        )
    ) is not None:
        return None
    attempt = db.scalar(
        select(AccountConversionAttempt).where(
            AccountConversionAttempt.plaid_item_id == link.plaid_item_id
        )
    )
    if attempt is not None:
        raise AppError(
            "bank_feed_conversion_staged",
            "Abandon the staged bank connection before disconnecting the last linked account.",
            409,
        )
    item = db.get(PlaidItem, link.plaid_item_id)
    if item is None:
        raise AppError("bank_feed_not_found", "This account does not have an active bank feed.", 404)
    client_factory().remove_item(decrypt_access_token(secret, item.access_token_enc))
    return item



def _connections(db: Session, account_ids: set[int]) -> dict[int, dict]:
    query = (
        select(
            PlaidAccountLink.account_id,
            PlaidAccountLink.id,
            PlaidAccountLink.plaid_item_id,
            PlaidItem.institution,
            PlaidAccountLink.plaid_account_id,
        )
        .join(PlaidItem)
    )
    links = [
        link
        for batch in batched(account_ids, SQL_ID_BATCH_SIZE)
        for link in db.execute(query.where(PlaidAccountLink.account_id.in_(batch))).all()
    ]
    return {
        link.account_id: {
            "id": link.id,
            "item_id": link.plaid_item_id,
            "institution": link.institution,
            "plaid_account_id": link.plaid_account_id,
        }
        for link in links
    }


def _serialize_accounts(db: Session, accounts: list[Account]) -> list[dict]:
    if not accounts:
        return []
    account_ids = {account.id for account in accounts}
    connections = _connections(db, account_ids)
    balances = ledger_projection.balances_for_accounts(db, account_ids)
    type_locked_account_ids = _type_locked_account_ids(db, account_ids)
    result = []
    for account in accounts:
        connection = connections.get(account.id)
        balance_values = balances[account.id]
        if connection and account.starting_balance_initialized_at is None:
            balance_values = {
                **balance_values,
                "cleared_balance_cents": None,
                "uncleared_balance_cents": None,
                "working_balance_cents": None,
            }
        result.append({
            "id": account.id,
            "name": account.name,
            "logo_id": account.logo_id,
            "group_name": account.group_name,
            "cash_flow_reporting": account.cash_flow_reporting,
            "net_worth_reporting": account.net_worth_reporting,
            "type": account.type,
            "closed": account.closed,
            "plaid_current_balance_cents": account.plaid_current_balance_cents,
            "plaid_available_balance_cents": account.plaid_available_balance_cents,
            "plaid_limit_cents": account.plaid_limit_cents,
            "plaid_balance_updated_at": account.plaid_balance_updated_at,
            "starting_balance_initialized_at": account.starting_balance_initialized_at,
            "plaid_history_imported_at": account.plaid_history_imported_at,
            "plaid_connection": connection,
            "type_change_locked": account.id in type_locked_account_ids,
            **balance_values,
        })
    return result


def serialize(db: Session, account: Account) -> dict:
    return _serialize_accounts(db, [account])[0]


def list_accounts(db: Session) -> list[dict]:
    accounts = db.scalars(select(Account).order_by(Account.sort_order, Account.id)).all()
    return _serialize_accounts(db, accounts)


def _canonical_group(db: Session, value: str | None, account_id: int | None = None) -> str | None:
    if value is None:
        return None
    for identifier, saved in db.execute(select(Account.id, Account.group_name).order_by(Account.id)):
        if identifier != account_id and saved is not None and saved.casefold() == value.casefold():
            return saved
    return value


def _place_account(db: Session, account: Account, previous_group: str | None = None) -> None:
    ordered = list(db.scalars(select(Account).where(Account.closed.is_(False)).order_by(Account.sort_order, Account.id)))
    previous_index = ordered.index(account)
    ordered.remove(account)
    if account.group_name is not None:
        members = [index for index, other in enumerate(ordered) if other.group_name == account.group_name]
        index = members[-1] + 1 if members else len(ordered)
    elif previous_group is not None:
        members = [index for index, other in enumerate(ordered) if other.group_name == previous_group]
        index = members[-1] + 1 if members else min(previous_index, len(ordered))
    else:
        index = next((index for index, other in enumerate(ordered) if other.group_name is not None), len(ordered))
    ordered.insert(index, account)
    for position, other in enumerate(ordered):
        other.sort_order = position


def create_record(db: Session, payload: AccountCreate) -> Account:
    account_logos.validate_selection(db, payload.logo_id)
    values = payload.model_dump()
    values["group_name"] = _canonical_group(db, payload.group_name)
    if "cash_flow_reporting" not in payload.model_fields_set:
        values["cash_flow_reporting"] = payload.type != "loan"
    account = Account(**values, sort_order=0)
    db.add(account)
    db.flush()
    _place_account(db, account)
    db.flush()
    return account


def create(db: Session, payload: AccountCreate) -> dict:
    check_names_available(db, [payload.name])
    account = create_record(db, payload)
    db.flush()
    return serialize(db, account)


def update(db: Session, account_id: int, payload: AccountUpdate) -> dict:
    changes = payload.model_dump(exclude_unset=True)
    if "logo_id" in changes:
        account_logos.validate_selection(db, changes["logo_id"])
    account = _target(db, account_id)
    previous_group = account.group_name
    if "group_name" in changes:
        changes["group_name"] = _canonical_group(db, changes["group_name"], account_id)
    if "name" in changes:
        check_names_available(db, [changes["name"]], excluded_account_id=account.id)
    if "type" in changes and changes["type"] != account.type:
        if type_change_locked(db, account_id):
            raise AppError(
                "account_type_locked",
                "Account type cannot change while history, a bank connection or loan details exist",
                409,
            )
    for field, value in changes.items():
        setattr(account, field, value)
    db.flush()
    if not account.closed and (account.group_name or "").casefold() != (previous_group or "").casefold():
        _place_account(db, account, previous_group)
        db.flush()
    return serialize(db, account)


def reopen(db: Session, account_id: int) -> dict:
    account = _target(db, account_id)
    if not account.closed:
        raise AppError("account_already_open", "This account is already open.", 409)
    account.closed = False
    db.flush()
    _place_account(db, account)
    db.flush()
    schedules.resume_account(db, account.id)
    return serialize(db, account)


def close_target(db: Session, account_id: int) -> Account:
    account = _target(db, account_id)
    if account.closed:
        raise AppError("account_already_closed", "This account is already closed.", 409)
    if db.scalar(
        select(AccountConversionAttempt.id).where(
            AccountConversionAttempt.account_id == account_id
        )
    ) is not None:
        raise AppError(
            "account_conversion_staged",
            "Finish or abandon the staged bank connection before closing this account.",
            409,
        )
    link = db.scalar(
        select(PlaidAccountLink).where(PlaidAccountLink.account_id == account_id)
    )
    if link is not None and account.starting_balance_initialized_at is None:
        raise AppError(
            "account_initialization_required",
            "Finish bank-account initialization or disconnect the bank feed before closing this account.",
            422,
        )
    active_rows = db.scalars(
        select(Transaction).where(
            Transaction.account_id == account_id,
            Transaction.source == "plaid",
            Transaction.feed_historical_at.is_(None),
        )
    ).all()
    if any(ledger_projection.missing_pending(row) for row in active_rows):
        raise AppError(
            "close_missing_pending",
            "Resolve missing pending transactions before closing this account.",
            422,
        )
    return account


def close_preview(db: Session, account_id: int) -> dict:
    return _close_preview(db, close_target(db, account_id))


def _close_preview(db: Session, account: Account) -> dict:
    account_id = account.id
    affected = schedules.affected(db, account_id)
    facts = [account.id, account.name, _connections(db, {account_id}).get(account_id), [schedules.token(db, schedule) for schedule in affected]]
    return {"preview_token": hashlib.sha256(json.dumps(facts, sort_keys=True, default=str).encode()).hexdigest(), "schedules": schedules.affected_summary(db, affected)}


def verify_close_preview(db: Session, account_id: int, preview_token: str) -> Account:
    account = close_target(db, account_id)
    if _close_preview(db, account)["preview_token"] != preview_token:
        raise AppError("account_close_preview_stale", "The affected schedules changed. Review a fresh close preview.", 409)
    return account


def close(db: Session, account_id: int, preview_token: str) -> dict:
    account = verify_close_preview(db, account_id, preview_token)
    account.closed = True
    db.flush()
    return serialize(db, account)


def reorder(db: Session, payload: AccountReorder) -> list[dict]:
    open_accounts = db.scalars(select(Account).where(Account.closed.is_(False))).all()
    by_id = {account.id: account for account in open_accounts}
    if set(payload.ids) != set(by_id):
        raise AppError(
            "invalid_account_order",
            "Account order must include every open account exactly once",
            422,
        )
    seen = set()
    current_group = None
    for account_id in payload.ids:
        group = by_id[account_id].group_name
        if group is not None and group != current_group:
            if group in seen:
                raise AppError("invalid_account_order", "Keep each account group together when reordering.", 422)
            seen.add(group)
        current_group = group
    for sort_order, account_id in enumerate(payload.ids):
        by_id[account_id].sort_order = sort_order
    db.flush()
    return list_accounts(db)


def check_names_available(
    db: Session, names: list[str], *, excluded_account_id: int | None = None
) -> None:
    name_keys = [name.strip().casefold() for name in names]
    if len(set(name_keys)) != len(name_keys):
        raise AppError(
            "duplicate_account_name",
            "Each connected account needs a distinct name",
            409,
        )
    for account_id, stored_name in db.execute(select(Account.id, Account.name)):
        if (
            account_id != excluded_account_id
            and stored_name.strip().casefold() in name_keys
        ):
            raise AppError(
                "duplicate_account_name",
                "An account with this name already exists",
                409,
            )


def reserve_names(db: Session, names: list[str]) -> None:
    ledger_history.reserve_write(db)
    check_names_available(db, names)


def _type_locked_account_ids(db: Session, account_ids: set[int]) -> set[int]:
    return {
        account_id
        for batch in batched(account_ids, SQL_ID_BATCH_SIZE)
        for account_id in db.scalars(
            select(Transaction.account_id).where(Transaction.account_id.in_(batch))
            .union(select(PlaidAccountLink.account_id).where(PlaidAccountLink.account_id.in_(batch)), select(LoanDetails.account_id).where(LoanDetails.account_id.in_(batch)))
        ).all()
    }


def type_change_locked(db: Session, account_id: int) -> bool:
    return account_id in _type_locked_account_ids(db, {account_id})


def _target(db: Session, account_id: int) -> Account:
    account = db.get(Account, account_id)
    if account is None:
        raise AppError("account_not_found", "Account not found", 404)
    return account


def _deletion_state(db: Session, account_id: int) -> tuple[Account, dict]:
    account = _target(db, account_id)
    target_rows = db.scalars(
        select(Transaction).where(Transaction.account_id == account.id).order_by(Transaction.id)
    ).all()
    incoming_rows = db.scalars(
        select(Transaction).where(
            Transaction.account_id != account.id,
            Transaction.transfer_account_id == account.id,
        ).order_by(Transaction.id)
    ).all()
    links = db.scalars(
        select(PlaidAccountLink)
        .where(PlaidAccountLink.account_id == account.id)
        .order_by(PlaidAccountLink.id)
    ).all()
    item_mappings = {
        link.plaid_item_id: db.scalars(
            select(PlaidAccountLink)
            .where(PlaidAccountLink.plaid_item_id == link.plaid_item_id)
            .order_by(PlaidAccountLink.id)
        ).all()
        for link in links
    }
    attempt = db.scalar(
        select(AccountConversionAttempt).where(AccountConversionAttempt.account_id == account.id)
    )
    item_attempts = {
        item_id: db.scalar(
            select(AccountConversionAttempt).where(
                AccountConversionAttempt.plaid_item_id == item_id
            )
        )
        for item_id, mappings in item_mappings.items()
        if len(mappings) == 1
    }
    return account, {
        "schedules": schedules.affected(db, account_id),
        "rules": [rule for rule in payees.stored_rules(db) if rule.account_id == account_id],
        "target_rows": target_rows,
        "incoming_rows": incoming_rows,
        "links": links,
        "item_mappings": item_mappings,
        "attempt": attempt,
        "item_attempts": item_attempts,
    }


def _deletion_token(db: Session, account: Account, state: dict) -> str:
    value = {
        "account": account.id,
        "rules": [payees.rule_data(rule) for rule in state["rules"]],
        "schedules": [schedules.token(db, schedule) for schedule in state["schedules"]],
        "target_rows": [row.id for row in state["target_rows"]],
        "incoming": [
            (row.id, row.amount_cents, row.transfer_account_id, row.transfer_partner_id)
            for row in state["incoming_rows"]
        ],
        "links": [
            (
                link.id,
                link.plaid_item_id,
                link.plaid_account_id,
                [
                    (mapping.id, mapping.account_id, mapping.plaid_account_id)
                    for mapping in state["item_mappings"][link.plaid_item_id]
                ],
            )
            for link in state["links"]
        ],
        "attempt": (
            None
            if state["attempt"] is None
            else (
                state["attempt"].id,
                state["attempt"].account_id,
                state["attempt"].plaid_item_id,
                state["attempt"].state,
            )
        ),
        "item_attempts": [
            (item_id, attempt.id, attempt.account_id, attempt.state)
            for item_id, attempt in state["item_attempts"].items()
            if attempt is not None
        ],
    }
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def _assert_not_staged(state: dict) -> None:
    if state["attempt"] is not None:
        raise AppError(
            "account_deletion_conversion_staged",
            "Abandon this staged bank connection before deleting the account.",
            409,
        )
    if any(attempt is not None for attempt in state["item_attempts"].values()):
        raise AppError(
            "account_deletion_shared_conversion_staged",
            "Abandon the staged bank connection before deleting the last linked account.",
            409,
        )


def deletion_preview(db: Session, account_id: int) -> dict:
    account, state = _deletion_state(db, account_id)
    _assert_not_staged(state)
    revoke_count = sum(
        len(state["item_mappings"][link.plaid_item_id]) == 1
        for link in state["links"]
    )
    return {
        "preview_token": _deletion_token(db, account, state),
        "removed_transaction_count": len(state["target_rows"]),
        "rules": [{"id": rule.id, "position": index + 1, "payee_name": db.get(Payee, rule.payee_id).name} for index, rule in enumerate(payees.stored_rules(db)) if rule in state["rules"]],
        "schedules": schedules.affected_summary(db, state["schedules"]),
        "surviving_transfer_transaction_count": len(state["incoming_rows"]),
        "plaid_item_effect": (
            "none" if not state["links"] else "revoked" if revoke_count else "kept_shared"
        ),
    }


def delete(db: Session, account_id: int, preview_token: str, client, secret: str) -> dict:
    ledger_history.reserve_write(db)
    account, state = _deletion_state(db, account_id)
    _assert_not_staged(state)
    if preview_token != _deletion_token(db, account, state):
        raise AppError(
            "account_deletion_preview_stale",
            "This account changed after the deletion preview. Review a fresh preview before deleting it.",
            409,
        )

    revoked_items: list[PlaidItem] = []
    for link in state["links"]:
        item = revoke_last_mapping_item(
            db, link, client, secret
        )
        if item is not None:
            revoked_items.append(item)

    for row in state["incoming_rows"]:
        row.transfer_account_id = None
        row.transfer_payee_confirmed = False

    for schedule in state["schedules"]:
        db.delete(schedule)
    for row in state["target_rows"]:
        db.delete(row)
    db.flush()
    for link in state["links"]:
        db.delete(link)
    for item in revoked_items:
        db.delete(item)
    db.flush()
    db.delete(account)
    db.commit()
    return {"status": "deleted"}
