import hashlib
import json
from collections import Counter
from datetime import timedelta
from itertools import batched

from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.db import SQL_ID_BATCH_SIZE
from app.models import Account, AutomaticTransferLink, Category, Payee, Transaction, TransactionAllocation, TransactionMatch, BankContinuity
from app.schemas import TransferDraft, TransferReviewProposal
from app.services import (
    candidate_paging,
    categories,
    payee_identity,
    payees,
    ledger,
    ledger_projection,
    transfer_links,
)
from app.services import transaction_matching as matching
from app.services.ledger_history import record_lifecycle


def _visible(db: Session, transaction: Transaction) -> bool:
    parent = ledger_projection.resolve_relationship(db, transaction).parent
    return parent is not None and parent.id == transaction.id


def _anchor(db: Session, transaction: Transaction) -> Transaction:
    return ledger_projection.transfer_anchor(db, transaction)


def _facts(db: Session, transaction: Transaction) -> dict:
    effective = ledger_projection.effective_facts(db, transaction)
    facts = ledger_projection.relationship_facts(db, transaction, effective)
    partner_id = facts["transfer"]["partner_id"]
    partner = db.get(Transaction, partner_id) if partner_id else None
    relation = facts["relation"]
    partner_parent = ledger_projection.resolve_relationship(db, partner).parent if partner else None
    effective_partner = partner_parent or partner
    partner_effective = ledger_projection.effective_facts(db, effective_partner) if effective_partner else None
    partner_facts = ledger_projection.relationship_facts(db, effective_partner, partner_effective) if effective_partner else None
    partner_relation = partner_facts["relation"] if partner_facts else None
    return {
        "id": transaction.id,
        "account_id": transaction.account_id,
        "date": transaction.date,
        "description": transaction.description,
        "amount_cents": transaction.amount_cents,
        "status": transaction.status,
        "manually_cleared": transaction.manually_cleared,
        "approved": transaction.approved,
        "source": transaction.source,
        "payee_id": facts["effective"]["payee_id"],
        "transfer_account_id": facts["effective"]["transfer_account_id"],
        "memo": facts["effective"]["memo"],
        "flag": facts["effective"]["flag"],
        "transfer_partner_id": transaction.transfer_partner_id,
        "anchor_id": facts["transfer"]["anchor_id"],
        "anchor_partner_id": partner_id,
        "destination": facts["transfer"]["destination"],
        "category": facts["effective"]["category"],
        "owners": {key: facts["owners"][key] for key in effective["owners"]},
        "owner_values": {
            owner.id: (owner.payee_id, owner.transfer_account_id, owner.category_id, owner.category_assigned, owner.memo, owner.flag, owner.transfer_partner_id)
            for owner in effective["owners"].values()
        },
        "match": (
            relation["id"],
            relation["state"],
            relation["matched_by"],
            relation["payee_source"],
            relation["transfer_source"],
            relation["description_source"],
            relation["category_source"],
            relation["memo_source"],
            relation["flag_source"],
        ) if relation else None,
        "partner": (
            {
                "row": {
                    field: getattr(partner, field)
                    for field in ("id", "account_id", "date", "description", "amount_cents", "status", "manually_cleared", "approved", "payee_id", "transfer_account_id", "category_id", "category_assigned", "memo", "flag", "transfer_partner_id")
                },
                "visible_parent": (
                    tuple(getattr(partner_parent, field) for field in (
                        "id", "account_id", "date", "description", "amount_cents",
                        "status", "manually_cleared", "approved",
                    ))
                    if partner_parent else None
                ),
                "effective": {
                    "payee_id": partner_facts["effective"]["payee_id"],
                    "transfer_account_id": partner_facts["effective"]["transfer_account_id"],
                    "category": partner_facts["effective"]["category"],
                    "memo": partner_facts["effective"]["memo"],
                    "flag": partner_facts["effective"]["flag"],
                    "owners": {name: partner_facts["owners"][name] for name in partner_effective["owners"]},
                },
                "match": (
                    partner_relation["id"],
                    partner_relation["state"],
                    partner_relation["matched_by"],
                    partner_relation["feed_transaction_id"],
                    partner_relation["history_transaction_id"],
                    partner_relation["payee_source"],
                    partner_relation["transfer_source"],
                    partner_relation["description_source"],
                    partner_relation["category_source"],
                    partner_relation["memo_source"],
                    partner_relation["flag_source"],
                ) if partner_relation else None,
            }
        ) if partner else None,
        "missing_pending": ledger_projection.missing_pending(transaction),
    }


def _token(db: Session, source: Transaction, candidate: Transaction | None) -> str:
    value = {
        "source": _facts(db, source),
        "candidate": _facts(db, candidate) if candidate else None,
    }
    return hashlib.sha256(json.dumps(value, default=str, sort_keys=True).encode()).hexdigest()


def relationship_label(transaction, now=None):
    if transaction.source == "manual":
        return "Manual"
    if ledger_projection.missing_pending(transaction, now):
        return "Pending?"
    if transaction.status == "pending" and transaction.manually_cleared:
        return "Cleared*"
    return transaction.status.capitalize()


def inspect_relationship(db: Session, source: Transaction) -> dict | None:
    anchor = _anchor(db, source)
    if anchor.transfer_partner_id is None:
        return None
    partner = db.get(Transaction, anchor.transfer_partner_id)
    if partner is None or partner.transfer_partner_id != anchor.id:
        return None
    visible_partner = ledger_projection.resolve_relationship(db, partner).parent
    account = db.get(Account, partner.account_id)
    automatic = ledger_projection.active_automatic_transfer(db, anchor)
    return {
        "partner": ledger_projection.row(db, visible_partner) if visible_partner else None,
        "account_name": account.name,
        "anchor_id": anchor.id,
        "unavailable_reason": None if visible_partner else "The linked bank transaction is no longer visible. You can unlink the retained connection.",
        "action": {
            "kind": "transfer", "id": source.id,
            "source_id": anchor.id, "target_id": partner.id,
            "source_label": relationship_label(anchor), "target_label": "Transfer",
            "context_token": _token(db, source, None),
            "evidence": "Automatically linked transfer." if automatic else "You linked these transfer transactions.",
            "consequence": (
                "This disconnects the two accounts' entries and blocks automatic relinking. Unchanged automatic transfer targets are restored; later edits are kept and may need review. Neither entry is deleted."
                if automatic else "This disconnects the two accounts' entries and blocks automatic relinking. Both entries and their saved fields remain."
            ),
        },
    }


def _destination(db: Session, source: Transaction) -> Account:
    facts = ledger_projection.effective_facts(db, source)
    if facts["category"]["allocations"]:
        raise AppError("transfer_split_not_allowed", "Transfers must be whole transactions.", 422)
    destination = payee_identity.target(db, facts["transfer_account_id"])
    if destination is None:
        raise AppError("transfer_not_classified", "Choose a transfer account first.", 422)
    return destination


def _destination_out(db: Session, destination: Account) -> dict:
    return {"id": destination.id, "name": destination.name, "type": destination.type,
            "closed": destination.closed}


def _require_available_source(db: Session, source: Transaction) -> None:
    ledger_projection.require_account_initialized(db, source.account_id)
    if not _visible(db, source):
        raise AppError("transfer_source_not_available", "This transaction is no longer visible.", 422)
    if source.source == "starting_balance":
        raise AppError("transfer_source_not_available", "Starting balances cannot be transfers.", 422)
    if ledger_projection.missing_pending(source):
        raise AppError("transfer_source_not_available", "Resolve the missing pending transaction first.", 422)


def _validate_source(db: Session, source: Transaction) -> Account:
    _require_available_source(db, source)
    if source.amount_cents == 0:
        raise AppError("transfer_source_not_available", "Choose a nonzero transaction.", 422)
    destination = _destination(db, source)
    ledger_projection.require_account_initialized(db, destination.id)
    if destination.id == source.account_id:
        raise AppError("transfer_self_not_allowed", "A transfer cannot target its own account.", 422)
    return destination


def _validate_review_source(db: Session, source: Transaction):
    _require_available_source(db, source)
    relation = ledger_projection.resolve_relationship(db, source).relation
    projected = ledger_projection.row(db, source)
    if _anchor(db, source).transfer_partner_id is not None:
        raise AppError(
            "transfer_already_linked",
            "Unlink the existing transfer before linking another transaction.",
            409,
        )
    return relation, projected


def _candidate_ok(db: Session, source: Transaction, candidate: Transaction, destination: Account) -> None:
    ledger_projection.require_account_initialized(db, source.account_id)
    ledger_projection.require_account_initialized(db, candidate.account_id)
    if candidate.id == source.id or candidate.account_id != destination.id or not _visible(db, candidate):
        raise AppError("transfer_candidate_not_available", "Choose a visible transaction in the destination account.", 422)
    if candidate.amount_cents != -source.amount_cents or candidate.amount_cents == 0:
        raise AppError("transfer_candidate_amount", "The transfer amount must be exactly opposite.", 422)
    if candidate.source == "starting_balance" or ledger_projection.missing_pending(candidate):
        raise AppError("transfer_candidate_not_available", "That transaction cannot be linked.", 422)
    facts = ledger_projection.effective_facts(db, candidate)
    if facts["category"]["allocations"]:
        raise AppError("transfer_candidate_split", "Split transactions cannot be linked as transfers.", 422)
    target = payee_identity.target(db, facts["transfer_account_id"])
    if target is not None and target.id != source.account_id:
        raise AppError("transfer_target_conflict", "The candidate already targets a different account.", 409)
    if _anchor(db, source).transfer_partner_id is not None or _anchor(db, candidate).transfer_partner_id is not None:
        raise AppError("transfer_already_linked", "Unlink the existing transfer before linking another transaction.", 409)


def _candidate_row_ok(source: Transaction, row: dict, destination: Account) -> bool:
    if row["id"] == source.id or row["account_id"] != destination.id:
        return False
    if row["amount_cents"] != -source.amount_cents or row["amount_cents"] == 0:
        return False
    if row["source"] == "starting_balance" or row["missing_pending"] or row["allocations"]:
        return False
    transfer = row["transfer"]
    return transfer is None or (
        transfer["state"] == "unlinked" and transfer["account_id"] == source.account_id
    )


def _candidate_out(row: dict, account: Account) -> dict:
    return {**row, "account_name": account.name}


def _selected_candidate(candidates: list[tuple], selected: Transaction | None, cursor: str | None) -> Transaction | None:
    if selected is not None or cursor is not None or not candidates:
        return selected
    nearest_distance = candidates[0][0]
    if sum(distance == nearest_distance for distance, *_ in candidates) == 1:
        return candidates[0][-1]
    return None


def _context_rows(
    db: Session,
    source: Transaction,
    scope: str,
    selected_id: int | None,
    cursor: str | None,
    *,
    destination: Account | None = None,
    proposal=None,
    candidate_source: Transaction | None = None,
) -> dict:
    if _anchor(db, source).transfer_partner_id is not None:
        raise AppError("transfer_already_linked", "This transaction is now linked. Use Inspect connections from the transaction menu to view the link.", 409)
    destination = destination or _validate_source(db, source)
    candidate_source = candidate_source or source
    selected = db.get(Transaction, selected_id) if selected_id is not None else None
    if selected_id is not None and selected is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    if selected is not None:
        _candidate_ok(db, candidate_source, selected, destination)
    projection = ledger_projection.parent_projection(db, {destination.id})
    candidates = []
    for candidate, _relationship, row in projection.values():
        if not _candidate_row_ok(candidate_source, row, destination):
            continue
        distance = abs((candidate.date - candidate_source.date).days)
        if scope == "nearby" and distance > 7:
            continue
        candidates.append((distance, candidate.date.isoformat(), candidate.id, row, candidate))
    candidates.sort(key=lambda item: item[:3])
    selected = _selected_candidate(candidates, selected, cursor)
    after = candidate_paging.decode(cursor, source_id=source.id, destination_id=destination.id, scope=scope, kind="transfer") if cursor else None
    if after is not None:
        candidates = [item for item in candidates if item[:3] > after]
    page = candidates[:50]
    shown = [item[3] for item in page]
    ledger_projection.fill_tokens(db, projection, shown)
    source_row = ledger_projection.row(db, source)
    counterpart_payee_id = _counterpart_payee_id(
        db, source.account_id, destination.id,
        proposal.draft.amount_cents if proposal else source.amount_cents,
        proposal.draft.date if proposal else source.date,
        proposal.payee_id if proposal else source_row["payee_id"],
    )
    return {
        "source": source_row,
        "draft": _draft_preview(db, proposal, source.description, ledger_projection.effective_facts(db, source)["category"]["category_id"]) if proposal is not None else None,
        "destination": _destination_out(db, destination),
        "candidates": [_candidate_out(item[3], destination) for item in page],
        "candidate": _candidate_out(ledger_projection.row(db, selected), destination) if selected else None,
        "scope": scope,
        "next_cursor": candidate_paging.encode(page[-1][:3], source_id=source.id, destination_id=destination.id, scope=scope, kind="transfer") if len(candidates) > len(page) else None,
        "context_token": (
            _review_token(db, source, selected, proposal, destination)
            if proposal is not None
            else _token(db, source, selected)
        ),
        "allowed_actions": (
            ["link", "create_counterpart", "save_unlinked"]
            if proposal is not None
            else ["link", "create_counterpart"]
        ),
        "proposal": proposal,
        "proposal_payee_name": db.get(Payee, proposal.payee_id).name if proposal else None,
        "counterpart_payee_id": counterpart_payee_id,
        "search_all_accounts": False,
        "counterpart_destinations": [],
    }


def context(db: Session, source_id: int, scope: str, candidate_id: int | None, cursor: str | None) -> dict:
    source = db.get(Transaction, source_id)
    if source is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    if scope not in ("nearby", "all"):
        raise AppError("transfer_scope_invalid", "Choose nearby or all transactions.", 422)
    facts = ledger_projection.effective_facts(db, source)
    if payee_identity.target(db, facts["transfer_account_id"]) is not None:
        return _context_rows(db, source, scope, candidate_id, cursor)
    if cursor is not None:
        raise AppError("transfer_cursor_invalid", "Choose an account before loading more transfer candidates.", 422)
    _require_available_source(db, source)
    if source.amount_cents == 0:
        raise AppError("transfer_source_not_available", "Choose a nonzero transaction.", 422)
    if facts["category"]["allocations"]:
        raise AppError("transfer_split_not_allowed", "Transfers must be whole transactions.", 422)
    if _anchor(db, source).transfer_partner_id is not None:
        raise AppError("transfer_already_linked", "Unlink the existing transfer before linking another transaction.", 409)
    projection = ledger_projection.parent_projection(db, None)
    accounts = {
        account.id: account
        for account in db.scalars(select(Account).where(Account.id != source.account_id)).all()
    }
    counterpart_destinations = [
        _destination_out(db, account)
        for account in sorted(accounts.values(), key=lambda item: (item.sort_order, item.id))
        if not account.closed and not ledger_projection.account_requires_initialization(db, account.id)
    ]
    candidates = []
    for candidate, _relationship, row in projection.values():
        account = accounts.get(candidate.account_id)
        if account is None or account.closed or ledger_projection.account_requires_initialization(db, account.id) or not _candidate_row_ok(source, row, account):
            continue
        distance = abs((candidate.date - source.date).days)
        if scope == "nearby" and distance > 7:
            continue
        candidates.append((distance, candidate.date.isoformat(), candidate.id, row, account, candidate))
    candidates.sort(key=lambda item: item[:3])
    selected = db.get(Transaction, candidate_id) if candidate_id is not None else None
    if candidate_id is not None and selected is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    if selected is not None:
        destination = accounts.get(selected.account_id)
        if destination is None or destination.closed or ledger_projection.account_requires_initialization(db, destination.id):
            raise AppError("transfer_candidate_not_available", "Choose a visible transaction in another account.", 422)
        _candidate_ok(db, source, selected, destination)
    selected = _selected_candidate(candidates, selected, cursor)
    shown = [item[3] for item in candidates]
    ledger_projection.fill_tokens(db, projection, shown)
    selected_destination = accounts[selected.account_id] if selected else None
    source_row = ledger_projection.row(db, source)
    proposal = (
        TransferReviewProposal(
            payee_id=source_row["payee_id"],
            transfer_account_id=selected_destination.id,
            draft=TransferDraft(
                date=source_row["date"],
                amount_cents=source_row["amount_cents"],
                memo=source_row["memo"],
                flag=source_row["flag"],
            ),
        )
        if selected_destination is not None
        else None
    )
    if proposal is not None:
        relation, projected = _validate_review_source(db, source)
        _validate_review(db, source, relation, projected, proposal)
    counterpart_payee_id = _counterpart_payee_id(
        db, source.account_id, selected_destination.id, source.amount_cents, source.date, source_row["payee_id"],
    ) if selected_destination else None
    return {
        "source": source_row,
        "destination": _destination_out(db, selected_destination) if selected_destination else None,
        "candidates": [_candidate_out(item[3], item[4]) for item in candidates],
        "candidate": _candidate_out(ledger_projection.row(db, selected), selected_destination) if selected else None,
        "scope": scope,
        "next_cursor": None,
        "context_token": _review_token(db, source, selected, proposal, selected_destination) if proposal is not None else _token(db, source, None),
        "allowed_actions": ["link", "create_counterpart", "save_unlinked"] if proposal is not None else ["link", "create_counterpart"],
        "proposal": proposal,
        "proposal_payee_name": db.get(Payee, proposal.payee_id).name if proposal else None,
        "counterpart_payee_id": counterpart_payee_id,
        "search_all_accounts": True,
        "counterpart_destinations": counterpart_destinations,
    }


def _review_token(
    db: Session, source: Transaction, candidate: Transaction | None, proposal, destination: Account
) -> str:
    value = {
        "source": {"edit_token": ledger_projection.row(db, source)["edit_token"], "facts": _facts(db, source)},
        "candidate": (
            {"edit_token": ledger_projection.row(db, candidate)["edit_token"], "facts": _facts(db, candidate)}
            if candidate is not None
            else None
        ),
        "proposal": proposal.model_dump(),
        "destination": (destination.id, destination.name, destination.closed),
    }
    return hashlib.sha256(json.dumps(value, default=str, sort_keys=True).encode()).hexdigest()


def _draft_preview(db, proposal, description, category_id):
    category_id = proposal.draft.categorization.category_id if proposal.draft.categorization else category_id
    category = db.get(Category, category_id) if category_id is not None else None
    parent = db.get(Category, category.parent_id) if category and category.parent_id else None
    return {"date": proposal.draft.date, "description": description, "amount_cents": proposal.draft.amount_cents,
            "memo": proposal.draft.memo, "flag": proposal.draft.flag,
            "category_label": f"{parent.name}: {category.name}" if parent else "No category"}


def _review_values(proposal) -> dict:
    values = {"date": proposal.draft.date, "amount_cents": proposal.draft.amount_cents,
              "memo": proposal.draft.memo, "flag": proposal.draft.flag,
              "payee_id": proposal.payee_id, "transfer_account_id": proposal.transfer_account_id}
    if proposal.draft.categorization is not None:
        values["categorization"] = proposal.draft.categorization
    return values


def _validate_review(db, source, relation, projected, proposal) -> tuple[Account, dict]:
    if proposal.draft.duplicate_source_id is not None:
        raise AppError("transfer_duplicate_not_allowed", "Duplicate references are only allowed for new transfer drafts.", 422)
    values = _review_values(proposal)
    editable_values = {
        field: value
        for field, value in values.items()
        if field == "categorization" or projected.get(field) != value
    }
    ledger_projection.validate_edit_values(
        source,
        relation,
        editable_values,
        projected["allowed_actions"],
        projected["editable_fields"],
    )
    destination = ledger.validate_transfer_assignment(
        db, source, projected, proposal.transfer_account_id, values
    )
    return destination, values


def review_context(
    db: Session,
    source_id: int,
    proposal,
    expected_edit_token: str | None,
    scope: str,
    candidate_id: int | None,
    cursor: str | None,
) -> dict:
    source = db.get(Transaction, source_id)
    if source is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    if scope not in ("nearby", "all"):
        raise AppError("transfer_scope_invalid", "Choose nearby or all transactions.", 422)
    relation, projected = _validate_review_source(db, source)
    if expected_edit_token is not None and expected_edit_token != projected["edit_token"]:
        raise AppError(
            "transaction_edit_stale",
            "The transaction changed. Reload it before saving.",
            409,
        )
    destination, _ = _validate_review(db, source, relation, projected, proposal)
    return _context_rows(
        db,
        source,
        scope,
        candidate_id,
        cursor,
        destination=destination,
        proposal=proposal,
        candidate_source=Transaction(account_id=source.account_id, date=proposal.draft.date, amount_cents=proposal.draft.amount_cents),
    )


def _link(db: Session, source: Transaction, candidate: Transaction) -> None:
    destination = _validate_source(db, source)
    _candidate_ok(db, source, candidate, destination)
    source_target = ledger_target_id(db, source)
    ledger.materialize_transfer_completion(db, source, source_target)
    ledger.materialize_transfer_completion(db, candidate, source.account_id)
    transfer_links.link(source, candidate)
    source.approved = True
    candidate.approved = True
    record = db.scalar(select(AutomaticTransferLink).where(
        or_(AutomaticTransferLink.outflow_transaction_id == source.id, AutomaticTransferLink.inflow_transaction_id == source.id),
        or_(AutomaticTransferLink.outflow_transaction_id == candidate.id, AutomaticTransferLink.inflow_transaction_id == candidate.id),
    ))
    if record is not None:
        record.state = "inactive"
        record_lifecycle(db, "transfers", "overridden", "explicit_link", account_id=source.account_id, transaction_id=source.id, candidate_id=candidate.id, relationship_id=record.id)


def ledger_target_id(db: Session, row: Transaction) -> int:
    target_id = ledger_projection.effective_facts(db, row)["transfer_account_id"]
    if payee_identity.target(db, target_id) is None:
        raise AppError("transfer_not_classified", "Choose a transfer account first.", 422)
    return target_id


def _create_counterpart(db: Session, source: Transaction, destination: Account, *, payee_id: int, row_edits=None, teach=True) -> Transaction:
    account = db.get(Account, source.account_id)
    payees.require_assignable(db, payee_id)
    partner = Transaction(
        account_id=destination.id,
        date=source.date,
        description=f"Transfer {'to' if source.amount_cents > 0 else 'from'} {account.name}",
        amount_cents=-source.amount_cents,
        status="uncleared",
        approved=True,
        source="manual",
        memo="",
        payee_id=payee_id,
        transfer_account_id=account.id,
        transfer_payee_confirmed=teach,
        category_id=None,
        category_assigned=False,
    )
    db.add(partner)
    db.flush()
    if teach:
        ledger.apply_comparison_edits(db, partner, row_edits)
    return partner


def _counterpart_payee_id(db, source_account_id, destination_id, amount, when, source_payee_id):
    return payee_identity.suggested_payee_id(db, destination_id, source_account_id, -amount, when) or source_payee_id


def _existing_partner(db: Session, source: Transaction) -> Transaction | None:
    ledger_projection.require_account_initialized(db, source.account_id)
    anchor = _anchor(db, source)
    if anchor.transfer_partner_id is None:
        return None
    if not _visible(db, source):
        raise AppError("transfer_source_not_available", "This transaction is no longer visible.", 422)
    partner = db.get(Transaction, anchor.transfer_partner_id)
    if partner is None or partner.transfer_partner_id != anchor.id or ledger_projection.resolve_relationship(db, partner).parent is None:
        raise AppError("transfer_already_linked", "Unlink the existing transfer before linking another transaction.", 409)
    ledger_projection.require_account_initialized(db, partner.account_id)
    return partner


def link(db: Session, source_id: int, candidate_id: int, token: str, row_edits=None) -> dict:
    source, candidate = db.get(Transaction, source_id), db.get(Transaction, candidate_id)
    if source is None or candidate is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    if _token(db, source, candidate) != token:
        raise AppError("transfer_context_stale", "The transfer context changed. Reopen it and review again.", 409)
    _link(db, source, candidate)
    ledger.apply_comparison_edits(db, candidate, row_edits)
    db.flush()
    return _transfer_result(db, source, candidate)


def review(
    db: Session,
    source_id: int,
    proposal,
    context_token: str,
    intent: str,
    candidate_id: int | None,
    row_edits=None,
) -> dict:
    source = db.get(Transaction, source_id)
    if source is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    if intent == "create_counterpart":
        partner = _existing_partner(db, source)
        if partner is not None:
            destination = payee_identity.target(db, proposal.transfer_account_id)
            if destination is None or destination.id != partner.account_id:
                raise AppError("transfer_already_linked", "Unlink the existing transfer before linking another transaction.", 409)
            return _transfer_result(db, source, partner)
    relation, projected = _validate_review_source(db, source)
    destination, values = _validate_review(
        db, source, relation, projected, proposal
    )
    candidate = db.get(Transaction, candidate_id) if candidate_id is not None else None
    if candidate_id is not None and candidate is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    if _review_token(db, source, candidate, proposal, destination) != context_token:
        raise AppError(
            "transfer_context_stale",
            "The transfer context changed. Reopen it and review again.",
            409,
        )
    for field in ("date", "amount_cents"):
        setattr(source, field, values[field])
    ledger.apply_metadata_values(db, source, relation, projected, values)
    payees.require_assignable(db, ledger_projection.effective_facts(db, source)["payee_id"])
    source.transfer_payee_confirmed = True
    source.approved = True
    partner = None
    if intent == "link":
        _link(db, source, candidate)
        ledger.apply_comparison_edits(db, candidate, row_edits)
        partner = candidate
    elif intent == "create_counterpart":
        partner = _create_counterpart(db, source, destination, payee_id=row_edits.payee_id, row_edits=row_edits)
        _link(db, source, partner)
        matching.reconcile(db, {destination.id}, allow_automatic=False, expire_stale=True)
    db.flush()
    return _transfer_result(db, source, partner)


def _validate_draft(db: Session, account_id: int, proposal):
    payees.require_assignable(db, proposal.payee_id)
    account = db.get(Account, account_id)
    if account is None:
        raise AppError("account_not_found", "Account not found", 422)
    ledger_projection.require_account_initialized(db, account.id)
    if proposal.draft.amount_cents == 0:
        raise AppError("transfer_not_available", "Transfers require a nonzero amount.", 422)
    destination = payee_identity.target(db, proposal.transfer_account_id)
    if destination is None:
        raise AppError("transfer_not_classified", "Choose a transfer account first.", 422)
    ledger_projection.require_account_initialized(db, destination.id)
    if destination.id == account.id:
        raise AppError("transfer_self_not_allowed", "A transfer cannot target its own account.", 422)
    if destination.closed:
        raise AppError("transfer_target_closed", "Closed accounts cannot receive a new transfer.", 422)
    if proposal.draft.categorization is not None and proposal.draft.categorization.category_id is not None:
        categories.require_assignable(db, proposal.draft.categorization.category_id)
    return account, destination


def _draft_source(account_id: int, proposal, description: str) -> Transaction:
    return Transaction(
        account_id=account_id,
        date=proposal.draft.date,
        description=description,
        amount_cents=proposal.draft.amount_cents,
        status="uncleared",
        approved=True,
        source="manual",
        memo=proposal.draft.memo,
        flag=proposal.draft.flag,
        payee_id=proposal.payee_id,
        transfer_account_id=proposal.transfer_account_id,
        transfer_payee_confirmed=True,
        category_id=proposal.draft.categorization.category_id if proposal.draft.categorization else None,
        category_assigned=proposal.draft.categorization is not None,
    )


def _draft_token(db: Session, account_id: int, proposal, candidate: Transaction | None, destination: Account, description: str) -> str:
    value = {
        "account_id": account_id,
        "proposal": proposal.model_dump(mode="json"),
        "description": description,
        "candidate": _facts(db, candidate) if candidate else None,
        "destination": (destination.id, destination.name, destination.closed),
    }
    return hashlib.sha256(json.dumps(value, default=str, sort_keys=True).encode()).hexdigest()


def draft_context(
    db: Session,
    account_id: int,
    proposal,
    scope: str,
    candidate_id: int | None,
    cursor: str | None,
) -> dict:
    if scope not in ("nearby", "all"):
        raise AppError("transfer_scope_invalid", "Choose nearby or all transactions.", 422)
    if cursor is not None:
        raise AppError("transfer_cursor_invalid", "Draft transfer candidates do not support paging.", 422)
    account, destination = _validate_draft(db, account_id, proposal)
    description = ledger.duplicate_description(db, proposal.draft.duplicate_source_id, account.id)
    source = _draft_source(account.id, proposal, description)
    candidate = db.get(Transaction, candidate_id) if candidate_id is not None else None
    if candidate_id is not None and candidate is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    if candidate is not None:
        _candidate_ok(db, source, candidate, destination)
    projection = ledger_projection.parent_projection(db, {destination.id})
    candidates = []
    for row_source, _relationship, row in projection.values():
        if not _candidate_row_ok(source, row, destination):
            continue
        distance = abs((row_source.date - source.date).days)
        if scope == "nearby" and distance > 7:
            continue
        candidates.append((distance, row_source.date.isoformat(), row_source.id, row, row_source))
    candidates.sort(key=lambda item: item[:3])
    candidate = _selected_candidate(candidates, candidate, cursor)
    shown = [item[3] for item in candidates]
    ledger_projection.fill_tokens(db, projection, shown)
    counterpart_payee_id = _counterpart_payee_id(
        db, account.id, destination.id, proposal.draft.amount_cents, proposal.draft.date, proposal.payee_id,
    )
    return {
        "source": None,
        "draft": _draft_preview(db, proposal, source.description, None),
        "destination": _destination_out(db, destination),
        "candidates": [_candidate_out(item[3], destination) for item in candidates],
        "candidate": _candidate_out(ledger_projection.row(db, candidate), destination) if candidate else None,
        "scope": scope,
        "next_cursor": None,
        "context_token": _draft_token(db, account.id, proposal, candidate, destination, description),
        "allowed_actions": ["link", "create_counterpart", "save_unlinked"],
        "proposal": proposal,
        "proposal_payee_name": db.get(Payee, proposal.payee_id).name,
        "counterpart_payee_id": counterpart_payee_id,
        "search_all_accounts": False,
        "counterpart_destinations": [],
    }


def draft_review(
    db: Session,
    account_id: int,
    proposal,
    context_token: str,
    intent: str,
    candidate_id: int | None,
    row_edits=None,
) -> dict:
    account, destination = _validate_draft(db, account_id, proposal)
    candidate = db.get(Transaction, candidate_id) if candidate_id is not None else None
    if candidate_id is not None and candidate is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    description = ledger.duplicate_description(db, proposal.draft.duplicate_source_id, account.id)
    source = _draft_source(account.id, proposal, description)
    if candidate is not None:
        _candidate_ok(db, source, candidate, destination)
    if _draft_token(db, account.id, proposal, candidate, destination, description) != context_token:
        raise AppError("transfer_context_stale", "The transfer context changed. Reopen it and review again.", 409)
    db.add(source)
    db.flush()
    partner = None
    if intent == "link":
        _link(db, source, candidate)
        ledger.apply_comparison_edits(db, candidate, row_edits)
        partner = candidate
    elif intent == "create_counterpart":
        partner = _create_counterpart(db, source, destination, payee_id=row_edits.payee_id, row_edits=row_edits)
        _link(db, source, partner)
    db.flush()
    account_ids = {source.account_id, *( [partner.account_id] if partner else [])}
    matching.reconcile(db, account_ids, allow_automatic=False, expire_stale=True)
    return _transfer_result(db, source, partner)


def _transfer_result(db: Session, source: Transaction, partner: Transaction | None) -> dict:
    visible_partner = ledger_projection.resolve_relationship(db, partner).parent if partner else None
    return {
        "source": ledger_projection.row(db, source),
        "partner": ledger_projection.row(db, visible_partner) if visible_partner else None,
    }


def counterpart(db: Session, source_id: int, token: str, candidate_id: int | None = None, row_edits=None) -> dict:
    source = db.get(Transaction, source_id)
    if source is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    partner = _existing_partner(db, source)
    if partner is not None:
        return _transfer_result(db, source, partner)
    candidate = db.get(Transaction, candidate_id) if candidate_id is not None else None
    if candidate_id is not None and candidate is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    if _token(db, source, candidate) != token:
        raise AppError("transfer_context_stale", "The transfer context changed. Reopen it and review again.", 409)
    destination = _validate_source(db, source)
    partner = _create_counterpart(db, source, destination, payee_id=row_edits.payee_id, row_edits=row_edits)
    _link(db, source, partner)
    matching.reconcile(db, {destination.id}, allow_automatic=False, expire_stale=True)
    db.flush()
    return _transfer_result(db, source, partner)


def unlink(db: Session, source_id: int, token: str) -> dict:
    source = db.get(Transaction, source_id)
    if source is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    ledger_projection.require_account_initialized(db, source.account_id)
    ledger_projection.require_action(db, source, "unlink_transfer")
    anchor = _anchor(db, source)
    partner = db.get(Transaction, anchor.transfer_partner_id) if anchor.transfer_partner_id else None
    if _token(db, source, None) != token:
        raise AppError("transfer_context_stale", "The transfer context changed. Reopen it and review again.", 409)
    if partner is None or partner.transfer_partner_id != anchor.id:
        raise AppError("transfer_not_linked", "This transaction has no current linked transfer.", 422)
    ledger_projection.require_account_initialized(db, partner.account_id)
    record = ledger_projection.active_automatic_transfer(db, anchor)
    if record is None:
        record = db.scalar(select(AutomaticTransferLink).where(
            or_(AutomaticTransferLink.outflow_transaction_id == anchor.id, AutomaticTransferLink.inflow_transaction_id == anchor.id),
            or_(AutomaticTransferLink.outflow_transaction_id == partner.id, AutomaticTransferLink.inflow_transaction_id == partner.id),
        ))
    automatic = record is not None and record.state == "active"
    if automatic:
        _restore_automatic(db, record, reject=True)
    else:
        transfer_links.unlink(db, anchor)
        outflow, inflow = (anchor, partner) if anchor.amount_cents < 0 else (partner, anchor)
        record = record or AutomaticTransferLink(outflow_transaction_id=outflow.id, inflow_transaction_id=inflow.id, reason="explicit", handoff={})
        record.state = "rejected"
        db.add(record)
    outflow, inflow = (source, partner) if source.amount_cents < 0 else (partner, source)
    first_members, second_members = _transfer_members(db, outflow), _transfer_members(db, inflow)
    db.flush()
    for first_id in first_members:
        for second_id in second_members:
            rejection = db.scalar(select(AutomaticTransferLink).where(AutomaticTransferLink.outflow_transaction_id == first_id, AutomaticTransferLink.inflow_transaction_id == second_id))
            rejection = rejection or AutomaticTransferLink(outflow_transaction_id=first_id, inflow_transaction_id=second_id, reason="explicit", handoff={})
            rejection.state = "rejected"
            db.add(rejection)
    db.flush()
    if not automatic:
        record_lifecycle(db, "transfers", "rejected", "user_unlinked", account_id=source.account_id, transaction_id=outflow.id, candidate_id=inflow.id, relationship_id=record.id)
    return _transfer_result(db, source, partner)


def enter_scheduled(db: Session, payload, *, description: str, source_approved: bool) -> tuple[Transaction, Transaction]:
    source = ledger.create_manual_transaction(db, payload, approved=False, description=description)
    destination = _validate_source(db, source)
    partner = _create_counterpart(db, source, destination, payee_id=source.payee_id, teach=False)
    _link(db, source, partner)
    source.approved = source_approved
    partner.approved = False
    db.flush()
    return source, partner


def _transfer_members(db, transaction):
    from app.services import bank_continuity

    representative = ledger_projection.current_representative(db, transaction) or transaction
    identifiers = bank_continuity.members(db, representative.id) | {transaction.id}
    relation = ledger_projection.resolve_relationship(db, representative).relation
    if relation is not None and relation.state == "matched":
        identifiers.add(relation.history_transaction_id)
    return identifiers


def _classification(db, transaction):
    representative = (ledger_projection.current_representative(db, transaction) or transaction)
    relation = ledger_projection.resolve_relationship(db, representative).relation
    continuity = transaction.bank_continuity
    return {
        "transfer_account_id": transaction.transfer_account_id,
        "match_id": relation.id if relation and relation.state == "matched" else None,
        "transfer_source": relation.transfer_source if relation and relation.state == "matched" else None,
        "continuity_id": continuity.id if continuity else None,
        "bank_transfer_source": continuity.transfer_source if continuity else None,
    }


def _classification_references(db, values):
    account = db.get(Account, values["transfer_account_id"]) if values["transfer_account_id"] is not None else None
    return {"account": {"id": account.id} if account else None}


def _restore_automatic(db, record, *, reject=False, reason="bank_association_changed"):
    first = db.get(Transaction, record.outflow_transaction_id)
    second = db.get(Transaction, record.inflow_transaction_id)
    first = (ledger_projection.current_representative(db, first) or first) if first else None
    second = (ledger_projection.current_representative(db, second) or second) if second else None
    if first and second and first.transfer_partner_id == second.id and second.transfer_partner_id == first.id:
        transfer_links.unlink(db, first)
    restored, preserved = 0, 0
    for saved in (record.handoff or {}).get("rows", []):
        transaction = db.get(Transaction, saved["id"])
        if transaction is None:
            continue
        current = _classification(db, transaction)
        before, applied = saved["before"], saved["applied"]
        references = _classification_references(db, before)
        if current["transfer_account_id"] == applied["transfer_account_id"] and references["account"] == saved["references"]["account"]:
            transaction.transfer_account_id = before["transfer_account_id"]
            restored += 1
            for id_key, source_key, model in (
                ("match_id", "transfer_source", TransactionMatch),
                ("continuity_id", "bank_transfer_source", BankContinuity),
            ):
                if current[id_key] == applied[id_key] and current[source_key] == applied[source_key]:
                    owner = db.get(model, before[id_key]) if before[id_key] is not None else None
                    if owner is not None:
                        owner.transfer_source = before[source_key]
                elif current[id_key] != applied[id_key]:
                    (ledger_projection.current_representative(db, transaction) or transaction).approved = False
        else:
            preserved += 1
            (ledger_projection.current_representative(db, transaction) or transaction).approved = False
    record.state = "rejected" if reject else "inactive"
    db.flush()
    record_lifecycle(db, "transfers", "rejected" if reject else "withdrawn", "user_unlinked" if reject else reason, account_id=first.account_id if first else second.account_id if second else None, transaction_id=record.outflow_transaction_id, candidate_id=record.inflow_transaction_id, relationship_id=record.id, representative_id=first.id if first else None, partner_representative_id=second.id if second else None, restored_fields=restored, preserved_fields=preserved)


def withdraw_automatic(db, transaction_ids, *, reason="bank_association_changed", exact=False):
    from app.services import bank_continuity

    if not exact:
        transaction_ids = set().union(*(bank_continuity.members(db, identifier) for identifier in transaction_ids))
    records = db.scalars(select(AutomaticTransferLink).where(
        AutomaticTransferLink.state == "active",
        or_(AutomaticTransferLink.outflow_transaction_id.in_(transaction_ids), AutomaticTransferLink.inflow_transaction_id.in_(transaction_ids)),
    )).all()
    for record in records:
        _restore_automatic(db, record, reason=reason)


def _automatic_candidate(transaction, relationship, projected, accounts, linked_account_ids):
    account = accounts.get(transaction.account_id)
    return (account is not None and not account.closed and (account.id not in linked_account_ids or account.starting_balance_initialized_at is not None)
            and (account.id not in linked_account_ids or account.plaid_history_imported_at is not None)
            and relationship.parent is not None and relationship.parent.id == transaction.id
            and (transaction.source != "plaid" or transaction.account_id in linked_account_ids)
            and transaction.source != "starting_balance" and transaction.amount_cents != 0
            and transaction.feed_historical_at is None and transaction.provider_lifecycle_detached_at is None
            and transaction.plaid_excluded_at is None and not projected["missing_pending"]
            and not projected["allocations"]
            and relationship.anchor.transfer_partner_id is None)


def _automatic_reason(first, second, first_row, second_row, accounts):
    first_transfer, second_transfer = first_row["transfer"], second_row["transfer"]
    if first_transfer and first_transfer["account_id"] != second.account_id:
        return None
    if second_transfer and second_transfer["account_id"] != first.account_id:
        return None
    if first_transfer or second_transfer:
        return "destination"
    if first.source != "plaid" or second.source != "plaid":
        return None
    currencies = [(row.plaid_raw or {}).get("iso_currency_code") for row in (first, second)]
    if not currencies[0] or currencies[0] != currencies[1]:
        return None
    types = (accounts[first.account_id].type, accounts[second.account_id].type)
    return "provider" if matching.provider_transfer_evidence(first, types) and matching.provider_transfer_evidence(second, types) else None


def reconcile_automatic(db: Session, account_ids: set[int], *, transaction_ids: set[int] | None = None) -> int:
    if not account_ids:
        return 0
    lookups = ledger_projection.projection_lookups(db)
    for identifier in account_ids:
        account = lookups.accounts.get(identifier)
        if account is not None and identifier in lookups.linked_account_ids and (account.plaid_history_imported_at is None or account.starting_balance_initialized_at is None):
            record_lifecycle(db, "transfers", "blocked", "account_not_ready", account_id=identifier, history_complete=account.plaid_history_imported_at is not None, initialized=account.starting_balance_initialized_at is not None)
    query = select(Transaction.id, Transaction.date, Transaction.amount_cents).where(
        Transaction.amount_cents != 0,
        Transaction.feed_replacement_id.is_(None), Transaction.transfer_partner_id.is_(None),
        Transaction.plaid_removed_at.is_(None), Transaction.plaid_excluded_at.is_(None),
        Transaction.feed_historical_at.is_(None), Transaction.provider_lifecycle_detached_at.is_(None),
        Transaction.source.in_(("manual", "plaid")),
        ~exists(select(TransactionAllocation.id).where(TransactionAllocation.transaction_id == Transaction.id)),
        ~exists(select(TransactionMatch.id).where(TransactionMatch.history_transaction_id == Transaction.id, TransactionMatch.state == "matched")),
    )
    if transaction_ids is not None:
        identifiers = set(transaction_ids)
        for identifier in transaction_ids:
            transaction = db.get(Transaction, identifier)
            if transaction is not None:
                identifiers.add((ledger_projection.current_representative(db, transaction) or transaction).id)
        seeds = [row for batch in batched(identifiers, SQL_ID_BATCH_SIZE) for row in db.execute(query.where(Transaction.account_id.in_(account_ids), Transaction.id.in_(batch))).all()]
    else:
        destinations = dict(db.execute(select(Transaction.id, Transaction.transfer_account_id).where(Transaction.transfer_account_id.is_not(None))).all())
        for _ in range(2):
            for source_id, target_id in db.execute(select(BankContinuity.source_transaction_id, BankContinuity.target_transaction_id).where(BankContinuity.state == "active", BankContinuity.transfer_source == "source", BankContinuity.source_transaction_id.in_(destinations))).all():
                destinations[target_id] = destinations[source_id]
        for source_id, target_id in db.execute(select(TransactionMatch.history_transaction_id, TransactionMatch.feed_transaction_id).where(TransactionMatch.state == "matched", TransactionMatch.transfer_source == "history", TransactionMatch.history_transaction_id.in_(destinations))).all():
            destinations[target_id] = destinations[source_id]
        incoming = {identifier for identifier, destination_id in destinations.items() if destination_id in account_ids}
        seeds = db.execute(query.where(or_(
            and_(Transaction.account_id.in_(account_ids), or_(Transaction.id.in_(destinations), and_(Transaction.source == "plaid", func.json_extract(Transaction.plaid_raw, "$.personal_finance_category.primary").in_(("TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS"))))),
            Transaction.id.in_(incoming),
        ))).all()
    if not seeds:
        return 0
    neighborhoods = {
        (amount, row.date - timedelta(days=14), row.date + timedelta(days=14))
        for row in seeds for amount in (row.amount_cents, -row.amount_cents)
    }
    pool = {}
    for batch in batched(neighborhoods, SQL_ID_BATCH_SIZE):
        pool.update((row.id, row) for row in db.scalars(select(Transaction).where(or_(
            *(and_(Transaction.amount_cents == amount, Transaction.date >= first, Transaction.date <= last) for amount, first, last in batch)
        ), Transaction.feed_replacement_id.is_(None))).all())
    projected = ledger_projection.project_rows(db, pool.values(), relationships=ledger_projection.resolve_relationships(db, pool.values()), lookups=lookups)
    claimed = {identifier for batch in batched(pool, SQL_ID_BATCH_SIZE) for identifier in db.scalars(select(Transaction.transfer_partner_id).where(Transaction.transfer_partner_id.in_(batch))).all()}
    eligible = {identifier: value for identifier, value in projected.items() if identifier not in claimed and _automatic_candidate(*value, lookups.accounts, lookups.linked_account_ids)}
    groups = {}
    for transaction, relationship, row in eligible.values():
        groups.setdefault(transaction.amount_cents, []).append(transaction)
    edges = []
    for amount, first_rows in groups.items():
        if amount >= 0:
            continue
        for first in first_rows:
            for second in groups.get(-amount, []):
                distance = abs((first.date - second.date).days)
                if first.account_id != second.account_id and distance <= 7:
                    first_row, second_row = eligible[first.id][2], eligible[second.id][2]
                    if (first_row["transfer"] and first_row["transfer"]["account_id"] != second.account_id) or (second_row["transfer"] and second_row["transfer"]["account_id"] != first.account_id):
                        if first.account_id in account_ids or second.account_id in account_ids:
                            record_lifecycle(db, "transfers", "blocked", "destination_conflict", account_id=first.account_id, transaction_id=first.id, candidate_id=second.id, date_distance=distance, inverse_amount=True)
                        continue
                    edges.append({"key": f"{first.id}:{second.id}", "feed_id": first.id, "history_id": second.id, "distance": distance, "automatic_eligible": True})
    seed_ids = {row.id for row in seeds}
    selected = matching.mutual_closest_edge_keys(edges)
    candidate_counts = Counter(edge["feed_id"] for edge in edges)
    peer_counts = Counter(edge["history_id"] for edge in edges)
    rejected_records = db.scalars(select(AutomaticTransferLink).where(AutomaticTransferLink.state == "rejected")).all()
    count = 0
    for edge in edges:
        if edge["feed_id"] not in seed_ids and edge["history_id"] not in seed_ids:
            continue
        if pool[edge["feed_id"]].account_id not in account_ids and pool[edge["history_id"]].account_id not in account_ids:
            continue
        first, second = pool[edge["feed_id"]], pool[edge["history_id"]]
        first_raw = first.plaid_raw if isinstance(first.plaid_raw, dict) else {}
        second_raw = second.plaid_raw if isinstance(second.plaid_raw, dict) else {}
        types = (lookups.accounts[first.account_id].type, lookups.accounts[second.account_id].type)
        evidence = {"account_id": first.account_id, "transaction_id": first.id, "candidate_id": second.id, "date_distance": edge["distance"], "candidate_count": candidate_counts[first.id], "peer_count": peer_counts[second.id], "inverse_amount": True, "currency_equal": bool(first_raw.get("iso_currency_code")) and first_raw.get("iso_currency_code") == second_raw.get("iso_currency_code"), "provider_evidence": matching.provider_transfer_evidence(first, types) and matching.provider_transfer_evidence(second, types)}
        if edge["key"] not in selected or edge["distance"] > 6:
            record_lifecycle(db, "transfers", "blocked", "not_mutual_closest" if edge["key"] not in selected else "date_window", **evidence)
            continue
        first_members, second_members = _transfer_members(db, first), _transfer_members(db, second)
        if any(record.outflow_transaction_id in first_members and record.inflow_transaction_id in second_members for record in rejected_records):
            record_lifecycle(db, "transfers", "blocked", "negative_decision", **evidence)
            continue
        reason = _automatic_reason(first, second, eligible[first.id][2], eligible[second.id][2], lookups.accounts)
        if reason is None:
            record_lifecycle(db, "transfers", "blocked", "evidence_required", **evidence)
            continue
        saved = [{"id": row.id, "before": _classification(db, row)} for row in (first, second)]
        for row in saved:
            row["references"] = _classification_references(db, row["before"])
        for transaction, destination in ((first, second), (second, first)):
            ledger.materialize_transfer_completion(db, transaction, destination.account_id)
        transfer_links.link(first, second)
        for row, transaction in zip(saved, (first, second)):
            row["applied"] = _classification(db, transaction)
        record = db.scalar(select(AutomaticTransferLink).where(AutomaticTransferLink.outflow_transaction_id == first.id, AutomaticTransferLink.inflow_transaction_id == second.id))
        record = record or AutomaticTransferLink(outflow_transaction_id=first.id, inflow_transaction_id=second.id, state="active", reason=reason)
        record.state, record.reason, record.handoff = "active", reason, {"rows": saved}
        db.add(record)
        db.flush()
        record_lifecycle(db, "transfers", "linked", reason, relationship_id=record.id, destination_evidence=reason == "destination", **evidence)
        count += 1
    return count
