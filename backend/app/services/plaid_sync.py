import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.db import read_snapshot
from app.config import Settings
from app.diagnostics import diagnostics, operation
from app.services.ledger_history import record_lifecycle
from app.errors import AppError
from app.models import Account, PlaidAccountLink, PlaidItem, PlaidSyncState, Transaction
from app.schemas import SingleCategorization
from app.services import account_initialization as initialization
from app.services import (
    ledger,
    ledger_projection,
    payees,
    pending_lifecycle,
    reported_balances,
)
from app.services import (
    transaction_matching as matching,
)
from app.services.plaid_client import (
    PlaidClient,
    decrypt_access_token,
    plaid_error_code,
    plaid_error_kind,
)


UNKNOWN_INSTITUTION_NAME = "Plaid connection"


@dataclass(frozen=True)
class _SyncItem:
    id: int
    item_id: str
    access_token_enc: str
    cursor: str
    institution_id: str | None
    institution: str


@dataclass(frozen=True)
class _FetchedItem:
    added: list[dict]
    modified: list[dict]
    removed: list[dict]
    cursor: str
    update_status: str | None
    accounts: list[dict]
    institution_details: dict | None
    balances_recorded_at: datetime


def _fetch_institution(client, access_token, institution_id=None):
    try:
        return client.institution_details(access_token, institution_id)
    except Exception:  # Institution metadata failure must not block transaction sync.
        return None


def _apply_institution(item, details, institution_id=None):
    item.institution_id = details.get("institution_id") or institution_id
    item.institution = details.get("name") or item.institution


def refresh_item_institution(item, client, access_token, institution_id=None):
    if item.institution_id and item.institution != UNKNOWN_INSTITUTION_NAME:
        return
    details = _fetch_institution(
        client, access_token, institution_id or item.institution_id
    )
    if details is not None:
        _apply_institution(item, details, institution_id)


def sync_state(db: Session) -> PlaidSyncState:
    state = db.get(PlaidSyncState, 1)
    if state is None:
        state = PlaidSyncState(id=1, errors=[])
        db.add(state)
        db.flush()
    return state


def status(db: Session) -> dict:
    state = sync_state(db)
    errors = []
    for stored in state.errors or []:
        issue = _present_issue(db, stored)
        if issue is not None:
            errors.append(issue)
    return {
        "last_sync": state.last_sync,
        "schedule_revision": state.schedule_revision,
        "added": state.added,
        "matched": state.matched,
        "suggested": state.suggested,
        "queued": state.queued,
        "errors": errors,
        "connections": connections(db, {account_id for issue in errors if issue["kind"] == "login_required" for account_id in issue["account_ids"]}),
    }


def connections(db: Session, sign_in_account_ids: set[int]) -> list[dict]:
    links = db.execute(select(PlaidAccountLink.plaid_item_id, PlaidAccountLink.account_id)).all()
    result = []
    for item in db.scalars(select(PlaidItem).order_by(PlaidItem.id)).all():
        account_ids = sorted(account_id for item_id, account_id in links if item_id == item.id)
        if not account_ids:
            continue
        if sign_in_account_ids.intersection(account_ids):
            health = "needs_sign_in"
        elif item.bank_failed_at is not None and (item.bank_updated_at is None or item.bank_failed_at > item.bank_updated_at):
            health = "failing"
        else:
            health = "ok"
        result.append({
            "institution": item.institution,
            "account_ids": account_ids,
            "bank_updated_at": item.bank_updated_at,
            "bank_failed_at": item.bank_failed_at,
            "synced_at": item.synced_at,
            "health": health,
        })
    return result


def _store_bank_status(db: Session, snapshot: "_SyncItem", updated_at: datetime | None, failed_at: datetime | None) -> None:
    item = db.get(PlaidItem, snapshot.id)
    if item is not None and item.item_id == snapshot.item_id:
        item.bank_updated_at, item.bank_failed_at = updated_at, failed_at
    db.commit()


def refresh_item(db: Session, account_id: int, client_factory: Callable[[], PlaidClient], secret: str) -> str:
    link = db.scalar(select(PlaidAccountLink).where(PlaidAccountLink.account_id == account_id))
    if link is None:
        raise AppError("plaid_account_not_connected", "This account is not connected to a bank.", 409)
    item = db.get(PlaidItem, link.plaid_item_id)
    account_ids = sorted(db.scalars(select(PlaidAccountLink.account_id).where(PlaidAccountLink.plaid_item_id == item.id)).all())
    institution = item.institution
    client = client_factory()
    token = decrypt_access_token(secret, item.access_token_enc)
    db.rollback()
    try:
        client.transactions_refresh(token)
    except AppError as error:
        if error.code == "plaid_timeout":
            raise AppError("plaid_refresh_unknown", f"{institution}: Plaid did not answer in time. The refresh may still have reached Plaid and been billed, so wait for the next sync instead of trying again.", 504) from error
        raise
    except Exception as error:
        code = plaid_error_code(error)
        kind = plaid_error_kind(error)
        if code in {"INVALID_PRODUCT", "UNAUTHORIZED_ROUTE_ACCESS"}:
            raise AppError("plaid_refresh_not_enabled", "Refresh isn't enabled on your Plaid plan. Sync Plaid still receives Plaid's regular updates.", 409) from error
        if code in {"PRODUCTS_NOT_SUPPORTED", "PRODUCT_NOT_ENABLED"}:
            raise AppError("plaid_refresh_not_supported", f"{institution}: this bank connection does not support Refresh. Sync Plaid still receives Plaid's regular updates.", 409) from error
        if kind == "login_required":
            state = sync_state(db)
            issue = _issue("login_required", account_ids=account_ids)
            if issue not in (state.errors or []):
                state.errors = [*(state.errors or []), issue]
            db.commit()
            raise AppError("plaid_refresh_login_required", f"{institution}: the bank needs you to sign in again. Use Repair connection.", 409) from error
        if kind == "temporary" or code == "PRODUCT_NOT_READY":
            raise AppError("plaid_refresh_temporary", f"{institution}: Plaid could not refresh this bank right now. Try again later.", 503) from error
        raise AppError("plaid_refresh_failed", f"{institution}: Plaid could not refresh this bank connection.", 502) from error
    return institution


_ISSUE_MESSAGES = {
    "login_required": "Bank sign-in or consent needs attention.",
    "missing_account": "The bank no longer grants access to a connected account.",
    "temporary": "The bank connection could not be refreshed. Try again later.",
    "local_custody": "Weft cannot recover the original secret used to encrypt this bank connection.",
    "rule_evaluation": "A payee rule could not be evaluated. Review the rules in Payees and retry sync.",
    "other": "A bank connection could not be refreshed.",
    "transaction_warning": "A removed bank transaction was kept because it is no longer pending.",
}


def _issue(
    kind: str,
    *,
    account_ids: list[int] | set[int] = (),
    missing_account_ids: list[int] | set[int] = (),
    message: str | None = None,
) -> dict:
    return {
        "kind": kind,
        "message": message or _ISSUE_MESSAGES[kind],
        "account_ids": sorted(set(account_ids)),
        "missing_account_ids": sorted(set(missing_account_ids)),
    }


def _present_issue(db: Session, stored: dict) -> dict | None:
    kind = stored["kind"]
    if kind == "schedule_entry":
        return stored
    account_ids = stored["account_ids"]
    missing_account_ids = stored["missing_account_ids"]
    accounts = {
        account.id: account
        for account in db.scalars(
            select(Account)
            .join(PlaidAccountLink, PlaidAccountLink.account_id == Account.id)
            .where(Account.id.in_(account_ids))
        ).all()
    } if account_ids else {}
    current_ids = [account_id for account_id in account_ids if account_id in accounts]
    if not current_ids:
        return None
    institution = db.scalar(
        select(PlaidItem.institution)
        .join(PlaidAccountLink, PlaidAccountLink.plaid_item_id == PlaidItem.id)
        .where(PlaidAccountLink.account_id.in_(current_ids))
        .order_by(PlaidItem.id)
    )
    prefix = f"{institution}: " if institution else ""
    names = ", ".join(accounts[account_id].name for account_id in current_ids)
    missing_ids = [
        account_id for account_id in missing_account_ids if account_id in accounts
    ]
    if kind == "missing_account":
        if not missing_ids:
            return None
        missing_names = ", ".join(accounts[account_id].name for account_id in missing_ids)
        message = (
            f"{prefix}The bank no longer grants access to {missing_names}. "
            f"All accounts sharing this connection ({names}) pause until access is "
            "restored or the missing local account is disconnected."
        )
    elif kind == "rule_evaluation":
        message = f"{stored['message']} Affected accounts: {names}."
    elif kind == "transaction_warning":
        message = f"{prefix}{stored['message']} Affected account: {names}."
    else:
        message = f"{prefix}{stored['message']} Check account settings for {names}."
    return {
        "kind": kind,
        "message": message,
        "account_ids": current_ids,
        "missing_account_ids": missing_ids,
    }


def _sync_issue(error: Exception, account_ids: list[int]) -> dict:
    if isinstance(error, AppError):
        if error.code in {"plaid_timeout", "plaid_sync_stalled"}:
            return _issue("temporary", account_ids=account_ids)
        if error.code == "payee_rule_evaluation_failed":
            return _issue("rule_evaluation", account_ids=account_ids, message=error.message)
        if error.code in ("payee_import_missing", "payee_import_reserved"):
            return _issue("transaction_warning", account_ids=account_ids, message=error.message)
        if error.code == "plaid_mapped_account_missing":
            detail = error.detail if isinstance(error.detail, dict) else {}
            return _issue(
                "missing_account",
                account_ids=detail["account_ids"],
                missing_account_ids=detail["missing_account_ids"],
            )
        if error.code == "plaid_local_token_unreadable":
            return _issue("local_custody", account_ids=account_ids)
        return _issue("other", account_ids=account_ids)
    kind = plaid_error_kind(error)
    if kind == "login_required":
        return _issue("login_required", account_ids=account_ids)
    if kind == "item_missing":
        return _issue(
            "other",
            account_ids=account_ids,
            message="This bank connection no longer exists at Plaid. Disconnect affected local accounts to preserve their history.",
        )
    if kind == "temporary":
        return _issue("temporary", account_ids=account_ids)
    return _issue("other", account_ids=account_ids)


def transaction_values(raw: dict) -> tuple[date, int, str]:
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        raise AppError("plaid_match_text_missing", "Plaid transaction is missing its required name.", 422)
    original = raw.get("original_description")
    description = original if isinstance(original, str) and original.strip() else name
    return date.fromisoformat(str(raw["date"])), -int(round(Decimal(str(raw["amount"])) * 100)), description


def jsonable_payload(raw: dict) -> dict:
    return json.loads(json.dumps(raw, default=str))


def create_plaid_row(
    db: Session, raw: dict, account_id: int, resolver: payees.RuleEvaluator
) -> Transaction:
    when, amount, description = transaction_values(raw)
    posted = not raw.get("pending", False)
    txn = Transaction(
        account_id=account_id,
        date=when,
        description=description,
        amount_cents=amount,
        status="cleared" if posted else "pending",
        approved=False,
        source="plaid",
        plaid_txn_id=raw["transaction_id"],
        plaid_raw=jsonable_payload(raw),
        pending_resolved=posted and bool(raw.get("pending_transaction_id")),
    )
    txn.payee_id, category_id = payees.import_assignment(db, raw, txn, resolver)
    db.add(txn)
    db.flush()
    if category_id is not None:
        ledger.apply_metadata_values(db, txn, None, ledger_projection.row(db, txn), {"categorization": SingleCategorization(kind="single", category_id=category_id)})
    return txn


def _update(
    db,
    txn,
    raw,
    posted,
    clearance_source,
    removed_manual_clearances,
    previous_amount=None,
):
    when, amount, description = transaction_values(raw)
    from app.services import bank_continuity

    bank_continuity.before_amount_change(db, txn, amount)
    old_amount = txn.amount_cents if previous_amount is None else previous_amount
    pending_resolved = txn.pending_resolved or (
        posted
        and (
            txn.status == "pending"
            or clearance_source.status == "pending"
            or bool(raw.get("pending_transaction_id"))
        )
    )
    manually_cleared = (
        clearance_source.manually_cleared
        or clearance_source.id in removed_manual_clearances
    )
    manual_clearance_amount = (
        removed_manual_clearances[clearance_source.id]
        if clearance_source.id in removed_manual_clearances
        else clearance_source.amount_cents
    )
    txn.date, txn.amount_cents, txn.description = when, amount, description
    txn.plaid_txn_id, txn.plaid_raw, txn.plaid_removed_at = (
        raw["transaction_id"],
        jsonable_payload(raw),
        None,
    )
    txn.status = "cleared" if posted else "pending"
    txn.pending_resolved = pending_resolved
    if posted:
        txn.pending_replacement_id = None
    if posted or amount != old_amount:
        txn.manually_cleared = False
    if manually_cleared and amount != manual_clearance_amount:
        txn.approved = False
    if txn.plaid_excluded_at is None:
        matching.bank_amount_changed(db, txn, old_amount)
    return manually_cleared and amount != manual_clearance_amount


def reconnect_plaid_row(db: Session, txn: Transaction, raw: dict, *, replacement: Transaction | None = None) -> bool:
    previous_amount = matching.promote_returning_identity(db, txn, replacement)
    amount_changed = _update(db, txn, raw, not raw.get("pending", False), replacement or txn, {}, previous_amount)
    txn.feed_historical_at = None
    txn.provider_lifecycle_detached_at = None
    return amount_changed


def _apply(db, raw, account_id, removed_manual_clearances, resolver):
    from app.services import bank_continuity

    pending_id = raw.get("pending_transaction_id")
    pending = db.scalar(select(Transaction).where(Transaction.plaid_txn_id == pending_id, Transaction.account_id == account_id)) if pending_id else None
    existing = db.scalar(select(Transaction).where(Transaction.plaid_txn_id == raw["transaction_id"]))
    before = (existing.date, existing.amount_cents, existing.status, existing.plaid_removed_at is not None) if existing else None
    related = False
    if existing:
        when, amount, _description = transaction_values(raw)
        if before != (when, amount, "pending" if raw.get("pending", False) else "cleared", False):
            related = existing.feed_replacement_id is not None or existing.pending_replacement_id is not None or existing.transfer_partner_id is not None or existing.bank_continuity is not None or ledger_projection.active_match_for(db, existing) is not None
    changed = False
    previous_amount = existing.amount_cents if existing is not None else None
    if existing:
        bank_continuity.before_provider_update(db, existing, raw)
        if existing.feed_replacement_id is None and existing.feed_historical_at is not None:
            changed = reconnect_plaid_row(db, existing, raw)
        else:
            changed = _update(db, existing, raw, not raw.get("pending", False), existing, removed_manual_clearances)
    else:
        existing = create_plaid_row(db, raw, account_id, resolver)
        db.flush()
    if pending is not None and pending.id != existing.id and not raw.get("pending", False):
        if pending.provider_lifecycle_detached_at is None and pending.feed_historical_at is None and not bank_continuity.rejected(db, pending, existing, provider=True):
            same_pair = pending.feed_replacement_id == existing.id
            changed = changed or ((not same_pair or previous_amount != existing.amount_cents) and pending.amount_cents != existing.amount_cents)
            try:
                survivor = bank_continuity.associate(db, pending, existing, "provider")
            except AppError as error:
                if not error.code.startswith("lifecycle_"):
                    raise
                survivor = None
            if survivor is None:
                pending.manually_cleared = False
                if pending.status == "pending":
                    pending.plaid_removed_at = datetime.now()
                    pending.pending_replacement_id = existing.id
                else:
                    pending.approved = False
                existing.approved = False
                record_lifecycle(db, "bank_continuity", "blocked", "provider_relationship_conflict", account_id=account_id, transaction_id=pending.id, candidate_id=existing.id, association_kind="provider")
        else:
            record_lifecycle(db, "bank_continuity", "blocked", "predecessor_unavailable_or_rejected", account_id=account_id, transaction_id=pending.id, candidate_id=existing.id, association_kind="provider")
    if related and before != (existing.date, existing.amount_cents, existing.status, existing.plaid_removed_at is not None):
        record_lifecycle(db, "provider", "changed", "returned" if before[3] else "posted" if before[2] == "pending" and existing.status != "pending" else "updated", account_id=account_id, transaction_id=existing.id, transaction_status=existing.status, previous_status=before[2], amount_changed=before[1] != existing.amount_cents, date_changed=before[0] != existing.date, returned=before[3])
    return existing, {existing.id} if changed else set()


def _mark_removed(
    db: Session, raw: dict, active_account_ids: set[int]
) -> tuple[int | None, Transaction | None]:
    transaction_id = raw.get("transaction_id")
    row = db.scalar(
        select(Transaction).where(Transaction.plaid_txn_id == transaction_id)
    )
    if row is None or row.account_id not in active_account_ids:
        return None, None
    if row.source != "plaid" or (row.status != "pending" and row.plaid_excluded_at is None):
        return (
            row.account_id,
            None,
        )
    manually_cleared = row if row.manually_cleared else None
    if row.plaid_removed_at is None and (row.feed_replacement_id is not None or row.pending_replacement_id is not None or row.transfer_partner_id is not None or row.bank_continuity is not None or ledger_projection.active_match_for(db, row) is not None):
        record_lifecycle(db, "provider", "changed", "removed", account_id=row.account_id, transaction_id=row.id, transaction_status=row.status, source_removed=True)
    row.manually_cleared = False
    row.plaid_removed_at = datetime.now()
    return None, manually_cleared


def _balances(db, raw_accounts, links, today, recorded_at):
    for raw in raw_accounts:
        link = links.get(raw.get("account_id"))
        if link is None:
            continue
        account = db.get(Account, link.account_id)
        values = raw.get("balances") or {}
        observation = reported_balances.record(db, account, link, values, recorded_at)
        account.plaid_current_balance_cents = observation.current_balance_cents
        account.plaid_available_balance_cents = reported_balances.balance_cents(values.get("available"))
        account.plaid_limit_cents = reported_balances.balance_cents(values.get("limit"))
        account.plaid_balance_iso_currency_code = observation.currency_code
        account.plaid_balance_updated_at = recorded_at
        if account.plaid_current_balance_cents is not None:
            initialization.initialize_starting_balance_if_eligible(db, account, today)


def _sync_items(db: Session, item_ids: set[int] | None) -> list[_SyncItem]:
    linked = select(PlaidAccountLink.id).where(PlaidAccountLink.plaid_item_id == PlaidItem.id)
    statement = select(PlaidItem).where(linked.exists())
    if item_ids is not None:
        unfinished = (
            select(PlaidAccountLink.id)
            .join(Account, Account.id == PlaidAccountLink.account_id)
            .where(
                PlaidAccountLink.plaid_item_id == PlaidItem.id,
                Account.plaid_history_imported_at.is_(None),
            )
        )
        statement = statement.where(PlaidItem.id.in_(item_ids), unfinished.exists())
    return [
        _SyncItem(
            id=item.id,
            item_id=item.item_id,
            access_token_enc=item.access_token_enc,
            cursor=item.cursor,
            institution_id=item.institution_id,
            institution=item.institution,
        )
        for item in db.scalars(statement).all()
    ]


def _fetch_item(client, token, item: _SyncItem) -> _FetchedItem:
    sync = client.sync(token, item.cursor)
    accounts = client.accounts(token)
    balances_recorded_at = datetime.now()
    details = (
        None
        if item.institution_id and item.institution != UNKNOWN_INSTITUTION_NAME
        else _fetch_institution(client, token, item.institution_id)
    )
    added, modified, removed, cursor, update_status = sync
    return _FetchedItem(
        added=added,
        modified=modified,
        removed=removed,
        cursor=cursor,
        update_status=update_status,
        accounts=accounts,
        institution_details=details,
        balances_recorded_at=balances_recorded_at,
    )


def _apply_fetched_item(
    db: Session, item_snapshot: _SyncItem, fetched: _FetchedItem, today: date
) -> bool:
    db.execute(text("BEGIN IMMEDIATE"))
    item = db.get(PlaidItem, item_snapshot.id)
    if item is None or item.item_id != item_snapshot.item_id:
        db.commit()
        return False
    account_links = {
        link.plaid_account_id: link
        for link in db.scalars(
            select(PlaidAccountLink).where(PlaidAccountLink.plaid_item_id == item.id)
        ).all()
    }
    links = {provider_id: link.account_id for provider_id, link in account_links.items()}
    state = sync_state(db)
    provider_account_ids = {
        raw.get("account_id")
        for raw in fetched.accounts
        if isinstance(raw.get("account_id"), str)
    }
    missing_provider_ids = set(links).difference(provider_account_ids)
    if missing_provider_ids:
        raise AppError(
            "plaid_mapped_account_missing",
            "The bank no longer grants access to a connected account.",
            409,
            {
                "account_ids": sorted(set(links.values())),
                "missing_account_ids": sorted(
                    links[provider_id] for provider_id in missing_provider_ids
                ),
            },
        )
    if fetched.institution_details is not None:
        _apply_institution(item, fetched.institution_details, item_snapshot.institution_id)
    removed_manual_clearances = {}
    removed_provider_ids = {
        raw.get("transaction_id")
        for raw in fetched.removed
        if isinstance(raw.get("transaction_id"), str)
    }
    for raw in fetched.removed:
        warning_account_id, manually_cleared = _mark_removed(
            db, raw, set(links.values())
        )
        if warning_account_id is not None:
            state.errors = [
                *(state.errors or []),
                _issue(
                    "transaction_warning",
                    account_ids=[warning_account_id],
                ),
            ]
        if manually_cleared is not None:
            removed_manual_clearances[manually_cleared.id] = manually_cleared.amount_cents
    affected = set(links.values())
    force_needs_review_ids = set()
    changed_transaction_ids = set()
    resolver = payees.load_evaluator(db) if fetched.added or fetched.modified else None
    for raw in fetched.added:
        if raw.get("pending") and raw.get("transaction_id") in removed_provider_ids:
            continue
        account_id = links.get(raw.get("account_id"))
        if account_id:
            transaction, changed = _apply(db, raw, account_id, removed_manual_clearances, resolver)
            changed_transaction_ids.add(transaction.id)
            force_needs_review_ids.update(changed)
            state.added += 1
    for raw in fetched.modified:
        if raw.get("pending") and raw.get("transaction_id") in removed_provider_ids:
            continue
        account_id = links.get(raw.get("account_id"))
        if account_id:
            transaction, changed = _apply(db, raw, account_id, removed_manual_clearances, resolver)
            changed_transaction_ids.add(transaction.id)
            force_needs_review_ids.update(changed)
    linked_accounts = [db.get(Account, account_id) for account_id in set(links.values())]
    ready_before = {account.id for account in linked_accounts if account is not None and account.plaid_history_imported_at is not None and account.starting_balance_initialized_at is not None}
    if fetched.update_status == "HISTORICAL_UPDATE_COMPLETE":
        now = datetime.now()
        for account in linked_accounts:
            if account is not None and account.plaid_history_imported_at is None:
                account.plaid_history_imported_at = now
    db.flush()
    inferred_matches = pending_lifecycle.reconcile_inferred(db, affected)
    db.flush()
    decisions = matching.reconcile(db, affected, allow_automatic=True, expire_stale=True, discover_transfers=False, release_unmatch_holds=True)
    for transaction_id in force_needs_review_ids:
        transaction = db.get(Transaction, transaction_id)
        if transaction is not None:
            transaction.approved = False
    db.flush()
    state.matched += inferred_matches + sum(
        item.outcome == "automatic" for item in decisions
    )
    state.suggested += sum(item.outcome == "suggested" for item in decisions)
    _balances(db, fetched.accounts, account_links, today, fetched.balances_recorded_at)
    from app.services import transfers

    db.flush()
    newly_ready = {account.id for account in linked_accounts if account is not None and account.plaid_history_imported_at is not None and account.starting_balance_initialized_at is not None} - ready_before
    if newly_ready:
        state.matched += transfers.reconcile_automatic(db, newly_ready)
    state.matched += transfers.reconcile_automatic(db, affected - newly_ready, transaction_ids=changed_transaction_ids or None)
    item.cursor = fetched.cursor
    item.synced_at = datetime.now()
    incomplete = any(
        account is not None and account.plaid_history_imported_at is None
        for account in linked_accounts
    )
    db.commit()
    return incomplete


def run_sync(
    db: Session,
    client=None,
    today: date | None = None,
    *,
    settings: Settings,
    item_ids: set[int] | None = None,
    on_complete: Callable[[set[int]], None] | None = None,
) -> dict:
    db.rollback()
    items = _sync_items(db, item_ids)
    db.rollback()
    if not items:
        if on_complete is not None:
            on_complete(set())
        return status(db)

    client = client or PlaidClient(settings, db)
    today = today or date.today()
    state = sync_state(db)
    state.added = state.matched = state.suggested = state.queued = 0
    if item_ids is None:
        state.errors = [issue for issue in state.errors if issue["kind"] == "schedule_entry"]
    db.commit()
    incomplete_item_ids = set()
    for item in items:
        with operation("sync.item", item_id=item.id) as outcome:
            try:
                token = decrypt_access_token(settings.secret, item.access_token_enc)
                _store_bank_status(db, item, *client.transactions_status(token))
                fetched = _fetch_item(client, token, item)
                incomplete = _apply_fetched_item(db, item, fetched, today)
                outcome.update(state="fetching" if incomplete else "complete", added=len(fetched.added), modified=len(fetched.modified), removed=len(fetched.removed))
                if incomplete:
                    incomplete_item_ids.add(item.id)
            except Exception as exc:  # An institution failure must not halt the others.
                db.rollback()
                state = sync_state(db)
                account_ids = list(
                    db.scalars(
                        select(PlaidAccountLink.account_id).where(
                            PlaidAccountLink.plaid_item_id == item.id
                        )
                    ).all()
                )
                state.errors = [*(state.errors or []), _sync_issue(exc, account_ids)]
                db.commit()
                outcome["state"] = "failed"
                diagnostics.emit("sync.item_failed", "error", error=exc, code=exc.code if isinstance(exc, AppError) else "plaid_sync_failed")
    with read_snapshot(db):
        queued = ledger_projection.review_count(db)
    state = sync_state(db)
    state.queued = queued
    state.last_sync = datetime.now()
    db.commit()
    if on_complete is not None:
        on_complete(incomplete_item_ids)
    return status(db)
