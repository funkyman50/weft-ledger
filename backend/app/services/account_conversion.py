import hashlib
import json
from datetime import date, datetime, timedelta
from itertools import batched
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import SQL_ID_BATCH_SIZE
from app.diagnostics import diagnostic_context, diagnostics, operation
from app.errors import AppError
from app.models import (
    Account,
    AccountConversionAttempt,
    AccountConversionRow,
    Category,
    Payee,
    PlaidAccountLink,
    PlaidItem,
    Transaction,
    TransactionMatch,
)
from app.schemas import AccountCreate
from app.services import account_initialization as initialization
from app.services import (
    accounts,
    categories,
    ledger,
    ledger_history,
    ledger_projection,
    payees,
    reported_balances,
)
from app.services import transaction_matching as matching
from app.services.plaid_client import (
    decrypt_access_token,
    encrypt_access_token,
    plaid_error_kind,
)
from app.services.reported_balances import balance_cents
from app.services.plaid_sync import (
    create_plaid_row,
    jsonable_payload,
    reconnect_plaid_row,
    UNKNOWN_INSTITUTION_NAME,
    refresh_item_institution,
    transaction_values,
)

REVIEW_ROW_FIELDS = (
    "id", "account_id", "date", "description", "amount_cents", "status",
    "manually_cleared", "approved", "source", "payee_id", "transfer_account_id", "transfer_payee_confirmed", "category_id",
    "category_assigned", "memo", "flag", "plaid_txn_id", "plaid_removed_at",
    "plaid_excluded_at", "feed_replacement_id", "pending_replacement_id",
    "transfer_partner_id", "feed_historical_at", "provider_lifecycle_detached_at",
)


def _attempt(db: Session, attempt_id: str) -> AccountConversionAttempt:
    attempt = db.get(AccountConversionAttempt, attempt_id)
    if attempt is None:
        raise AppError("conversion_not_found", "That bank connection review is no longer available.", 404)
    return attempt


def _active_attempt(db: Session) -> AccountConversionAttempt | None:
    return db.scalar(select(AccountConversionAttempt).order_by(AccountConversionAttempt.created_at))


def _item_links(db: Session, item_id: int) -> list[PlaidAccountLink]:
    return db.scalars(
        select(PlaidAccountLink)
        .where(PlaidAccountLink.plaid_item_id == item_id)
        .order_by(PlaidAccountLink.id)
    ).all()


def _shared_item(db: Session, item_id: int) -> bool:
    return bool(_item_links(db, item_id))


def _require_mapped_accounts_present(
    db: Session, item_id: int, provider_accounts: list[dict]
) -> list[PlaidAccountLink]:
    links = _item_links(db, item_id)
    provider_ids = {
        row.get("account_id")
        for row in provider_accounts
        if isinstance(row.get("account_id"), str)
    }
    missing = [link for link in links if link.plaid_account_id not in provider_ids]
    if missing:
        names = [
            account.name
            for account in (db.get(Account, link.account_id) for link in missing)
            if account is not None
        ]
        raise AppError(
            "conversion_mapped_account_missing",
            "Bank access is missing for " + ", ".join(names or ["a connected account"]) + ". Update bank access again and keep every connected account selected.",
            409,
            {"account_ids": [link.account_id for link in missing]},
        )
    return links


def _bank_access_problem(
    error: Exception, *, shared_item_id: int | None
) -> tuple[str, str, int, dict]:
    detail = {"recovery": None, "shared_item_id": shared_item_id}
    if isinstance(error, AppError):
        error_detail = error.detail if isinstance(error.detail, dict) else {}
        if error.code == "conversion_mapped_account_missing":
            return (
                error.code,
                error.message,
                409,
                detail | {"recovery": "update_access"} | error_detail,
            )
        if error.code == "conversion_provider_account_missing" and shared_item_id is not None:
            return (
                "conversion_selected_account_missing",
                "The bank no longer shares the selected account. Update bank access for this existing login and choose it again.",
                409,
                detail | {"recovery": "update_access"},
            )
        if error.code == "plaid_local_token_unreadable":
            return error.code, error.message, 409, detail | {"recovery": "disconnect"}
        if error.code == "plaid_balance_invalid":
            return error.code, error.message, 424, detail | error_detail
        return error.code, error.message, error.status, detail | error_detail
    kind = plaid_error_kind(error)
    if kind == "login_required" and shared_item_id is not None:
        return (
            "conversion_bank_access_action_required",
            "Bank sign-in or consent needs attention. Update bank access for this existing login and keep its connected accounts selected.",
            424,
            detail | {"recovery": "update_access"},
        )
    if kind == "item_missing":
        return (
            "conversion_bank_item_missing",
            "This bank connection no longer exists at Plaid. Disconnect its local accounts to preserve their history.",
            424,
            detail | {"recovery": "disconnect"},
        )
    if kind == "temporary":
        return (
            "conversion_bank_temporary",
            "The bank connection is temporarily unavailable. Try again later.",
            424,
            detail,
        )
    return (
        "conversion_bank_unavailable",
        "Weft could not refresh this bank account. Try again shortly.",
        424,
        detail,
    )


def _validate_provider_account(
    account: Account, provider_accounts: list[dict], provider_account_id: str
) -> dict:
    provider = next(
        (row for row in provider_accounts if row.get("account_id") == provider_account_id),
        None,
    )
    if provider is None:
        raise AppError("conversion_provider_account_missing", "Choose an account returned by the bank connection.", 422)
    currency = (provider.get("balances") or {}).get("iso_currency_code")
    if currency and currency != "USD":
        raise AppError("conversion_currency_unsupported", "Only USD bank accounts can be connected.", 422)
    if not _provider_type_compatible(provider.get("type"), account.type):
        raise AppError("conversion_type_mismatch", "The selected bank account type is not compatible with this account.", 422)
    return provider


def _revoke_unused_item(db: Session, client, secret: str, token: str, item: PlaidItem) -> bool:
    try:
        client.remove_item(token)
        return True
    except Exception as revoke_error:
        try:
            db.add(PlaidItem(
                item_id=item.item_id,
                client_id_hash=item.client_id_hash,
                environment=item.environment,
                access_token_enc=encrypt_access_token(secret, token),
                institution=item.institution,
                institution_id=item.institution_id,
            ))
            db.commit()
        except Exception:
            db.rollback()
            raise AppError(
                "plaid_item_custody_failed",
                "Plaid could not revoke the connection and Weft could not preserve its encrypted custody. Stop and inspect the connection before retrying.",
                500,
            ) from revoke_error
        return False


def cleanup_orphaned_items(db: Session, client, secret: str) -> None:
    linked_item_ids = set(db.scalars(select(PlaidAccountLink.plaid_item_id)).all())
    staged_item_ids = set(db.scalars(select(AccountConversionAttempt.plaid_item_id)).all())
    orphaned = db.scalars(
        select(PlaidItem).where(
            PlaidItem.id.not_in(linked_item_ids | staged_item_ids)
        )
    ).all()
    for item in orphaned:
        try:
            client.remove_item(decrypt_access_token(secret, item.access_token_enc))
        except Exception as exc:
            raise AppError(
                "conversion_orphan_cleanup_failed",
                "Weft must finish cleaning up an earlier bank connection before starting another.",
                424,
            ) from exc
        db.delete(item)
    if orphaned:
        db.commit()


def _target(db: Session, account_id: int) -> Account:
    account = db.get(Account, account_id)
    if account is None:
        raise AppError("account_not_found", "Account not found", 404)
    if account.closed:
        raise AppError("conversion_account_closed", "Reopen this account before connecting a bank feed.", 422)
    if db.scalar(select(PlaidAccountLink.id).where(PlaidAccountLink.account_id == account.id)):
        raise AppError("conversion_feed_active", "This account already has an active bank feed.", 409)
    return account


def _provider_type_compatible(provider_type: str | None, account_type: str) -> bool:
    return (
        provider_type == "depository" and account_type in ("checking", "savings")
        or provider_type == "cash" and account_type == "cash"
        or provider_type == "credit" and account_type == "credit"
        or provider_type == "loan" and account_type == "loan"
    )


def link_token_status(db: Session, account_id: int) -> dict:
    _target(db, account_id)
    attempt = _active_attempt(db)
    return {"attempt": summary(db, attempt) if attempt is not None else None}


def _linked_item(db: Session, item_id: int) -> PlaidItem:
    item = db.get(PlaidItem, item_id)
    if item is None or not _shared_item(db, item_id):
        raise AppError("conversion_existing_item_missing", "That existing bank connection is no longer available.", 404)
    return item


def existing_item_accounts(
    db: Session, account_id: int, item_id: int, client, secret: str
) -> dict:
    _target(db, account_id)
    item = _linked_item(db, item_id)
    try:
        provider_accounts = client.accounts(
            decrypt_access_token(secret, item.access_token_enc)
        )
    except Exception as error:
        code, message, status, detail = _bank_access_problem(
            error, shared_item_id=item.id
        )
        raise AppError(code, message, status, detail) from error
    links = _item_links(db, item.id)
    linked_by_provider = {link.plaid_account_id: link for link in links}
    provider_ids = {
        row.get("account_id")
        for row in provider_accounts
        if isinstance(row.get("account_id"), str)
    }
    missing = [link for link in links if link.plaid_account_id not in provider_ids]

    def local_account(link: PlaidAccountLink | None) -> dict | None:
        if link is None:
            return None
        account = db.get(Account, link.account_id)
        return None if account is None else {"id": account.id, "name": account.name}

    return {
        "item_id": item.id,
        "institution": item.institution,
        "accounts": [
            {
                "provider_account_id": row["account_id"],
                "name": row.get("name") or "Bank account",
                "mask": row.get("mask"),
                "type": row.get("type"),
                "subtype": row.get("subtype"),
                "currency": (row.get("balances") or {}).get("iso_currency_code"),
                "current_balance_cents": balance_cents(
                    (row.get("balances") or {}).get("current"),
                    row.get("type") in ("credit", "loan"),
                ),
                "mapped_account": local_account(linked_by_provider.get(row["account_id"])),
            }
            for row in provider_accounts
            if isinstance(row.get("account_id"), str)
        ],
        "missing_mapped_accounts": [
            account
            for account in (local_account(link) for link in missing)
            if account is not None
        ],
    }


def existing_item_update_link_token(
    db: Session, account_id: int, item_id: int, client, secret: str
) -> dict:
    _target(db, account_id)
    item = _linked_item(db, item_id)
    access_token = decrypt_access_token(secret, item.access_token_enc)
    db.rollback()
    return {
        "link_token": client.create_update_link_token(
            access_token,
            account_selection_enabled=True,
        )
    }


def stage_existing_item(
    db: Session,
    account_id: int,
    item_id: int,
    provider_account_id: str,
    client,
    secret: str,
    jobs,
) -> dict:
    account = _target(db, account_id)
    existing = _active_attempt(db)
    if existing is not None:
        raise AppError("conversion_already_staged", "Resume or cancel the existing bank connection before starting another.", 409, {"attempt_id": existing.id})
    item = _linked_item(db, item_id)
    token = decrypt_access_token(secret, item.access_token_enc)
    try:
        provider_accounts = client.accounts(token)
    except Exception as error:
        code, message, status, detail = _bank_access_problem(
            error, shared_item_id=item.id
        )
        raise AppError(code, message, status, detail) from error
    provider = _validate_provider_account(account, provider_accounts, provider_account_id)
    ledger_history.reserve_write(db)
    try:
        account = _target(db, account_id)
        existing = _active_attempt(db)
        if existing is not None:
            raise AppError(
                "conversion_already_staged",
                "Resume or cancel the existing bank connection before starting another.",
                409,
                {"attempt_id": existing.id},
            )
        item = _linked_item(db, item_id)
        if db.scalar(
            select(PlaidAccountLink.id).where(
                PlaidAccountLink.plaid_item_id == item.id,
                PlaidAccountLink.plaid_account_id == provider_account_id,
            )
        ) is not None:
            raise AppError("conversion_provider_account_mapped", "That bank account is already connected to Weft.", 409)
        _require_mapped_accounts_present(db, item.id, provider_accounts)
        now = datetime.now()
        attempt = AccountConversionAttempt(
            id=str(uuid4()),
            account_id=account.id,
            plaid_item_id=item.id,
            plaid_account_id=provider_account_id,
            state="fetching",
            provider_account=jsonable_payload(provider),
            created_at=now,
            updated_at=now,
        )
        db.add(attempt)
        db.commit()
    except Exception:
        db.rollback()
        raise
    jobs.enqueue_conversion(attempt.id)
    return summary(db, _attempt(db, attempt.id))


def exchange(
    db: Session, account_id: int, public_token: str, institution: str, institution_id: str | None,
    provider_account_id: str, client, secret: str, jobs, mark_terminal_commit,
) -> dict:
    account = _target(db, account_id)
    existing = _active_attempt(db)
    if existing:
        raise AppError("conversion_already_staged", "Resume or cancel the existing bank connection before starting another.", 409, {"attempt_id": existing.id})
    item_id, token = client.exchange_public_token(public_token)
    item = PlaidItem(item_id=item_id, institution=institution or UNKNOWN_INSTITUTION_NAME, institution_id=institution_id, **client.identity)
    try:
        provider_accounts = client.accounts(token)
        provider = _validate_provider_account(account, provider_accounts, provider_account_id)
        item.access_token_enc = encrypt_access_token(secret, token)
        refresh_item_institution(item, client, token, institution_id)
        ledger_history.reserve_write(db)
        db.add(item)
        db.flush()
        now = datetime.now()
        attempt = AccountConversionAttempt(id=str(uuid4()), account_id=account.id, plaid_item_id=item.id, plaid_account_id=provider_account_id, state="fetching", provider_account=jsonable_payload(provider), created_at=now, updated_at=now)
        db.add(attempt)
        mark_terminal_commit()
        db.commit()
    except Exception as original_error:
        db.rollback()
        if not _revoke_unused_item(db, client, secret, token, item):
            raise AppError(
                "conversion_cleanup_failed",
                "The bank connection could not be staged or removed. Weft saved it securely and will retry cleanup before another connection.",
                424,
            ) from original_error
        raise
    jobs.enqueue_conversion(attempt.id)
    return summary(db, _attempt(db, attempt.id))


def request_fetch(db: Session, attempt_id: str, jobs) -> dict:
    ledger_history.reserve_write(db)
    attempt = _attempt(db, attempt_id)
    attempt.state, attempt.error, attempt.updated_at = "fetching", None, datetime.now()
    db.commit()
    jobs.enqueue_conversion(attempt.id)
    return summary(db, attempt)


def _upsert_rows(db: Session, attempt: AccountConversionAttempt, events: list[dict], removed: list[dict]) -> None:
    rows_by_provider_id = {
        row.provider_transaction_id: row
        for row in db.scalars(
            select(AccountConversionRow).where(
                AccountConversionRow.attempt_id == attempt.id
            )
        ).all()
    }
    for raw in events:
        if raw.get("account_id") != attempt.plaid_account_id:
            continue
        provider_id = raw.get("transaction_id")
        if not isinstance(provider_id, str):
            continue
        when, amount, description = transaction_values(raw)
        row = rows_by_provider_id.get(provider_id)
        pending_id = raw.get("pending_transaction_id")
        if row is None:
            row = AccountConversionRow(attempt_id=attempt.id, provider_transaction_id=provider_id, raw=jsonable_payload(raw), date=when, description=description, amount_cents=amount, pending=bool(raw.get("pending")), pending_transaction_id=pending_id)
            db.add(row)
            rows_by_provider_id[provider_id] = row
        else:
            row.raw, row.date, row.description, row.amount_cents, row.pending, row.removed_at = jsonable_payload(raw), when, description, amount, bool(raw.get("pending")), None
            row.pending_transaction_id = pending_id
    for row in rows_by_provider_id.values():
        if not row.pending and row.pending_transaction_id and row.removed_at is None:
            replaced = rows_by_provider_id.get(row.pending_transaction_id)
            if replaced is not None and replaced is not row:
                replaced.removed_at = datetime.now()
    for raw in removed:
        provider_id = raw.get("transaction_id")
        row = rows_by_provider_id.get(provider_id)
        if row is not None:
            row.removed_at = datetime.now()
    db.flush()


def _preflight_staged_identities(
    db: Session, attempt: AccountConversionAttempt
) -> None:
    staged = db.scalars(select(AccountConversionRow).where(
        AccountConversionRow.attempt_id == attempt.id,
        AccountConversionRow.removed_at.is_(None),
    )).all()
    identities = {row.provider_transaction_id for row in staged}
    identities.update(row.pending_transaction_id for row in staged if not row.pending and row.pending_transaction_id)
    existing_rows = [
        row
        for batch in batched(sorted(identities), SQL_ID_BATCH_SIZE)
        for row in db.scalars(select(Transaction).where(Transaction.plaid_txn_id.in_(batch))).all()
    ]
    existing_rows.sort(key=lambda row: row.id)
    for existing in existing_rows:
        if existing.account_id != attempt.account_id:
            account = db.get(Account, existing.account_id)
            name = account.name if account is not None else "the original account"
            raise AppError(
                "conversion_bank_identity_conflict",
                f"This bank transaction already belongs to {name}. Reopen or connect that original account instead.",
                409,
                {"account_id": existing.account_id},
            )


def fetch(
    db: Session, attempt_id: str, client, secret: str, *, preserve_review: bool = False
) -> dict:
    with operation("conversion.fetch", attempt_id=attempt_id, preserve_review=preserve_review) as outcome:
        attempt = _attempt(db, attempt_id)
        item = db.get(PlaidItem, attempt.plaid_item_id)
        if item is None:
            raise AppError("conversion_item_missing", "The staged bank connection is unavailable.", 409)
        if preserve_review and attempt.state != "review":
            raise AppError(
                "conversion_not_ready",
                "The bank connection is still refreshing. Wait for review to become available before connecting.",
                409,
            )
        outcome["item_id"] = item.id
        with diagnostic_context(item_id=item.id):
            shared_item = _shared_item(db, item.id)
            try:
                outcome["phase"] = "decrypt"
                token = decrypt_access_token(secret, item.access_token_enc)
                outcome["phase"] = "transactions"
                added, modified, removed, cursor, update_status = client.sync(token, attempt.cursor)
                outcome["phase"] = "accounts"
                provider_accounts = client.accounts(token)
                balance_received_at = datetime.now()
                outcome["phase"] = "validation"
                account = _target(db, attempt.account_id)
                if shared_item:
                    _require_mapped_accounts_present(db, item.id, provider_accounts)
                provider = _validate_provider_account(account, provider_accounts, attempt.plaid_account_id)
                balances = provider.get("balances") or {}
                currency = balances.get("iso_currency_code")
                attempt.current_balance_cents = balance_cents(balances.get("current"), account.type in ("credit", "loan"))
                attempt.available_balance_cents = balance_cents(balances.get("available"))
                attempt.limit_cents = balance_cents(balances.get("limit"))
                attempt.currency_code = currency if isinstance(currency, str) else None
                attempt.balance_fetched_at = balance_received_at
                attempt.provider_account = jsonable_payload(provider)
                outcome["phase"] = "staging"
                _upsert_rows(db, attempt, [*added, *modified], removed)
                _preflight_staged_identities(db, attempt)
                attempt.cursor = cursor
                if not shared_item:
                    item.cursor = cursor
                if shared_item:
                    attempt.state = "review"
                    _stage_ready_defaults(db, attempt)
                elif update_status == "HISTORICAL_UPDATE_COMPLETE" or attempt.history_complete_at is not None:
                    attempt.history_complete_at = attempt.history_complete_at or datetime.now()
                    attempt.state = "review"
                    _stage_ready_defaults(db, attempt)
                attempt.error = None
                attempt.updated_at = datetime.now()
                outcome["phase"] = "commit"
                db.commit()
                outcome.update(state=attempt.state, added=len(added), modified=len(modified), removed=len(removed), history_complete=attempt.history_complete_at is not None)
            except Exception as exc:
                db.rollback()
                attempt = _attempt(db, attempt_id)
                code, message, status, detail = _bank_access_problem(
                    exc, shared_item_id=item.id if shared_item else None
                )
                if preserve_review:
                    attempt.error, attempt.updated_at = message, datetime.now()
                    db.commit()
                    outcome.update(code=code, state="review")
                    raise AppError(
                        "conversion_bank_check_failed",
                        f"Final bank check stopped. {message} Your review is saved.",
                        status,
                        {"reason_code": code, **detail},
                    ) from exc
                attempt.state, attempt.error, attempt.updated_at = "failed", message, datetime.now()
                db.commit()
                outcome["state"] = "failed"
                diagnostics.emit("conversion.fetch_failed", "error", error=exc, code=code, state="failed", phase=outcome.get("phase"))
            return summary(db, _attempt(db, attempt_id))


def _returning_identity(
    staged: AccountConversionRow,
    account_id: int,
    direct_by_id: dict[str, Transaction],
    history_by_provider_id: dict[str, Transaction],
    replacements: dict[str, Transaction],
) -> Transaction | None:
    direct = direct_by_id.get(staged.provider_transaction_id)
    if direct is not None:
        return direct if direct.account_id == account_id and (direct.feed_replacement_id is None or staged.provider_transaction_id in replacements) else None
    if staged.pending or not staged.pending_transaction_id:
        return None
    predecessor = history_by_provider_id.get(staged.pending_transaction_id)
    if (
        predecessor is None
        or predecessor.feed_replacement_id is not None
        or predecessor.provider_lifecycle_detached_at is None
    ):
        return None
    return predecessor


def _returning_parent(
    identity: Transaction, returning_ids: set[int], relationships: dict[int, ledger_projection.RowRelationship],
    replacements: dict[str, Transaction],
) -> Transaction:
    if identity.plaid_txn_id in replacements:
        return replacements[identity.plaid_txn_id]
    parent = relationships[identity.id].parent or identity
    return identity if parent.id in returning_ids else parent


def _load_review_facts(db: Session, attempt: AccountConversionAttempt) -> dict:
    staged_rows = db.scalars(
        select(AccountConversionRow)
        .where(AccountConversionRow.attempt_id == attempt.id, AccountConversionRow.removed_at.is_(None))
        .order_by(AccountConversionRow.date, AccountConversionRow.id)
    ).all()
    direct_by_id = {
        row.plaid_txn_id: row
        for row in db.scalars(
            select(Transaction)
            .join(AccountConversionRow, Transaction.plaid_txn_id == AccountConversionRow.provider_transaction_id)
            .where(AccountConversionRow.attempt_id == attempt.id, AccountConversionRow.removed_at.is_(None))
        ).all()
    }
    stored = db.scalars(select(Transaction).where(Transaction.account_id == attempt.account_id)).all()
    stored_by_id = {row.id: row for row in stored}
    relationships = ledger_projection.resolve_relationships(db, stored)
    replacements, replacement_chains, superseded_skipped_ids = {}, {}, []
    for provider_id, identity in direct_by_id.items():
        if identity.account_id != attempt.account_id or identity.feed_replacement_id is None:
            continue
        chain, seen, current = [], set(), identity
        while current.feed_replacement_id is not None:
            if current.id in seen or current.feed_replacement_id not in stored_by_id:
                break
            seen.add(current.id)
            chain.append((current.id, current.feed_replacement_id))
            current = stored_by_id[current.feed_replacement_id]
        replacement = relationships[current.id].parent or current
        if current.feed_replacement_id is not None or replacement.id in seen or replacement.source != "plaid" or replacement.feed_historical_at is None or current.plaid_txn_id in direct_by_id or replacement.plaid_txn_id in direct_by_id:
            superseded_skipped_ids.append(provider_id)
            continue
        replacements[provider_id] = replacement
        replacement_chains[provider_id] = [*chain, (current.id, replacement.id)]
    superseded_skipped_ids.sort()
    superseded_id_set = set(superseded_skipped_ids)
    feed = [row for row in staged_rows if row.provider_transaction_id not in superseded_id_set]
    history = [
        row for row in stored
        if relationships[row.id].parent is not None and relationships[row.id].parent.id == row.id
        and row.source != "starting_balance"
        and row.feed_replacement_id is None
        and row.plaid_txn_id not in superseded_id_set
    ]
    history_by_provider_id = {row.plaid_txn_id: row for row in stored if row.plaid_txn_id is not None}
    identities = {
        bank.provider_transaction_id: _returning_identity(
            bank, attempt.account_id, direct_by_id, history_by_provider_id, replacements
        )
        for bank in feed
    }
    returning_ids = {row.id for row in identities.values() if row is not None}
    history_ids = {row.id for row in history}
    returning_parents = {}
    for bank in feed:
        identity = identities[bank.provider_transaction_id]
        if identity is None:
            continue
        parent = _returning_parent(identity, returning_ids, relationships, replacements)
        returning_parents[bank.provider_transaction_id] = parent
        if parent.id not in history_ids:
            history.append(parent)
            history_ids.add(parent.id)
    review_transactions = history + [
        row for row in stored if row.id in returning_ids and row.id not in history_ids
    ]
    lookups = ledger_projection.projection_lookups(db)
    projection = ledger_projection.project_rows(db, review_transactions, relationships=relationships, lookups=lookups)
    payee_rows = db.scalars(select(Payee).order_by(Payee.id)).all()
    return {
        "feed": feed,
        "history": history,
        "superseded_skipped_ids": superseded_skipped_ids,
        "identities": identities,
        "returning_parents": returning_parents,
        "returning_replacements": replacements,
        "replacement_chains": replacement_chains,
        "relationships": relationships,
        "active_matches": ledger_projection.active_matches_for(db, review_transactions),
        "effective_facts": ledger_projection.effective_facts_for_rows(db, review_transactions, relationships),
        "projection": projection,
        "lookups": lookups,
        "payees": payee_rows,
    }


def _key(feed_id: str, history_id: int) -> str:
    return f"{feed_id}:{history_id}"


def _history_structure(row: Transaction, relation: TransactionMatch | None) -> tuple:
    return (
        row.date.isoformat(),
        row.amount_cents,
        row.transfer_partner_id,
        None if relation is None else relation.id,
        None if relation is None else relation.feed_transaction_id,
        None if relation is None else relation.history_transaction_id,
    )


def _edge_choices(edge: dict, facts: dict) -> dict[str, str]:
    choices = matching.default_sources_from_facts(facts)
    if edge["fixed_owner"] is not None:
        choices["transfer_source"] = edge["fixed_owner"]
    return choices


def _decision_token(
    edge: dict, history_by_id: dict[int, Transaction], neighborhood: set[str],
    active_matches: dict[int, TransactionMatch],
) -> str:
    row = history_by_id[edge["history_id"]]
    value = {
        "feed_id": edge["feed_id"],
        "feed_date": edge["feed_date"],
        "feed_amount": edge["amount_cents"],
        "history": _history_structure(row, active_matches.get(row.id)),
        "neighborhood": sorted(neighborhood),
        "blocking_reason": edge["blocking_reason"],
        "fixed_owner": edge["fixed_owner"],
        "transfer_targets": edge["transfer_targets"],
    }
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def _proposal_state(
    db: Session, attempt: AccountConversionAttempt, resolver: payees.RuleEvaluator | None = None
) -> dict:
    loaded = _load_review_facts(db, attempt)
    feed, history, identities = loaded["feed"], loaded["history"], loaded["identities"]
    decisions = attempt.decisions or {}
    claimed = [row.id for row in identities.values() if row is not None]
    if len(set(claimed)) != len(claimed):
        raise AppError("conversion_bank_identity_conflict", "Multiple bank rows claim the same retained transaction. Refresh the connection review.", 409)
    returning_parents = loaded["returning_parents"]
    returning_history_ids = {row.id for row in returning_parents.values()}
    if len(returning_history_ids) != len(returning_parents):
        raise AppError("conversion_bank_identity_conflict", "Multiple bank rows claim the same retained transaction. Refresh the connection review.", 409)
    resolver = resolver or payees.load_evaluator(db)
    history_by_id = {row.id: row for row in history}
    effective_facts = loaded["effective_facts"]
    history_by_amount = {}
    for row in history:
        if row.id not in returning_history_ids:
            history_by_amount.setdefault(row.amount_cents, []).append(row)
    edges: list[dict] = []
    feed_rows = {}
    for bank in feed:
        returning = returning_parents.get(bank.provider_transaction_id)
        resolved = resolver.resolve(
            attempt.account_id, bank.amount_cents, bank.description,
            (bank.raw or {}).get("merchant_name"),
        )
        fallback = payees.fallback_name(bank.raw or {})
        if resolved["payee_id"] is None and fallback is None:
            raise AppError("payee_import_missing", "This bank transaction has no usable Payee. Add a Payee rule for its account or amount, then refresh this conversion review.", 422)
        fallback_payee = db.scalar(select(Payee).where(Payee.name_key == payees.name_key(fallback))) if resolved["payee_id"] is None and fallback is not None else None
        if fallback_payee is not None and fallback_payee.kind != "ordinary":
            raise AppError("payee_import_reserved", "This bank Payee matches a protected system name. Add a Payee rule for its account or amount, then refresh this conversion review.", 422)
        if fallback_payee is not None:
            resolved["payee_id"] = fallback_payee.id
        resolved["payee_name"] = resolver.names.get(resolved["payee_id"]) if resolved["payee_id"] is not None else fallback
        bank_payee_id = resolved["payee_id"]
        bank_category = payees.active_category(db, resolved["category_id"])
        if bank_category is None and bank_payee_id is not None:
            bank_category = payees.default_category(db, bank_payee_id)
        feed_rows[bank.provider_transaction_id] = _feed_row(bank, resolved, bank_category, loaded["lookups"].categories)
        candidates = [returning] if returning is not None else [
            row for row in history_by_amount.get(bank.amount_cents, [])
            if abs((row.date - bank.date).days) <= 7
        ]
        for row in candidates:
            distance = abs((row.date - bank.date).days)
            history_fact = effective_facts[row.id]
            history_payee_id = history_fact["payee_id"]
            history_anchor = history_fact["relationship"].anchor
            blocking_reason = None
            fixed_owner = None
            transfer_conflict = False
            try:
                transfer_policy = matching.transfer_match_policy(
                    db,
                    {"payee_id": bank_payee_id, "transfer_account_id": None, "category": {"category_id": None if bank_category is None else bank_category.id, "allocations": []}},
                    history_fact,
                    None,
                    history_anchor.transfer_partner_id,
                )
                fixed_owner = transfer_policy["fixed_owner"]
                transfer_conflict = transfer_policy["targets_conflict"]
            except AppError as exc:
                blocking_reason = exc.message
            payee_conflict = (
                bank_payee_id is not None
                and history_payee_id is not None
                and bank_payee_id != history_payee_id
            )
            edge = {
                "feed_id": bank.provider_transaction_id,
                "history_id": row.id,
                "feed_date": bank.date.isoformat(),
                "amount_cents": bank.amount_cents,
                "distance": distance,
                "key": _key(bank.provider_transaction_id, row.id),
                "returning": returning is not None,
                "pending": bank.pending,
                "payee_conflict": payee_conflict,
                "blocking_reason": blocking_reason,
                "fixed_owner": fixed_owner,
                "transfer_targets": (None, history_fact["transfer_account_id"]),
                "automatic_eligible": returning is not None or (not bank.pending and distance <= 4 and not payee_conflict and not transfer_conflict and blocking_reason is None),
            }
            edges.append(edge)
    posted_edges = [edge for edge in edges if not edge["pending"]]
    feed_neighbors, history_neighbors = {}, {}
    for edge in edges:
        feed_neighbors.setdefault(edge["feed_id"], set()).add(edge["key"])
        history_neighbors.setdefault(edge["history_id"], set()).add(edge["key"])
    for edge in edges:
        neighborhood = feed_neighbors[edge["feed_id"]] | history_neighbors[edge["history_id"]]
        edge["decision_token"] = _decision_token(edge, history_by_id, neighborhood, loaded["active_matches"])
        stored = decisions.get(edge["key"], {})
        valid = stored.get("decision_token") == edge["decision_token"]
        edge["decision"] = ({"state": "accepted", "bucket": "ready", "choices": _edge_choices(edge, effective_facts[edge["history_id"]])} if edge["returning"] else stored if valid else None)
    deterministic = matching.deterministic_edge_keys([
        edge | {
            "automatic_eligible": edge["automatic_eligible"]
            and (edge["decision"] or {}).get("state") != "separate"
        }
        for edge in posted_edges
    ])
    for edge in edges:
        stored = edge["decision"] or {}
        valid = edge["decision"] is not None
        edge["bucket"] = (
            stored.get("bucket")
            if valid and stored.get("bucket") in ("ready", "choice", "pending")
            else "ready" if edge["returning"] or edge["key"] in deterministic else "pending" if edge["pending"] else "choice"
        )
    ready = [edge for edge in edges if edge["bucket"] == "ready"]
    pending_edges = [edge for edge in edges if edge["pending"]]
    accepted = [
        edge for edge in edges
        if edge["decision"] and edge["decision"].get("state") == "accepted"
    ]
    accepted_feed = {edge["feed_id"] for edge in accepted}
    accepted_history = {edge["history_id"] for edge in accepted}
    unresolved = [
        edge for edge in posted_edges
        if not (
            edge["decision"]
            and edge["decision"].get("state") in ("accepted", "separate")
        )
        and edge["feed_id"] not in accepted_feed
        and edge["history_id"] not in accepted_history
    ]
    return {
        **loaded,
        "feed_rows": feed_rows,
        "edges": edges,
        "pending_edges": pending_edges,
        "ready": ready,
        "accepted": accepted,
        "unresolved": unresolved,
    }


def _stage_ready_defaults(db: Session, attempt: AccountConversionAttempt) -> None:
    state = _proposal_state(db, attempt)
    decisions = dict(attempt.decisions or {})
    for edge in state["edges"]:
        if edge["pending"] or edge["returning"]:
            continue
        decisions.setdefault(
            edge["key"],
            {
                "state": "accepted" if edge["bucket"] == "ready" else "unresolved",
                "bucket": edge["bucket"],
                "choices": _edge_choices(edge, state["effective_facts"][edge["history_id"]]),
                "decision_token": edge["decision_token"],
            },
        )
    attempt.decisions = decisions


def _token(db: Session, attempt: AccountConversionAttempt, state: dict) -> str:
    history = []
    for row in state["history"]:
        effective = state["effective_facts"][row.id]
        relationship = ledger_projection.relationship_facts(
            db, row, effective
        )
        partner_id = relationship["transfer"]["partner_id"]
        partner = db.get(Transaction, partner_id) if partner_id else None
        history.append({
            "row": {
                field: getattr(row, field)
                for field in REVIEW_ROW_FIELDS
            },
            "relationship": relationship,
            "history_structure": _history_structure(row, state["active_matches"].get(row.id)),
            "comparison_description": matching.history_comparison_description(row, state["active_matches"].get(row.id)),
            "transfer_review": ledger_projection.transfer_summary(
                db, row, effective["category"], relationship=effective["relationship"],
                partner_relationships=state["lookups"].partner_relationships,
            ),
            "partner": (
                (partner.id, partner.account_id, partner.transfer_partner_id)
                if partner else None
            ),
        })
    baseline = db.scalar(
        select(Transaction).where(
            Transaction.account_id == attempt.account_id,
            Transaction.source == "starting_balance",
        )
    )
    account = db.get(Account, attempt.account_id)
    payee_rows = state["payees"]
    default_categories = state["lookups"].categories

    def category_fact(category_id: int | None):
        category = default_categories.get(category_id)
        return (
            (category.id, category.name, category.parent_id, category.archived)
            if category else None
        )

    rule_rows = payees.stored_rules(db)
    value = {
        "attempt": {
            "id": attempt.id,
            "account_id": attempt.account_id,
            "plaid_item_id": attempt.plaid_item_id,
            "plaid_account_id": attempt.plaid_account_id,
            "state": attempt.state,
            "balance": attempt.current_balance_cents,
            "currency": attempt.currency_code,
            "review_all_new": attempt.review_all_new,
        },
        "decisions": attempt.decisions,
        "superseded_skipped_ids": state["superseded_skipped_ids"],
        "superseded_skipped_count": len(state["superseded_skipped_ids"]),
        "replacement_chains": state["replacement_chains"],
        "feed": [
            (
                row.provider_transaction_id,
                row.date.isoformat(),
                row.amount_cents,
                row.pending,
                row.pending_transaction_id,
                row.description,
                tuple((row.raw or {}).get(field) for field in ("name", "original_description", "merchant_name")),
                str(row.removed_at),
            )
            for row in state["feed"]
        ],
        "history": history,
        "identities": {
            key: ledger_projection.edit_token(
                db, row, row, state["active_matches"].get(row.id),
                state["effective_facts"][row.id]["category"], state["relationships"][row.id].anchor,
                context=state["lookups"],
            )
            for key, row in state["identities"].items() if row is not None
        },
        "baseline": (
            (baseline.id, baseline.date, baseline.amount_cents, baseline.status, baseline.approved)
            if baseline else None
        ),
        "account": (account.id, account.type, account.closed) if account else None,
        "payees": [
            (row.id, row.name, row.default_category_id)
            for row in payee_rows
        ],
        "default_categories": [
            (row.id, category_fact(row.default_category_id), category_fact(
                default_categories[row.default_category_id].parent_id
            ) if row.default_category_id in default_categories else None)
            for row in payee_rows if row.default_category_id is not None
        ],
        "rules": [
            payees.rule_data(row)
            for row in rule_rows
        ],
        "rule_categories": [
            (row.id, category_fact(row.category_id), category_fact(
                default_categories[row.category_id].parent_id
            ) if row.category_id in default_categories else None)
            for row in rule_rows if row.category_id is not None
        ],
    }
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def final_check_facts(db: Session, attempt_id: str) -> dict:
    attempt = _attempt(db, attempt_id)
    return {
        "active_bank_row_ids": {
            row.provider_transaction_id
            for row in db.scalars(
                select(AccountConversionRow).where(
                    AccountConversionRow.attempt_id == attempt.id,
                    AccountConversionRow.removed_at.is_(None),
                )
            ).all()
        },
        "current_balance_cents": attempt.current_balance_cents,
    }


def final_check_stale_detail(before: dict, after: dict) -> dict:
    detail = {}
    new_count = len(after["active_bank_row_ids"] - before["active_bank_row_ids"])
    if new_count:
        detail["new_active_bank_row_count"] = new_count
    before_balance = before["current_balance_cents"]
    after_balance = after["current_balance_cents"]
    if before_balance is not None and after_balance is not None and before_balance != after_balance:
        detail["current_balance_delta_cents"] = after_balance - before_balance
    return detail


REVIEW_BUCKETS = ("ready", "choice", "new", "kept", "pending")


def _review_rows(state: dict) -> dict:
    ready_edges = [edge for edge in state["edges"] if edge["bucket"] == "ready"]
    ready_history_by_feed = {edge["feed_id"]: edge["history_id"] for edge in ready_edges}
    returning_feed = {edge["feed_id"] for edge in ready_edges if edge["returning"]}
    ready_history = {edge["history_id"] for edge in ready_edges}
    choice_edges = [
        edge for edge in state["edges"]
        if edge["bucket"] == "choice"
        and edge["feed_id"] not in ready_history_by_feed
        and edge["history_id"] not in ready_history
    ]
    choice_feed = {edge["feed_id"] for edge in choice_edges}
    choice_history = {edge["history_id"] for edge in choice_edges}
    pending_history = {edge["history_id"] for edge in state["pending_edges"]}
    matched_history_by_feed = {edge["feed_id"]: edge["history_id"] for edge in state["accepted"]}
    matched_feed_by_history = {edge["history_id"]: edge["feed_id"] for edge in state["accepted"]}
    undecided_by_feed: dict[str, list[dict]] = {}
    for edge in state["unresolved"]:
        undecided_by_feed.setdefault(edge["feed_id"], []).append(edge)
    feed = {}
    for row in state["feed"]:
        feed_id = row.provider_transaction_id
        undecided = undecided_by_feed.get(feed_id, [])
        blocked = bool(undecided) and all(edge["blocking_reason"] for edge in undecided)
        feed[feed_id] = {
            "review_bucket": (
                "pending" if row.pending
                else "ready" if feed_id in ready_history_by_feed
                else "choice" if feed_id in choice_feed
                else "new"
            ),
            "review_status": (
                "matched" if feed_id in matched_history_by_feed
                else "pending" if row.pending
                else "blocked" if blocked
                else "open" if undecided
                else "new"
            ),
            "matched_history_id": matched_history_by_feed.get(feed_id),
            "ready_history_id": None if feed_id in returning_feed else ready_history_by_feed.get(feed_id),
            "blocking_reason": undecided[0]["blocking_reason"] if blocked else None,
        }
    history = {
        row.id: {
            "review_bucket": (
                "ready" if row.id in ready_history
                else "choice" if row.id in choice_history
                else "pending" if row.id in pending_history
                else "kept"
            ),
            "matched_feed_id": matched_feed_by_history.get(row.id),
        }
        for row in state["history"]
    }
    return {"feed": feed, "history": history}


def _bucket_counts(rows: dict) -> dict:
    counts = {bucket: {"rows": 0, "open": 0, "matched": 0} for bucket in REVIEW_BUCKETS}
    for info in rows["feed"].values():
        count = counts[info["review_bucket"]]
        count["rows"] += 1
        count["open"] += info["review_status"] in ("open", "blocked")
        count["matched"] += info["review_status"] == "matched"
    counts["kept"]["rows"] = sum(info["review_bucket"] == "kept" for info in rows["history"].values())
    return counts


def _preview_from_state(
    db: Session, attempt: AccountConversionAttempt, state: dict, review_rows: dict | None = None
) -> dict:
    accepted = state["accepted"]
    accepted_history = {edge["history_id"] for edge in accepted}
    returning_by_feed = {
        edge["feed_id"]: edge["history_id"]
        for edge in accepted
        if edge["returning"]
    }
    history_by_id = {row.id: row for row in state["history"]}
    returning_ids = {row.id for row in state["identities"].values() if row is not None}
    hidden_returning_feed_ids = {
        feed_id for feed_id, identity in state["identities"].items()
        if identity is not None
        and (parent := state["relationships"][identity.id].parent) is not None
        and parent.id != identity.id and parent.id in returning_ids
    }
    visible_feed = [
        row
        for row in state["feed"]
        if row.provider_transaction_id not in hidden_returning_feed_ids and (
            (history_id := returning_by_feed.get(row.provider_transaction_id)) is None
            or history_by_id[history_id].plaid_excluded_at is None
        )
    ]
    visible_feed_ids = {row.provider_transaction_id for row in visible_feed}
    cleared_feed_ids = {
        row.provider_transaction_id for row in visible_feed
        if not row.pending or (
            (clearance_source := state["returning_replacements"].get(row.provider_transaction_id) or state["identities"].get(row.provider_transaction_id)) is not None
            and clearance_source.manually_cleared
            and history_by_id[returning_by_feed[row.provider_transaction_id]].amount_cents == row.amount_cents
        )
    }
    retained_history = [row for row in state["history"] if row.id not in accepted_history]
    history_cleared = sum(
        row.amount_cents
        for row in retained_history
        if row.status in ("cleared", "reconciled") and not ledger_projection.missing_pending(row)
    )
    feed_cleared = sum(
        row.amount_cents for row in visible_feed if row.provider_transaction_id in cleared_feed_ids
    )
    baseline = (
        None
        if attempt.current_balance_cents is None
        else attempt.current_balance_cents - history_cleared - feed_cleared
    )
    if baseline is not None and abs(baseline) > initialization.MAX_SAFE_CENTS:
        baseline = None
    pending = [row for row in visible_feed if row.pending]
    undecided_pending = [
        edge for edge in state["pending_edges"]
        if edge["feed_id"] not in {item["feed_id"] for item in accepted}
        and edge["history_id"] not in accepted_history
        and (not edge["decision"] or edge["decision"].get("state") not in ("accepted", "separate"))
    ]
    pending_candidate_feed_ids = {edge["feed_id"] for edge in undecided_pending}
    pending_candidate_rows = [
        row for row in pending
        if row.provider_transaction_id in pending_candidate_feed_ids
    ]
    history_uncleared = sum(
        row.amount_cents
        for row in retained_history
        if row.status not in ("cleared", "reconciled") and not ledger_projection.missing_pending(row)
    )
    after_uncleared = history_uncleared + sum(row.amount_cents for row in pending if row.provider_transaction_id not in cleared_feed_ids)
    before = ledger_projection.balances(db, attempt.account_id)
    old_baseline = db.scalar(
        select(Transaction).where(
            Transaction.account_id == attempt.account_id,
            Transaction.source == "starting_balance",
        )
    )
    all_dates = [row.date for row in state["history"]] + [row.date for row in state["feed"]]
    oldest = min(all_dates, default=old_baseline.date + timedelta(days=1) if old_baseline else date.today())
    projected_rows = [{
        "id": -1,
        "date": oldest - timedelta(days=1),
        "amount_cents": baseline or 0, "source": "starting_balance",
        "missing_pending": False,
        "excluded": False,
    }]
    projected_rows.extend({
        "id": row.id,
        "date": row.date,
        "amount_cents": row.amount_cents,
        "source": row.source,
        "missing_pending": ledger_projection.missing_pending(row),
        "excluded": row.plaid_excluded_at is not None,
    } for row in retained_history)
    next_id = max([row.id for row in state["history"]], default=0) + 1
    projected_rows.extend({
        "id": next_id + index,
        "date": row.date,
        "amount_cents": row.amount_cents,
        "missing_pending": False,
        "excluded": row.provider_transaction_id not in visible_feed_ids, "source": "plaid",
    } for index, row in enumerate(state["feed"]))
    running = ledger_projection.running_balance_projection(projected_rows)
    seam = min(state["history"], key=lambda row: (row.date, row.id), default=None)
    seam_before = None
    seam_after = None
    if seam is not None:
        before_rows = [row for row in running if row["date"] < seam.date and row["running_balance_cents"] is not None]
        through_rows = [row for row in running if row["date"] <= seam.date and row["running_balance_cents"] is not None]
        seam_before = before_rows[-1]["running_balance_cents"] if before_rows else 0
        seam_after = through_rows[-1]["running_balance_cents"] if through_rows else seam_before
    buckets = _bucket_counts(review_rows if review_rows is not None else _review_rows(state))
    return {
        "preview_token": _token(db, attempt, state),
        "buckets": buckets,
        "unresolved_count": sum(count["open"] for count in buckets.values()),
        "matched_count": sum(not edge["returning"] for edge in accepted),
        "returning_count": sum(edge["returning"] for edge in accepted),
        "returning_ready_count": sum(edge["returning"] and not edge["pending"] for edge in accepted),
        "superseded_skipped_count": len(state["superseded_skipped_ids"]),
        "pending_candidate_count": len(pending_candidate_rows),
        "pending_candidate_amount_cents": sum(row.amount_cents for row in pending_candidate_rows),
        "plaid_current_balance_cents": attempt.current_balance_cents,
        "currency_code": attempt.currency_code,
        "currency_warning": attempt.currency_code is None,
        "balance_fetched_at": attempt.balance_fetched_at,
        "before": {
            "cleared_balance_cents": before["cleared_balance_cents"],
            "uncleared_balance_cents": before["uncleared_balance_cents"],
            "working_balance_cents": before["working_balance_cents"],
        },
        "after": None if attempt.current_balance_cents is None else {
            "cleared_balance_cents": attempt.current_balance_cents,
            "uncleared_balance_cents": after_uncleared,
            "working_balance_cents": attempt.current_balance_cents + after_uncleared,
        },
        "previous_starting_balance_cents": None if old_baseline is None else old_baseline.amount_cents,
        "starting_balance_cents": baseline,
        "starting_balance_date": oldest - timedelta(days=1),
        "history_seam_date": None if seam is None else seam.date,
        "history_seam_before_cents": seam_before,
        "history_seam_after_cents": seam_after,
        "can_commit": (
            attempt.state == "review"
            and attempt.current_balance_cents is not None
            and attempt.currency_code in (None, "USD")
            and baseline is not None
            and not state["unresolved"]
        ),
    }


def summary(
    db: Session, attempt: AccountConversionAttempt, state: dict | None = None,
    review_rows: dict | None = None,
) -> dict:
    item = db.get(PlaidItem, attempt.plaid_item_id)
    shared_item = item is not None and _shared_item(db, item.id)
    return {
        "id": attempt.id,
        "account_id": attempt.account_id,
        "state": attempt.state,
        "error": attempt.error,
        "institution": item.institution if item else UNKNOWN_INSTITUTION_NAME,
        "shared_item_id": item.id if shared_item else None,
        "provider_account": attempt.provider_account,
        "review_all_new": attempt.review_all_new,
        "review": _preview_from_state(db, attempt, state, review_rows) if state is not None else None,
    }


def _page(rows: list, cursor: str | None, limit: int) -> tuple[list, str | None]:
    offset = int(cursor or 0)
    loaded = rows[:offset + limit]
    return loaded, str(len(loaded)) if len(loaded) < len(rows) else None


def _feed_row(
    row: AccountConversionRow, resolved: dict, category: Category | None,
    category_map: dict[int, Category],
) -> dict:
    raw = row.raw or {}
    parent = category_map.get(category.parent_id) if category is not None else None
    return {
        "id": row.provider_transaction_id,
        "date": row.date,
        "payee_name": resolved.get("payee_name") or raw.get("merchant_name") or raw.get("name") or None,
        "description": row.description,
        "amount_cents": row.amount_cents,
        "pending": row.pending,
        "memo": "",
        "flag": None,
        "category_name": (
            f"{parent.name}: {category.name}"
            if parent is not None and category is not None
            else None
        ),
        "source": "plaid",
    }


def _matches_filter(row: dict, text: str | None, date_value: str | None, amount: int | None) -> bool:
    if date_value and str(row["date"]) != date_value:
        return False
    if amount is not None and row["amount_cents"] != amount:
        return False
    if text:
        needle = text.casefold()
        return needle in " ".join(str(row.get(key) or "") for key in ("payee_name", "description")).casefold()
    return True


def review(
    db: Session,
    attempt_id: str,
    bucket: str = "ready",
    *,
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
) -> dict:
    if bucket not in REVIEW_BUCKETS:
        raise AppError("conversion_bucket_invalid", "Choose a valid review bucket.", 422)
    attempt = _attempt(db, attempt_id)
    state = _proposal_state(db, attempt)
    rows = _review_rows(state)
    projection = state["projection"]
    feed_by_id = {row.provider_transaction_id: row for row in state["feed"]}
    history_by_id = {row.id: row for row in state["history"]}

    def feed_row(row: AccountConversionRow, extra: bool = False) -> dict:
        return state["feed_rows"][row.provider_transaction_id] | rows["feed"][row.provider_transaction_id] | {"extra": extra}

    def history_row(row: Transaction, extra: bool = False) -> dict:
        return projection[row.id][2] | rows["history"][row.id] | {"extra": extra}

    feed_candidates = [edge for edge in state["edges"] if selected_feed_id in feed_by_id and edge["feed_id"] == selected_feed_id]
    history_candidates = [edge for edge in state["edges"] if selected_history_id in history_by_id and edge["history_id"] == selected_history_id]
    accepted_keys = {edge["key"] for edge in state["accepted"]}
    selected_edge = next((edge for edge in feed_candidates if edge["history_id"] == selected_history_id), None)
    if selected_edge is None:
        pool = feed_candidates or history_candidates
        selected_edge = (
            next((edge for edge in pool if edge["key"] in accepted_keys), None)
            or next((edge for edge in pool if not edge["blocking_reason"]), None)
            or next(iter(pool), None)
        )
    visible_feed = [
        feed_row(row) for row in state["feed"]
        if rows["feed"][row.provider_transaction_id]["review_bucket"] == bucket
    ]
    visible_feed = [row for row in visible_feed if _matches_filter(row, feed_text, feed_date, feed_amount)]
    visible_history = [
        row for row in state["history"]
        if rows["history"][row.id]["review_bucket"] == bucket
    ]
    visible_history = [row for row in visible_history if _matches_filter(projection[row.id][2], history_text, history_date, history_amount)]
    visible_feed.sort(key=lambda row: ledger_projection.chronology_key(row["date"], row["amount_cents"], feed_by_id[row["id"]].id, row["source"]))
    visible_history.sort(key=lambda row: ledger_projection.chronology_key(projection[row.id][2]["date"], projection[row.id][2]["amount_cents"], row.id, row.source))
    feed_page, next_feed_cursor = _page(visible_feed, feed_cursor, 50)
    history_page, next_history_cursor = _page(visible_history, history_cursor, 50)
    shown_feed = {row["id"] for row in feed_page}
    shown_history = {row.id for row in history_page}
    history_details = shown_history | {edge["history_id"] for edge in feed_candidates}
    if selected_edge is not None:
        history_details.add(selected_edge["history_id"])
    shown = [projection[identifier][2] for identifier in history_details]
    ledger_projection.fill_tokens(db, projection, shown, lookups=state["lookups"])
    history_page = [history_row(row) for row in history_page]
    feed_extras = [feed_row(feed_by_id[edge["feed_id"]], True) for edge in history_candidates if edge["feed_id"] not in shown_feed]
    history_extras = [history_row(history_by_id[edge["history_id"]], True) for edge in feed_candidates if edge["history_id"] not in shown_history]
    comparison = None
    if selected_edge is not None:
        selected_feed_id, selected_history_id = selected_edge["feed_id"], selected_edge["history_id"]
        history = history_by_id[selected_history_id]
        comparison = {
            "edge": selected_edge,
            "feed": state["feed_rows"][selected_feed_id],
            "history": projection[history.id][2] | {
                "description": matching.history_comparison_description(history, state["active_matches"].get(history.id)),
            },
            "feed_matched_history_id": rows["feed"][selected_feed_id]["matched_history_id"],
            "history_matched_feed_id": rows["history"][selected_history_id]["matched_feed_id"],
            "choices": (selected_edge["decision"] or {}).get("choices") or _edge_choices(selected_edge, state["effective_facts"][history.id]),
            "rationale": (
                "This is the same bank transaction already in your history. It will be updated in place."
                if selected_edge["returning"]
                else "Exact amount; same date."
                if selected_edge["distance"] == 0
                else f"Exact amount; dates are {selected_edge['distance']} day{'s' if selected_edge['distance'] != 1 else ''} apart."
            ),
        }
    return {
        "attempt": summary(db, attempt, state, rows),
        "feed": {"rows": feed_page + feed_extras, "total_count": len(visible_feed), "next_cursor": next_feed_cursor},
        "history": {"rows": history_page + history_extras, "total_count": len(visible_history), "next_cursor": next_history_cursor},
        "selected_feed_id": selected_feed_id,
        "selected_history_id": selected_history_id,
        "feed_candidate_ids": [edge["history_id"] for edge in feed_candidates],
        "history_candidate_ids": [edge["feed_id"] for edge in history_candidates],
        "comparison": comparison,
    }


def decide(db: Session, attempt_id: str, feed_id: str, history_id: int, state: str, choices: dict | None = None) -> dict:
    attempt = _attempt(db, attempt_id)
    proposals = _proposal_state(db, attempt)
    edge = next((row for row in proposals["edges"] if row["feed_id"] == feed_id and row["history_id"] == history_id), None)
    if edge is None:
        raise AppError("conversion_pair_invalid", "That pair is no longer an eligible exact-amount choice.", 409)
    if edge["returning"]:
        raise AppError("conversion_bank_identity_fixed", "This bank transaction is already in the account and cannot be split into a duplicate.", 422)
    if state not in ("accepted", "separate", "unresolved"):
        raise AppError("conversion_decision_invalid", "Choose to use this match or keep the entries separately.", 422)
    if state == "accepted" and edge["blocking_reason"]:
        raise AppError("conversion_pair_blocked", edge["blocking_reason"], 422)
    if choices is not None and (
        set(choices) != set(ledger_projection.SOURCE_FIELDS)
        or any(value not in ("feed", "history") for value in choices.values())
    ):
        raise AppError("conversion_field_source_invalid", "Choose bank or history for every editable field.", 422)
    decisions = dict(attempt.decisions or {})
    default_choices = _edge_choices(edge, proposals["effective_facts"][history_id])
    if state == "accepted" and edge["fixed_owner"] is not None:
        selected_choices = choices or default_choices
        if (
            selected_choices["transfer_source"] != edge["fixed_owner"]
        ):
            raise AppError("conversion_transfer_fields_fixed", "Transfer target choice is fixed.", 422)
    if state == "unresolved":
        decisions[edge["key"]] = {
            "state": "unresolved",
            "bucket": edge["bucket"],
            "choices": default_choices,
            "decision_token": edge["decision_token"],
        }
    else:
        if state == "accepted":
            for other in proposals["edges"]:
                current = decisions.get(other["key"])
                if (
                    other["key"] != edge["key"]
                    and current
                    and current.get("state") == "accepted"
                    and (
                        other["feed_id"] == edge["feed_id"]
                        or other["history_id"] == edge["history_id"]
                    )
                ):
                    current = dict(current)
                    current["state"] = "unresolved"
                    decisions[other["key"]] = current
        decisions[edge["key"]] = {
            "state": state,
            "bucket": edge["bucket"],
            "choices": choices or default_choices,
            "decision_token": edge["decision_token"],
        }
    attempt.decisions, attempt.updated_at = decisions, datetime.now()
    db.flush()
    return summary(db, attempt)


def set_ready(db: Session, attempt_id: str, accepted: bool) -> dict:
    attempt = _attempt(db, attempt_id)
    state = _proposal_state(db, attempt)
    decisions = dict(attempt.decisions or {})
    if accepted:
        ready_keys = {edge["key"] for edge in state["ready"]}
        ready_feed = {edge["feed_id"] for edge in state["ready"]}
        ready_history = {edge["history_id"] for edge in state["ready"]}
        for edge in state["accepted"]:
            if edge["key"] not in ready_keys and (edge["feed_id"] in ready_feed or edge["history_id"] in ready_history):
                decisions[edge["key"]] = dict(decisions[edge["key"]]) | {"state": "unresolved"}
    for edge in state["ready"]:
        if edge["returning"]:
            continue
        default_choices = _edge_choices(edge, state["effective_facts"][edge["history_id"]])
        if accepted:
            decisions[edge["key"]] = {
                "state": "accepted",
                "bucket": "ready",
                "choices": default_choices,
                "decision_token": edge["decision_token"],
            }
        else:
            decisions[edge["key"]] = {
                "state": "unresolved",
                "bucket": "ready",
                "choices": default_choices,
                "decision_token": edge["decision_token"],
            }
    attempt.decisions, attempt.updated_at = decisions, datetime.now()
    db.flush()
    return summary(db, attempt)


def review_new(db: Session, attempt_id: str, reviewed: bool) -> dict:
    attempt = _attempt(db, attempt_id)
    attempt.review_all_new, attempt.updated_at = reviewed, datetime.now()
    db.flush()
    return summary(db, attempt)


def commit(
    db: Session,
    attempt_id: str,
    preview_token: str,
    acknowledge_late_history: bool = False,
    acknowledge_pending_overlap: bool = False,
    stale_detail: dict | None = None,
) -> dict:
    try:
        db.rollback()
        ledger_history.reserve_write(db)
        attempt = _attempt(db, attempt_id)
        resolver = payees.load_evaluator(db)
        state = _proposal_state(db, attempt, resolver)
        proposed = _preview_from_state(db, attempt, state)
        if preview_token != proposed["preview_token"]:
            raise AppError(
                "conversion_preview_stale",
                "The connection review changed. Refresh the preview before connecting.",
                409,
                stale_detail or None,
            )
        if not proposed["can_commit"]:
            raise AppError("conversion_not_ready", "Resolve every posted possible duplicate and provide a current bank balance before connecting.", 422)
        if proposed["pending_candidate_count"] and not acknowledge_pending_overlap:
            raise AppError("conversion_pending_overlap_acknowledgement_required", "Acknowledge the undecided pending overlap before connecting.", 422)
        account = _target(db, attempt.account_id)
        item = db.get(PlaidItem, attempt.plaid_item_id)
        if item is None:
            raise AppError("conversion_item_missing", "The staged bank connection is unavailable.", 409)
        shared_item = _shared_item(db, item.id)
        if shared_item and not acknowledge_late_history:
            raise AppError(
                "conversion_late_history_acknowledgement_required",
                "Acknowledge that older bank transactions may arrive later before connecting this shared bank login.",
                422,
            )
        if shared_item:
            if db.scalar(
                select(PlaidAccountLink.id).where(
                    PlaidAccountLink.plaid_item_id == item.id,
                    PlaidAccountLink.plaid_account_id == attempt.plaid_account_id,
                )
            ) is not None:
                raise AppError("conversion_provider_account_mapped", "That bank account is already connected to Weft.", 409)
        _preflight_staged_identities(db, attempt)
        for row in db.scalars(
            select(Transaction).where(
                Transaction.account_id == account.id,
                Transaction.source != "starting_balance",
            )
        ).all():
            row.feed_historical_at = datetime.now()
        created: dict[str, Transaction] = {}
        review_rows = _review_rows(state)["feed"]
        returning_order = sorted(state["feed"], key=lambda staged: (
            (identity := state["identities"].get(staged.provider_transaction_id)) is not None
            and (relation := ledger_projection.active_match_for(db, identity)) is not None
            and relation.history_transaction_id == identity.id
        ))
        for staged in returning_order:
            existing = state["identities"].get(staged.provider_transaction_id)
            if existing is not None:
                reconnect_plaid_row(db, existing, staged.raw, replacement=state["returning_replacements"].get(staged.provider_transaction_id))
                live = existing
            else:
                live = create_plaid_row(db, staged.raw, account.id, resolver)
            outcome = review_rows[staged.provider_transaction_id]
            if attempt.review_all_new and outcome["review_bucket"] == "new" and outcome["review_status"] == "new":
                live.approved = True
            created[staged.provider_transaction_id] = live
        for edge in state["edges"]:
            decision = edge["decision"]
            if decision is None or decision.get("state") not in ("accepted", "separate"):
                continue
            bank = created.get(edge["feed_id"])
            history = db.get(Transaction, edge["history_id"])
            if bank is None or history is None:
                raise AppError("conversion_decision_stale", "A selected history row changed. Refresh the review.", 409)
            if edge["returning"]:
                continue
            if decision.get("state") == "separate":
                dismissed = db.scalar(
                    select(TransactionMatch).where(
                        TransactionMatch.feed_transaction_id == bank.id,
                        TransactionMatch.history_transaction_id == history.id,
                    )
                )
                if dismissed is None:
                    dismissed = TransactionMatch(
                        feed_transaction_id=bank.id,
                        history_transaction_id=history.id,
                    )
                    db.add(dismissed)
                dismissed.state = "dismissed"
                dismissed.matched_by = None
                continue
            choices = decision.get("choices") or _edge_choices(edge, ledger_projection.effective_facts(db, history))
            if edge["fixed_owner"] is not None and (
                choices.get("transfer_source") != edge["fixed_owner"]
            ):
                raise AppError("conversion_transfer_fields_fixed", "Transfer target changed. Refresh the review.", 409)
            rehomed_transfer = history.transfer_partner_id is not None and ledger_projection.active_match_for(db, history) is not None
            matching.apply_match(db, bank, history, choices)
            bank.approved = history.approved
            if rehomed_transfer:
                ledger.materialize_transfer_completion(
                    db, bank, state["effective_facts"][history.id]["transfer_account_id"]
                )
        baseline = db.scalar(select(Transaction).where(Transaction.account_id == account.id, Transaction.source == "starting_balance"))
        baseline_date = proposed["starting_balance_date"]
        if baseline is None:
            baseline = Transaction(account_id=account.id, date=baseline_date, description="Starting Balance", amount_cents=0, status="cleared", approved=True, source="starting_balance", payee_id=payees.system_payee(db, "starting_balance").id)
            db.add(baseline)
            db.flush()
        baseline.date, baseline.amount_cents, baseline.status, baseline.approved = baseline_date, proposed["starting_balance_cents"], "cleared", True
        link = PlaidAccountLink(plaid_item_id=item.id, plaid_account_id=attempt.plaid_account_id, account_id=account.id)
        db.add(link)
        db.flush()
        reported_balances.record(db, account, link, attempt.provider_account.get("balances") or {}, attempt.balance_fetched_at)
        account.plaid_current_balance_cents, account.plaid_available_balance_cents, account.plaid_limit_cents = attempt.current_balance_cents, attempt.available_balance_cents, attempt.limit_cents
        account.plaid_balance_iso_currency_code, account.plaid_balance_updated_at = attempt.currency_code, attempt.balance_fetched_at
        connected_at = datetime.now()
        account.plaid_history_imported_at = attempt.history_complete_at or connected_at
        account.starting_balance_initialized_at = connected_at
        db.delete(attempt)
        db.commit()
        return {"status": "connected", "account_id": account.id}
    except Exception:
        db.rollback()
        raise


def abandon(db: Session, attempt_id: str, client, secret: str) -> dict:
    attempt = _attempt(db, attempt_id)
    item = db.get(PlaidItem, attempt.plaid_item_id)
    shared_item = item is not None and _shared_item(db, item.id)
    if item is not None and not shared_item:
        client.remove_item(decrypt_access_token(secret, item.access_token_enc))
    db.delete(attempt)
    if item is not None and not shared_item:
        db.delete(item)
    db.commit()
    return {"status": "abandoned"}


def disconnect(db: Session, account_id: int, freeze_pending: bool, client_factory, secret: str) -> dict:
    return _disconnect(
        db,
        account_id,
        freeze_pending,
        revoke_item=lambda link: accounts.revoke_last_mapping_item(
            db, link, client_factory, secret
        ),
    )


def close(db: Session, account_id: int, client_factory, secret: str, preview_token: str) -> Account:
    _disconnect(
        db,
        account_id,
        True,
        revoke_item=lambda link: accounts.revoke_last_mapping_item(
            db, link, client_factory, secret
        ),
        close_account=True,
        preview_token=preview_token,
    )
    account = db.get(Account, account_id)
    if account is None:
        raise AppError("account_not_found", "Account not found", 404)
    return account


def _last_unreadable_item(db: Session, link: PlaidAccountLink, secret: str) -> PlaidItem:
    if db.scalar(
        select(PlaidAccountLink.id).where(
            PlaidAccountLink.plaid_item_id == link.plaid_item_id,
            PlaidAccountLink.id != link.id,
        )
    ) is not None:
        raise AppError(
            "disconnect_local_only_shared_item",
            "This bank connection is shared. Use ordinary disconnect for this account.",
            409,
        )
    attempt = db.scalar(
        select(AccountConversionAttempt).where(
            AccountConversionAttempt.plaid_item_id == link.plaid_item_id
        )
    )
    if attempt is not None:
        raise AppError(
            "bank_feed_conversion_staged",
            "Abandon the staged bank connection before removing the last local connection.",
            409,
        )
    item = db.get(PlaidItem, link.plaid_item_id)
    if item is None:
        raise AppError("bank_feed_not_found", "This account does not have an active bank feed.", 404)
    try:
        decrypt_access_token(secret, item.access_token_enc)
    except AppError as error:
        if error.code == "plaid_local_token_unreadable":
            return item
        raise
    raise AppError(
        "disconnect_local_only_token_readable",
        "Weft can still revoke this bank connection. Use ordinary disconnect.",
        409,
    )


def disconnect_locally(
    db: Session, account_id: int, freeze_pending: bool, secret: str
) -> dict:
    return _disconnect(
        db,
        account_id,
        freeze_pending,
        revoke_item=lambda link: _last_unreadable_item(db, link, secret),
    )


def _disconnect(
    db: Session,
    account_id: int,
    freeze_pending: bool,
    revoke_item,
    *,
    close_account: bool = False,
    preview_token: str | None = None,
) -> dict:
    ledger_history.reserve_write(db)
    try:
        account = accounts.verify_close_preview(db, account_id, preview_token) if close_account else db.get(Account, account_id)
        link = db.scalar(select(PlaidAccountLink).where(PlaidAccountLink.account_id == account_id))
        if account is None:
            raise AppError("account_not_found", "Account not found", 404)
        if close_account and link is None:
            account.closed = True
            db.commit()
            return {"status": "closed"}
        if link is None:
            raise AppError("bank_feed_not_found", "This account does not have an active bank feed.", 404)
        active_rows = db.scalars(
            select(Transaction).where(
                Transaction.account_id == account_id,
                Transaction.source == "plaid",
                Transaction.feed_historical_at.is_(None),
            )
        ).all()
        active_pending = [
            row for row in active_rows
            if row.status == "pending" and row.plaid_removed_at is None
        ]
        if not close_account and any(ledger_projection.missing_pending(row) for row in active_rows):
            raise AppError("disconnect_missing_pending", "Resolve missing pending transactions before disconnecting the bank.", 422)
        if active_pending and not freeze_pending:
            raise AppError("disconnect_pending_confirmation", "Choose how pending bank transactions should be frozen before disconnecting.", 422)
        item = revoke_item(link)
        now = datetime.now()
        for row in db.scalars(
            select(Transaction).where(
                Transaction.account_id == account_id,
                Transaction.source != "starting_balance",
            )
        ).all():
            row.feed_historical_at = now
        for row in active_pending:
            row.provider_lifecycle_detached_at = now
            row.status = "cleared" if row.manually_cleared else "uncleared"
            row.manually_cleared = False
        for relation in db.scalars(
            select(TransactionMatch)
            .join(Transaction, Transaction.id == TransactionMatch.feed_transaction_id)
            .where(
                Transaction.account_id == account_id,
                TransactionMatch.state == "suggested",
            )
        ).all():
            db.delete(relation)
        account.plaid_current_balance_cents = account.plaid_available_balance_cents = account.plaid_limit_cents = account.plaid_balance_iso_currency_code = account.plaid_balance_updated_at = None
        db.delete(link)
        if item is not None:
            db.delete(item)
        if close_account:
            account.closed = True
        db.commit()
        return {"status": "closed" if close_account else "disconnected"}
    except Exception:
        db.rollback()
        raise


def connect_new_accounts(
    db: Session,
    public_token: str,
    institution: str,
    institution_id: str | None,
    selected_accounts: dict[str, AccountCreate],
    client_factory,
    secret: str,
    mark_terminal_commit,
) -> dict:
    names = [account.name for account in selected_accounts.values()]
    try:
        accounts.check_names_available(db, names)
        db.rollback()
        client = client_factory()
        item_id, access_token = client.exchange_public_token(public_token)
        item = PlaidItem(
            item_id=item_id,
            **client.identity,
            access_token_enc=encrypt_access_token(
                secret, access_token
            ),
            institution=institution,
            institution_id=institution_id,
        )
        try:
            provider_accounts = {account["account_id"]: account for account in client.accounts(access_token)}
            balance_received_at = datetime.now()
            provider_ids = set(provider_accounts)
            if not set(selected_accounts).issubset(provider_ids):
                raise AppError(
                    "plaid_account_selection_invalid",
                    "Plaid returned a different account list. No local accounts were created.",
                    422,
                )
            refresh_item_institution(item, client, access_token, institution_id)

            accounts.reserve_names(db, names)
            db.add(item)
            db.flush()
            for plaid_account_id, local_account in selected_accounts.items():
                account = accounts.create_record(db, local_account)
                link = PlaidAccountLink(
                    plaid_item_id=item.id,
                    plaid_account_id=plaid_account_id,
                    account_id=account.id,
                )
                db.add(link)
                db.flush()
                reported_balances.record(db, account, link, provider_accounts[plaid_account_id].get("balances") or {}, balance_received_at)
            mark_terminal_commit()
            db.commit()
            return {"status": "connected"}
        except Exception as original_error:
            db.rollback()
            if not _revoke_unused_item(db, client, secret, access_token, item):
                raise AppError(
                    "plaid_item_revoke_failed",
                    "Plaid could not revoke the unused connection. Weft retained it for cleanup; retry after cleanup succeeds.",
                    424,
                ) from original_error
            raise
    except Exception:
        db.rollback()
        raise


def repair_link_token(db: Session, account_id: int, client_factory, secret: str) -> str:
    link = db.scalar(
        select(PlaidAccountLink).where(PlaidAccountLink.account_id == account_id)
    )
    if link is None:
        raise AppError("bank_feed_not_found", "This account does not have an active bank feed.", 404)
    item = db.get(PlaidItem, link.plaid_item_id)
    if item is None:
        raise AppError("bank_feed_not_found", "This account does not have an active bank feed.", 404)
    token = decrypt_access_token(secret, item.access_token_enc)
    db.rollback()
    return client_factory().create_update_link_token(token)


def new_link_token(db: Session, client, secret: str) -> str:
    cleanup_orphaned_items(db, client, secret)
    db.rollback()
    return client.create_link_token()
