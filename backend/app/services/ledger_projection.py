import hashlib
import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from itertools import batched
from datetime import date, datetime, timedelta, timezone
from typing import Literal, NamedTuple, TypedDict

from sqlalchemy import inspect, or_, select
from sqlalchemy.orm import Session, defer, joinedload, load_only
from sqlalchemy.orm.attributes import set_committed_value

from app.db import SQL_ID_BATCH_SIZE
from app.errors import AppError
from app.models import (
    Account,
    BankContinuity,
    AutomaticTransferLink,
    Category,
    Payee,
    PlaidAccountLink,
    ScheduledTransaction,
    Transaction,
    TransactionMatch,
)
from app.schemas import LedgerFilter, Target
from app.services import payee_identity
from app.services import transaction_allocations as allocations


class _BalanceSource(NamedTuple):
    id: int
    date: date
    account_id: int
    amount_cents: int
    status: str
    manually_cleared: bool
    approved: bool
    source: str
    plaid_removed_at: datetime | None
    plaid_excluded_at: datetime | None
    feed_replacement_id: int | None
    pending_replacement_id: int | None
    transfer_partner_id: int | None


@dataclass(frozen=True)
class RowRelationship:
    relation: TransactionMatch | None
    parent: Transaction | _BalanceSource | None
    anchor: Transaction | _BalanceSource
    suggestion: TransactionMatch | None = None


class EffectiveFacts(TypedDict):
    owners: dict[str, Transaction]
    payee_id: int | None
    transfer_account_id: int | None
    category: allocations.CategorySnapshot
    memo: str
    flag: str | None
    relationship: RowRelationship


@dataclass
class ProjectionContext:
    # Rebuild this read-local snapshot after changing accounts.
    accounts: dict[int, Account]
    payees: dict[int, payee_identity.Identity]
    categories: dict[int, Category]
    linked_account_ids: set[int]
    now: datetime = field(default_factory=lambda: datetime.now())
    partners: list[Transaction] = field(default_factory=list)
    partner_relationships: dict[int, RowRelationship] = field(default_factory=dict)
    automatic_links: dict[int, AutomaticTransferLink] = field(default_factory=dict)
    payee_predecessors: dict[int, list[Transaction]] | None = None


def source_visible(transaction: Transaction | _BalanceSource, *, include_excluded=False, now=None) -> bool:
    if transaction.feed_replacement_id is not None:
        return False
    return transaction.source != "plaid" or (
        plaid_visible(transaction, now)
        and (include_excluded or transaction.plaid_excluded_at is None)
    )


def _resolve_relationship(transaction, stored, now=None):
    parent = transaction if source_visible(transaction, now=now) else None
    relation = None
    if (
        stored
        and stored.state == "matched"
        and stored.history_transaction_id == transaction.id
        and source_visible(stored.feed_transaction, now=now)
    ):
        parent = stored.feed_transaction
    if stored and stored.feed_transaction_id == transaction.id and source_visible(transaction, now=now):
        relation = stored
    suggestion = (
        stored
        if stored
        and stored.state == "suggested"
        and stored.history_transaction_id == transaction.id
        and source_visible(stored.feed_transaction, now=now)
        else None
    )
    return RowRelationship(relation, parent, _transfer_anchor(transaction, relation), suggestion)


def _stored_relationships(db: Session, identifiers: Iterable[int], states: tuple[str, ...], *, defer_provider_payload=False):
    relations = {}
    sources = [joinedload(TransactionMatch.feed_transaction), joinedload(TransactionMatch.history_transaction)]
    if defer_provider_payload:
        sources = [source.defer(Transaction.plaid_raw) for source in sources]
    for batch in batched(dict.fromkeys(identifiers), SQL_ID_BATCH_SIZE):
        rows = db.scalars(
            select(TransactionMatch)
            .options(*sources)
            .where(
                or_(
                    TransactionMatch.feed_transaction_id.in_(batch),
                    TransactionMatch.history_transaction_id.in_(batch),
                ),
                TransactionMatch.state.in_(states),
            )
        ).all()
        relations.update((relation.id, relation) for relation in rows)
    return sorted(relations.values(), key=lambda relation: (relation.state != "matched", relation.id))


def resolve_relationships(db: Session, transactions, *, defer_provider_payload=False, now=None) -> dict[int, RowRelationship]:
    transactions = list(transactions)
    relations = _stored_relationships(db, (row.id for row in transactions), ("suggested", "matched"), defer_provider_payload=defer_provider_payload)
    preferred = {}
    for relation in relations:
        preferred.setdefault(relation.feed_transaction_id, relation)
        preferred.setdefault(relation.history_transaction_id, relation)
    owners = {row.id: row for row in transactions if isinstance(row, Transaction)}
    if owners:
        owners.update((relation.feed_transaction_id, relation.feed_transaction) for relation in relations)
        owners.update((relation.history_transaction_id, relation.history_transaction) for relation in relations)
        for _ in range(2):
            incoming = {}
            loader = joinedload(BankContinuity.source_transaction)
            if defer_provider_payload:
                loader = loader.defer(Transaction.plaid_raw)
            for batch in batched(owners, SQL_ID_BATCH_SIZE):
                incoming.update((record.target_transaction_id, record) for record in db.scalars(
                    select(BankContinuity).where(BankContinuity.target_transaction_id.in_(batch), BankContinuity.state == "active").options(loader)
                ).all())
            for identifier, row in owners.items():
                set_committed_value(row, "bank_continuity", incoming.get(identifier))
            owners = {record.source_transaction_id: record.source_transaction for record in incoming.values()}
            if not owners:
                break
    return {
        transaction.id: _resolve_relationship(transaction, preferred.get(transaction.id), now)
        for transaction in transactions
    }


def resolve_relationship(db: Session, transaction: Transaction) -> RowRelationship:
    return resolve_relationships(db, [transaction])[transaction.id]


def current_representative(db: Session, transaction: Transaction, *, now=None) -> Transaction | None:
    seen, account_id = set(), transaction.account_id
    while transaction.id not in seen and transaction.account_id == account_id:
        seen.add(transaction.id)
        if transaction.feed_replacement_id is not None:
            transaction = db.scalar(select(Transaction).where(Transaction.id == transaction.feed_replacement_id).options(defer(Transaction.plaid_raw)))
            if transaction is None:
                return None
            continue
        parent = resolve_relationships(db, [transaction], now=now, defer_provider_payload=True)[transaction.id].parent
        if parent is None or parent.id == transaction.id:
            return transaction
        transaction = parent
    return None



def _in_scope(transaction, relationship, scope, now=None):
    active = relationship.parent is not None and relationship.parent.id == transaction.id
    excluded = (
        transaction.source == "plaid"
        and transaction.plaid_excluded_at is not None
        and source_visible(transaction, include_excluded=True, now=now)
    )
    if scope == "excluded":
        return excluded
    return active or (scope == "all_sources" and excluded)


def _ledger_rows_and_relationships(
    db: Session,
    account_ids: set[int] | None,
    scope: str = "active",
    *,
    row_type: Literal["full", "deferred", "balance"] = "full",
    now: datetime | None = None,
) -> tuple[list[Transaction | _BalanceSource], dict[int, RowRelationship]]:
    query = select(Transaction)
    if row_type == "balance":
        query = select(*(getattr(Transaction, name) for name in _BalanceSource._fields))
    elif row_type == "deferred":
        query = query.options(defer(Transaction.plaid_raw))
    queries = [query] if account_ids is None else [
        query.where(Transaction.account_id.in_(batch))
        for batch in batched(sorted(account_ids), SQL_ID_BATCH_SIZE)
    ]
    rows = [
        row
        for statement in queries
        for row in (db.execute(statement).all() if row_type == "balance" else db.scalars(statement).all())
    ]
    if row_type == "balance":
        sources = []
        for values in rows:
            source = _BalanceSource(*values)
            instance = db.identity_map.get((Transaction, (source.id,), None))
            if instance is not None:
                loaded = inspect(instance).dict
                source = source._replace(**{
                    name: loaded[name] for name in _BalanceSource._fields if name in loaded
                })
            sources.append(source)
        rows = sources
    rows.sort(key=lambda row: row.id)
    relationships = resolve_relationships(db, rows, defer_provider_payload=row_type != "full", now=now)
    visible = [row for row in rows if _in_scope(row, relationships[row.id], scope, now)]
    return visible, relationships


def visible_rows(db: Session, account_id: int) -> list[Transaction]:
    return _ledger_rows_and_relationships(db, {account_id})[0]


def _lookups(db: Session) -> tuple[dict[int, payee_identity.Identity], dict[int, Category]]:
    payees = payee_identity.identities(db)
    categories = {
        category.id: category for category in db.scalars(select(Category)).all()
    }
    return payees, categories


def projection_lookups(db: Session) -> ProjectionContext:
    accounts = {account.id: account for account in db.scalars(select(Account)).all()}
    payees, category_map = _lookups(db)
    linked_account_ids = set(db.scalars(select(PlaidAccountLink.account_id)).all())
    return ProjectionContext(accounts, payees, category_map, linked_account_ids)


def hold_account_and_category_rows(db: Session):
    # SQLAlchemy's weak identity map needs local Account and Category references during projection work.
    return db.scalars(select(Category)).all(), db.scalars(select(Account)).all()


def field_owner(transaction, relation, field, *, include_bank=True):
    if (
        relation
        and relation.state == "matched"
        and getattr(relation, f"{field}_source") == "history"
    ):
        transaction = relation.history_transaction
    if include_bank and field != "description":
        for _ in range(2):
            association = getattr(transaction, "bank_continuity", None)
            if association is None or getattr(association, f"{field}_source") != "source":
                break
            transaction = association.source_transaction
    return transaction


def _bank_continuity_chain(transaction):
    for _ in range(2):
        association = getattr(transaction, "bank_continuity", None)
        if association is None:
            break
        yield association
        transaction = association.source_transaction


def payee_assignment_sources(db, transaction, relation, *, context=None):
    context = context or projection_lookups(db)
    if context.payee_predecessors is None:
        context.payee_predecessors = {}
        originals = db.scalars(select(Transaction).where(
            Transaction.feed_replacement_id.is_not(None),
        ).options(load_only(
            Transaction.id, Transaction.account_id, Transaction.feed_replacement_id,
            Transaction.payee_id, Transaction.match_tolerance_cents, Transaction.source,
        ))).all()
        for original in originals:
            context.payee_predecessors.setdefault(original.feed_replacement_id, []).append(original)
    pending = [transaction]
    if relation is not None and relation.state == "matched":
        pending.append(relation.history_transaction)
    seen = set()
    while pending:
        original = pending.pop()
        if original.id in seen or original.account_id != transaction.account_id:
            continue
        seen.add(original.id)
        yield original
        pending.extend(context.payee_predecessors.get(original.id, []))


def payee_reference_facts(db: Session, payee_ids: set[int], *, now: datetime | None = None) -> dict[int, dict]:
    if not payee_ids:
        return {}
    context = projection_lookups(db)
    if now is not None:
        context.now = now
    originals = db.scalars(select(Transaction).where(
        Transaction.payee_id.in_(payee_ids),
    ).options(defer(Transaction.plaid_raw)).order_by(Transaction.id)).all()
    facts = {identifier: {"groups": {}, "snapshots": []} for identifier in payee_ids}
    memberships = {}
    relationships = resolve_relationships(db, originals, now=context.now, defer_provider_payload=True)

    def record(transaction, reason, *, payee_id=None):
        return {
            "id": transaction.id,
            "account_name": context.accounts[transaction.account_id].name,
            "date": transaction.date,
            "amount_cents": transaction.amount_cents,
            "payee_id": payee_id or transaction.payee_id,
            "payee_name": context.payees[payee_id or transaction.payee_id].name,
            "description": transaction.description,
            "source": transaction.source,
            "reason": reason,
        }

    for original in originals:
        original_relationship = relationships[original.id]
        groups = facts[original.payee_id]["groups"]
        snapshots = facts[original.payee_id]["snapshots"]
        representative = (current_representative(db, original, now=context.now) if original.feed_replacement_id is not None
                          else original_relationship.parent)
        if representative is not None:
            if representative.id not in relationships:
                relationships.update(resolve_relationships(db, [representative], now=context.now, defer_provider_payload=True))
            relationship = relationships[representative.id]
            if representative.id not in memberships:
                memberships[representative.id] = {row.id: row for row in payee_assignment_sources(db, representative, relationship.relation, context=context)}
            if (not source_visible(representative, now=context.now)
                    or relationship.parent is None or relationship.parent.id != representative.id
                    or original.id not in memberships[representative.id]):
                representative = None
        key = f"transaction:{representative.id}" if representative is not None else f"record:{original.id}"
        if key not in groups:
            current = None
            if representative is not None:
                owner = field_owner(representative, relationship.relation, "payee")
                current = record(representative, "current", payee_id=owner.payee_id)
                snapshots.append((key, sorted((row.id, row.payee_id, row.match_tolerance_cents, row.source)
                                              for row in memberships[representative.id].values())))
            groups[key] = {"key": key, "transaction": current, "records": [], "schedule": None}
        if original.feed_replacement_id is not None:
            reason = "replaced"
        elif original.plaid_excluded_at is not None:
            reason = "excluded"
        elif missing_pending(original, context.now):
            reason = "missing_pending"
        elif original.plaid_removed_at is not None and original.status == "pending":
            reason = "expired_pending"
        elif original.plaid_removed_at is not None:
            reason = "removed"
        elif representative is not None and representative.id != original.id:
            reason = "matched"
        else:
            reason = "current"
        groups[key]["records"].append(record(original, reason))
        snapshots.append((original.id, original.account_id, original.payee_id,
                          original.feed_replacement_id, original.pending_replacement_id,
                          original.plaid_removed_at, original.plaid_excluded_at,
                          original.match_tolerance_cents))
    schedules = db.scalars(select(ScheduledTransaction).where(
        ScheduledTransaction.payee_id.in_(payee_ids),
    ).order_by(ScheduledTransaction.id)).all()
    for value in facts.values():
        value["groups"] = list(value["groups"].values())
    for schedule in schedules:
        entries = facts[schedule.payee_id]["groups"]
        snapshots = facts[schedule.payee_id]["snapshots"]
        entries.append({"key": f"schedule:{schedule.id}", "transaction": None, "records": [], "schedule": {
            "id": schedule.id, "account_name": context.accounts[schedule.account_id].name,
            "date": schedule.next_date, "amount_cents": schedule.amount_cents,
            "frequency": schedule.frequency, "memo": schedule.memo,
        }})
        snapshots.append(("schedule", schedule.id, schedule.account_id, schedule.next_date,
                          schedule.payee_id, schedule.amount_cents, schedule.frequency,
                          schedule.match_tolerance_cents, schedule.end_date))
    for identifier, value in facts.items():
        entries = value["groups"]
        entries.sort(key=lambda group: (
            (group["schedule"] or group["transaction"] or group["records"][0])["date"],
            group["schedule"] is not None,
            (group["schedule"] or group["transaction"] or group["records"][0])["id"],
        ), reverse=True)
        value["transaction_count"] = sum(len(group["records"]) for group in entries)
        value["schedule_count"] = sum(group["schedule"] is not None for group in entries)
        value["displayed_transaction_count"] = sum(
            group["transaction"] is not None and group["transaction"]["payee_id"] == identifier
            for group in entries
        )
        value["following_transaction_count"] = sum(
            len(group["records"]) for group in entries
            if group["transaction"] is not None and group["transaction"]["payee_id"] != identifier
        )
        value["unknown_transaction_count"] = sum(
            len(group["records"]) for group in entries if group["transaction"] is None
        )
    return facts


def bank_continuity_facts(transaction):
    records = []
    for association in _bank_continuity_chain(transaction):
        records.append({
            "id": association.id,
            "source_transaction_id": association.source_transaction_id,
            "target_transaction_id": association.target_transaction_id,
            "kind": association.kind,
            "state": association.state,
            **{field: getattr(association, field) for field in ("payee_source", "transfer_source", "category_source", "memo_source", "flag_source")},
            "handoff": association.handoff,
        })
    if not records:
        return None
    return {"inferred": any(record["kind"].startswith("inferred_") for record in records), "associations": records}


def _category_names(category_id, category_map):
    category = category_map.get(category_id)
    parent = (
        category_map.get(category.parent_id)
        if category and category.parent_id
        else None
    )
    return parent.name if parent else None, category.name if parent else None


def _breakdown_out(snapshot, category_map):
    if not snapshot["allocations"]:
        category_name, subcategory_name = _category_names(
            snapshot["category_id"], category_map
        )
        return [], category_name, subcategory_name
    result = []
    for row in snapshot["allocations"]:
        category_name, subcategory_name = _category_names(row["category_id"], category_map)
        result.append(
            {
                **row,
                "category_name": category_name,
                "subcategory_name": subcategory_name,
            }
        )
    return result, "Split", None


def edit_token(db, transaction, effective, relation, effective_snapshot, anchor, *, context=None):
    fields = (
        "id",
        "account_id",
        "date",
        "description",
        "payee_id",
        "transfer_account_id",
        "transfer_payee_confirmed",
        "category_id",
        "category_assigned",
        "memo",
        "amount_cents",
        "match_tolerance_cents",
        "status",
        "manually_cleared",
        "approved",
        "source",
        "flag",
        "plaid_txn_id",
        "plaid_raw",
        "plaid_removed_at",
        "plaid_excluded_at",
        "plaid_excluded_amount_cents",
        "pending_replacement_id",
        "feed_replacement_id",
        "feed_historical_at",
        "provider_lifecycle_detached_at",
    )
    relation_fields = ("id", "feed_transaction_id", "history_transaction_id", "state", "matched_by", *SOURCE_FIELDS)
    partner = db.get(Transaction, anchor.transfer_partner_id) if anchor.transfer_partner_id else None
    target_id = field_owner(transaction, relation, "transfer").transfer_account_id
    destination = context.accounts.get(target_id) if context is not None else payee_identity.target(db, target_id)
    transaction_fields = {field: getattr(transaction, field) for field in fields}
    value = {
        "bank_continuity": bank_continuity_facts(transaction),
        "field_owners": {
            field: {name: getattr(field_owner(transaction, relation, field), name) for name in ("id", "payee_id", "transfer_account_id", "category_id", "category_assigned", "memo", "flag", "date", "amount_cents")}
            for field in ("payee", "transfer", "category", "memo", "flag")
        },
        "transaction": transaction_fields,
        "effective_parent": transaction_fields if effective is transaction else {field: getattr(effective, field) for field in fields},
        "breakdown": allocations.semantic(effective_snapshot),
        "relation": (
            {
                field: getattr(relation, field)
                for field in relation_fields
            }
            if relation
            else None
        ),
        "transfer": {
            "anchor_id": anchor.id,
            "anchor_partner_id": anchor.transfer_partner_id,
            "partner": (
                {
                    field: getattr(partner, field)
                    for field in ("id", "account_id", "date", "description", "amount_cents", "status", "manually_cleared", "approved", "transfer_partner_id")
                }
                if partner
                else None
            ),
            "destination": (destination.id, destination.name, destination.closed) if destination else None,
        },
    }
    value["retained_payees"] = [
        (source.id, source.payee_id, source.match_tolerance_cents if source.source == "manual" else None)
        for source in sorted(payee_assignment_sources(db, transaction, relation, context=context), key=lambda item: item.id)
        if source is not transaction
    ]
    return hashlib.sha256(
        json.dumps(value, default=str, sort_keys=True).encode()
    ).hexdigest()


def match_role(transaction, relationship, uses_plaid_workflow, *, now=None) -> str | None:
    if (
        not uses_plaid_workflow
        or relationship.parent is None
        or relationship.parent.id != transaction.id
        or not source_visible(transaction, now=now)
        or transaction.source not in ("manual", "plaid")
        or missing_pending(transaction, now)
    ):
        return None
    active = relationship.relation and relationship.relation.state == "matched"
    if transaction.source == "manual":
        return None if active else "history"
    if transaction.plaid_txn_id is None:
        return None
    if transaction.feed_historical_at is not None:
        return "history"
    return None if active else "feed"


def _policy(uses_plaid_workflow, transaction, relationship, snapshot, transfer, account_initialized, *, now=None, partner_amount_editable=False):
    relation = relationship.relation
    can_match = match_role(transaction, relationship, uses_plaid_workflow, now=now) is not None
    active = relation if relation and relation.state == "matched" else None
    actions, editable = [], []
    disabled_actions = {}
    historical = transaction.feed_historical_at is not None
    is_missing_pending = missing_pending(transaction, now)
    if transaction.source == "manual" and not active:
        editable = [
            "date",
            "payee_id",
            "transfer_account_id",
            "category_id",
            "memo",
            "amount_cents",
            "flag",
        ]
        actions.extend(("edit", "delete", "move"))
        if relationship.suggestion:
            actions.append("dismiss_match")
        if can_match:
            actions.append("find_match")
        if not uses_plaid_workflow or historical or account_initialized:
            actions.append("clearance")
    if transaction.source == "plaid":
        if transaction.bank_continuity is not None:
            actions.append("bank_continuity")
        editable = ["payee_id", "transfer_account_id", "category_id", "memo", "flag"]
        actions.append("edit")
        if transaction.provider_lifecycle_detached_at is not None and not active:
            actions.append("clearance")
        if uses_plaid_workflow and relation and relation.state == "suggested":
            actions.append("dismiss_match")
        elif active:
            actions.append("unmatch")
        if can_match:
            actions.append("find_match")
        if is_missing_pending:
            actions.append("pending_lifecycle")
    if (uses_plaid_workflow and not historical) or (not uses_plaid_workflow and transaction.source != "starting_balance"):
        actions.append("review")
    excluded = transaction.plaid_excluded_at is not None
    if excluded:
        return ["restore"], [], disabled_actions
    if transaction.source == "plaid":
        if transaction.status == "pending" or is_missing_pending:
            disabled_actions["exclude"] = "Pending Plaid transactions can't be excluded."
        elif active:
            disabled_actions["exclude"] = "Unmatch this transaction before excluding it."
        elif transfer and transfer["state"] in ("linked", "attention"):
            disabled_actions["exclude"] = "Unlink this transfer before excluding it."
        elif not account_initialized:
            disabled_actions["exclude"] = "Finish the initial account setup before excluding bank imports."
        else:
            actions.append("exclude")
        if transaction.status == "pending" and not is_missing_pending:
            if account_initialized:
                actions.append("manual_clearance")
            else:
                disabled_actions["manual_clearance"] = (
                    "Finish the initial account setup before manually clearing bank imports."
                )
    if transaction.source != "starting_balance" and not is_missing_pending:
        actions.append("duplicate")
    if (
        transaction.source != "starting_balance"
        and transaction.amount_cents != 0
        and not is_missing_pending
        and not snapshot["allocations"]
        and (not transfer or transfer["state"] == "unlinked")
        and "edit" in actions
    ):
        actions.append("find_transfer")
    if transfer:
        linked = transfer["state"] in ("linked", "attention")
        if (
            not linked
            and transaction.source != "starting_balance"
            and transaction.amount_cents != 0
            and not is_missing_pending
            and not snapshot["allocations"]
            and "find_transfer" not in actions
        ):
            actions.append("find_transfer")
        if linked:
            locked = ("transfer_account_id",) if partner_amount_editable else ("transfer_account_id", "amount_cents")
            editable = [field for field in editable if field not in locked]
            if "move" in actions:
                disabled_actions["move"] = "Unlink this transfer before moving it."
            actions = [action for action in actions if action != "move"]
            actions.extend(("unlink_transfer", "go_to_transfer"))
    if uses_plaid_workflow and not account_initialized:
        actions = ["pending_lifecycle"] if is_missing_pending else []
        editable = []
    return actions, editable, disabled_actions


def _permissions(db, transaction, relationship, snapshot, transfer, uses_plaid_workflow, *, context=None):
    now = context.now if context is not None else None
    if not _in_scope(transaction, relationship, "all_sources", now):
        return [], [], {}
    account = context.accounts[transaction.account_id] if context is not None else db.get(Account, transaction.account_id)
    actions, editable, disabled = _policy(
        uses_plaid_workflow, transaction, relationship, snapshot, transfer,
        account.starting_balance_initialized_at is not None,
        now=now,
        partner_amount_editable=relationship.anchor.id == transaction.id and amount_partner(db, transaction) is not None,
    )
    anchor = relationship.anchor
    partner_id = anchor.transfer_partner_id
    if context is not None:
        partner_relationship = context.partner_relationships.get(partner_id)
        partner = partner_relationship.anchor if partner_relationship else None
    else:
        partner = db.get(Transaction, partner_id) if partner_id is not None else None
    connected_transfer = partner is not None and partner.transfer_partner_id == anchor.id
    if transaction.plaid_excluded_at is None and (
        (relationship.relation is not None and relationship.relation.state == "matched")
        or transaction.bank_continuity is not None or connected_transfer
    ):
        actions.append("inspect_connections")
    if "unlink_transfer" in actions and partner is not None and account_requires_initialization(db, partner.account_id, context=context):
        actions.remove("unlink_transfer")
        disabled["unlink_transfer"] = "Finish the other account's setup before unlinking this transfer."
    if "go_to_transfer" in actions and _visible_transfer_partner(db, relationship, context=context) is None:
        actions.remove("go_to_transfer")
        disabled["go_to_transfer"] = "The linked transaction is no longer available"
    if transaction.source != "starting_balance" and not missing_pending(transaction, now) and not snapshot["allocations"] and transaction.plaid_excluded_at is None:
        target_id = field_owner(transaction, relationship.relation, "transfer").transfer_account_id
        destination = context.accounts.get(target_id) if context is not None else payee_identity.target(db, target_id)
        if not account.closed and not account_requires_initialization(db, account.id, context=context) and (destination is None or (not destination.closed and not account_requires_initialization(db, destination.id, context=context))):
            actions.append("make_recurring")
    return actions, editable, disabled


def _visible_transfer_partner(db, relationship, *, partner_relationships=None, context=None):
    anchor = relationship.anchor
    if context is not None:
        partner_relationships = context.partner_relationships
    partner_relationship = (partner_relationships or {}).get(anchor.transfer_partner_id)
    if anchor.transfer_partner_id and partner_relationships is None:
        partner = db.get(Transaction, anchor.transfer_partner_id)
        partner_relationship = resolve_relationship(db, partner) if partner else None
    return partner_relationship.parent if partner_relationship else None


def active_automatic_transfer(db, transaction):
    representative = current_representative(db, transaction) or transaction
    account_sources = select(Transaction.id).where(Transaction.account_id == transaction.account_id)
    records = db.scalars(select(AutomaticTransferLink).where(AutomaticTransferLink.state == "active", or_(
        AutomaticTransferLink.outflow_transaction_id.in_(account_sources), AutomaticTransferLink.inflow_transaction_id.in_(account_sources),
    )).options(defer(AutomaticTransferLink.handoff))).all()
    for record in records:
        for identifier in (record.outflow_transaction_id, record.inflow_transaction_id):
            source = db.get(Transaction, identifier)
            current = current_representative(db, source) if source else None
            if current is not None and current.id == representative.id:
                return record
    return None


def transfer_summary(db, transaction, snapshot, *, relationship=None, partner_relationships=None, context=None):
    relationship = relationship if relationship is not None else resolve_relationship(db, transaction)
    target_id = field_owner(transaction, relationship.relation, "transfer").transfer_account_id
    destination = context.accounts.get(target_id) if context is not None else payee_identity.target(db, target_id)
    if destination is None:
        return None
    anchor = relationship.anchor
    visible_partner = _visible_transfer_partner(
        db, relationship, partner_relationships=partner_relationships, context=context,
    )
    reasons = []
    if transaction.amount_cents == 0:
        reasons.append("Transfers require a nonzero amount.")
    if anchor.transfer_partner_id is not None and visible_partner is None:
        reasons.append("The linked transfer is unavailable.")
    if visible_partner is not None and visible_partner.amount_cents != -transaction.amount_cents:
        reasons.append("The linked transfer amount no longer matches.")
    association_ids = {anchor.id, transaction.id}
    continuity = bank_continuity_facts(transaction)
    if continuity:
        association_ids.update(record["source_transaction_id"] for record in continuity["associations"])
    automatic = None
    if anchor.transfer_partner_id is not None:
        if context is not None:
            automatic = next((context.automatic_links[identifier] for identifier in association_ids if identifier in context.automatic_links and context.automatic_links[identifier].state == "active"), None)
        else:
            automatic = active_automatic_transfer(db, transaction)
    state = "attention" if reasons else ("linked" if visible_partner else "unlinked")
    return {
        "account_id": destination.id,
        "account_name": destination.name,
        "label": f"Transfer {'to' if transaction.amount_cents < 0 else 'from'} {destination.name}",
        "state": state,
        "attention_reasons": reasons,
        "automatic_reason": automatic.reason if automatic else None,
    }


def _transfer_anchor(transaction, relation):
    if transaction.transfer_partner_id is not None:
        return transaction
    if relation and relation.state == "matched":
        other = relation.history_transaction if relation.feed_transaction_id == transaction.id else relation.feed_transaction
        if other.transfer_partner_id is not None:
            return other
    return transaction


def amount_partner(db, transaction):
    if transaction.source != "manual" or transaction.feed_historical_at is not None or transaction.transfer_partner_id is None:
        return None
    partner = db.get(Transaction, transaction.transfer_partner_id)
    if (
        partner is None or partner.transfer_partner_id != transaction.id
        or partner.source != "manual" or partner.feed_historical_at is not None
        or active_match_for(db, partner) is not None
    ):
        return None
    return partner


def transfer_anchor(db, transaction):
    return resolve_relationship(db, transaction).anchor


def _pinned(transaction, relationship, uses_plaid_workflow):
    return (
        uses_plaid_workflow
        and transaction.source == "manual"
        and transaction.feed_historical_at is None
        and transaction.plaid_txn_id is None
        and relationship.relation is None
    )


def _filter_facts(transaction, relationship, payees, rows_by_transaction, uses_plaid_workflow, now, *, include_bank=True):
    relation = relationship.relation
    category_owner = field_owner(transaction, relation, "category", include_bank=include_bank)
    payee_owner = field_owner(transaction, relation, "payee", include_bank=include_bank)
    transfer_owner = field_owner(transaction, relation, "transfer", include_bank=include_bank)
    snapshot = allocations.snapshot(category_owner, rows_by_transaction.get(category_owner.id, []))
    return snapshot, {
        "payee_id": payee_owner.payee_id,
        "transfer_account_id": transfer_owner.transfer_account_id,
        "payee_name": payees[payee_owner.payee_id].name if payee_owner.payee_id in payees else None,
        "payee_kind": payees[payee_owner.payee_id].kind if payee_owner.payee_id in payees else "ordinary",
        "description": field_owner(transaction, relation, "description").description,
        "memo": field_owner(transaction, relation, "memo", include_bank=include_bank).memo,
        "missing_pending": missing_pending(transaction, now),
        "pinned": _pinned(transaction, relationship, uses_plaid_workflow),
    }


def _row(
    db,
    transaction,
    relationship,
    payees,
    category_map,
    rows_by_transaction,
    uses_plaid_workflow,
    include_token=True,
    include_bank=True,
    partner_relationships=None,
    context=None,
):
    relation = relationship.relation
    effective = field_owner(transaction, relation, "category", include_bank=include_bank)
    now = context.now if context is not None else None
    snapshot, facts = _filter_facts(
        transaction, relationship, payees, rows_by_transaction, uses_plaid_workflow, now, include_bank=include_bank,
    )
    split_rows, category_name, subcategory_name = _breakdown_out(snapshot, category_map)
    transfer = transfer_summary(
        db, transaction, snapshot, relationship=relationship,
        partner_relationships=partner_relationships, context=context,
    )
    actions, editable, disabled_actions = _permissions(
        db, transaction, relationship, snapshot, transfer, uses_plaid_workflow, context=context
    )
    excluded = transaction.plaid_excluded_at is not None
    return {
        **facts,
        "payee_name": payees[facts["payee_id"]].name if facts["payee_id"] in payees else None,
        "id": transaction.id,
        "account_id": transaction.account_id,
        "match_role": match_role(transaction, relationship, uses_plaid_workflow, now=now) if "find_match" in actions else None,
        "date": transaction.date,
        "amount_cents": transaction.amount_cents,
        "status": transaction.status,
        "manually_cleared": transaction.manually_cleared,
        "approved": transaction.approved,
        "source": transaction.source,
        "category_id": snapshot["category_id"],
        "category_assigned": snapshot["category_assigned"],
        "category_name": category_name,
        "subcategory_name": subcategory_name,
        "allocations": split_rows,
        "rule_description": (
            transaction.description if transaction.source != "starting_balance" else None
        ),
        "flag": field_owner(transaction, relation, "flag", include_bank=include_bank).flag,
        "edit_token": edit_token(db, transaction, effective, relation, snapshot, relationship.anchor, context=context)
        if include_token
        else "",
        "match": (
            {
                "id": match.id,
                "state": match.state,
            }
            if (match := relation or relationship.suggestion)
            else None
        ),
        "transfer": transfer,
        "bank_continuity": bank_continuity_facts(transaction),
        "excluded": excluded,
        "allowed_actions": actions,
        "disabled_actions": disabled_actions,
        "editable_fields": editable,
    }


def row(db: Session, transaction: Transaction):
    context = projection_lookups(db)
    relationships = resolve_relationships(db, [transaction], now=context.now)
    return project_rows(db, [transaction], relationships=relationships, lookups=context, include_token=True)[transaction.id][2]


def source_row(db: Session, transaction: Transaction, *, retained=False):
    payees, category_map = _lookups(db)
    result = _row(
        db,
        transaction,
        RowRelationship(None, None, transfer_anchor(db, transaction)),
        payees,
        category_map,
        allocations.load(db, [field_owner(transaction, None, "category", include_bank=not retained).id]),
        uses_plaid_workflow(db, transaction.account_id),
        include_bank=not retained,
    )
    result["allowed_actions"] = []
    result["editable_fields"] = []
    return result


def effective_facts(db: Session, transaction: Transaction) -> EffectiveFacts:
    return effective_facts_for_rows(db, [transaction])[transaction.id]


def effective_facts_for_rows(
    db: Session, transactions: Iterable[Transaction],
    relationships: dict[int, RowRelationship] | None = None,
) -> dict[int, EffectiveFacts]:
    transactions = list(transactions)
    relationships = relationships if relationships is not None else resolve_relationships(db, transactions)
    owners_by_id = {
        row.id: {
            field: field_owner(row, relationships[row.id].relation, field)
            for field in ("payee", "transfer", "category", "memo", "flag")
        }
        for row in transactions
    }
    rows_by_transaction = allocations.load(
        db, {owners["category"].id for owners in owners_by_id.values()}
    )
    result: dict[int, EffectiveFacts] = {}
    for row in transactions:
        owners = owners_by_id[row.id]
        result[row.id] = {
            "owners": owners,
            "payee_id": owners["payee"].payee_id,
            "transfer_account_id": owners["transfer"].transfer_account_id,
            "category": allocations.snapshot(
                owners["category"], rows_by_transaction[owners["category"].id]
            ),
            "memo": owners["memo"].memo,
            "flag": owners["flag"].flag,
            "relationship": relationships[row.id],
        }
    return result


def match_relation_facts(relation: TransactionMatch | None) -> dict | None:
    if relation is None:
        return None
    return {
        field: getattr(relation, field)
        for field in (
            "id", "feed_transaction_id", "history_transaction_id", "state",
            "matched_by", *SOURCE_FIELDS,
        )
    }


def relationship_facts(
    db: Session, transaction: Transaction, effective: EffectiveFacts | None = None
) -> dict:
    effective = effective if effective is not None else effective_facts(db, transaction)
    relation = effective["relationship"].relation
    description_owner = field_owner(transaction, relation, "description")
    anchor = effective["relationship"].anchor
    destination = payee_identity.target(db, effective["transfer_account_id"])
    return {
        "effective": {
            "description": description_owner.description,
            "payee_id": effective["payee_id"],
            "transfer_account_id": effective["transfer_account_id"],
            "category": effective["category"],
            "memo": effective["memo"],
            "flag": effective["flag"],
        },
        "owners": {
            **{name: owner.id for name, owner in effective["owners"].items()},
            "description": description_owner.id,
        },
        "relation": match_relation_facts(relation),
        "transfer": {
            "anchor_id": anchor.id,
            "partner_id": anchor.transfer_partner_id,
            "destination": (
                (destination.id, destination.name, destination.closed)
                if destination else None
            ),
        },
    }


def balances(db: Session, account_id: int) -> dict[str, int]:
    return balances_for_accounts(db, {account_id})[account_id]


def balances_for_accounts(db: Session, account_ids: set[int]) -> dict[int, dict[str, int]]:
    now = datetime.now()
    rows, _ = _ledger_rows_and_relationships(db, account_ids, row_type="balance", now=now)
    result = {
        account_id: {
            "cleared_balance_cents": 0,
            "uncleared_balance_cents": 0,
            "working_balance_cents": 0,
            "pending_count": 0,
            "missing_pending_count": 0,
        }
        for account_id in account_ids
    }
    for row in rows:
        values = result[row.account_id]
        if missing_pending(row, now):
            values["missing_pending_count"] += 1
            continue
        balance = "cleared_balance_cents" if cleared_membership(row) else "uncleared_balance_cents"
        values[balance] += row.amount_cents
        values["working_balance_cents"] += row.amount_cents
        values["pending_count"] += not row.approved
    return result


def review_count(db: Session) -> int:
    account_ids = set(db.scalars(select(Account.id)).all())
    return sum(values["pending_count"] for values in balances_for_accounts(db, account_ids).values())


def chronology_rank(amount_cents: int, source: str) -> int:
    return 0 if source == "starting_balance" else 1 if amount_cents > 0 else 2 if amount_cents == 0 else 3


def chronology_key(on_date: date, amount_cents: int, identifier: int, source: str = "") -> tuple:
    return on_date, chronology_rank(amount_cents, source), identifier


def chronology_cursor(on_date: date | None, identifier: int | None, order: int | None) -> tuple | None:
    if on_date is None and identifier is None and order is None:
        return None
    if on_date is None or identifier is None or order not in (0, 1, 2, 3):
        raise AppError("invalid_cursor", "A cursor requires date, ID and chronology class (0–3).", 422)
    return on_date, order, identifier


def running_balance_projection(rows: list[dict]) -> list[dict]:
    running_balance_cents = 0
    projected = []
    for item in sorted(rows, key=lambda row: (row["date"], chronology_rank(row["amount_cents"], row["source"]), row.get("event_kind", 0), row["id"])):
        current = dict(item)
        current["running_balance_cents"] = None
        if not current.get("missing_pending", False) and not current.get("excluded", False):
            running_balance_cents += current["amount_cents"]
            current["running_balance_cents"] = running_balance_cents
        projected.append(current)
    return projected


def scheduled_balance_projection(
    db: Session, account_id: int, occurrences: list[dict], *, context: ProjectionContext,
) -> dict[tuple[int, date], int] | None:
    if account_requires_initialization(db, account_id, context=context):
        return None
    rows, _ = _ledger_rows_and_relationships(db, {account_id}, row_type="balance", now=context.now)
    events = [
        {"id": row.id, "date": row.date, "source": row.source, "amount_cents": row.amount_cents,
         "missing_pending": missing_pending(row, context.now)}
        for row in rows
    ]
    events.extend({**row, "source": "", "event_kind": 1} for row in occurrences)
    return {
        (row["id"], row["date"]): row["running_balance_cents"]
        for row in running_balance_projection(events) if row.get("event_kind") == 1
    }


def account_requires_initialization(
    db: Session, account_id: int, *, context: ProjectionContext | None = None,
) -> bool:
    account = context.accounts.get(account_id) if context is not None else db.get(Account, account_id)
    if account is None or account.starting_balance_initialized_at is not None:
        return False
    return account_id in context.linked_account_ids if context is not None else uses_plaid_workflow(db, account_id)


def require_account_initialized(db: Session, account_id: int, *, context: ProjectionContext | None = None) -> None:
    if account_requires_initialization(db, account_id, context=context):
        raise AppError(
            "account_initialization_required",
            "Finish account initialization before changing this ledger.",
            409,
        )


def cleared_membership(row: Transaction | _BalanceSource | dict) -> bool:
    if isinstance(row, dict):
        return row["status"] in ("cleared", "reconciled") or row["manually_cleared"]
    return row.status in ("cleared", "reconciled") or row.manually_cleared


def require_action(db: Session, transaction: Transaction, action: str) -> None:
    require_account_initialized(db, transaction.account_id)
    relationship = resolve_relationship(db, transaction)
    effective = field_owner(transaction, relationship.relation, "category")
    snapshot = allocations.snapshot(
        effective, allocations.load(db, [effective.id])[effective.id]
    )
    transfer = transfer_summary(db, transaction, snapshot, relationship=relationship)
    actions, _editable, _disabled = _permissions(
        db, transaction, relationship, snapshot, transfer,
        uses_plaid_workflow(db, transaction.account_id),
    )
    if action in actions:
        return
    if action == "delete":
        raise AppError(
            "transaction_delete_not_allowed",
            "Only manual transactions can be deleted",
            422,
        )
    raise AppError(
        f"transaction_{action}_not_allowed",
        "This transaction cannot perform that action",
        422,
    )


def validate_edit_values(
    transaction: Transaction,
    relation: TransactionMatch | None,
    values: dict,
    actions: list[str],
    editable_fields: list[str],
) -> None:
    fields = {
        "category_id" if item == "categorization" else item
        for item in values
        if item != "expected_edit_token"
    }
    if "edit" in actions and fields.issubset(editable_fields):
        return
    if transaction.source == "plaid" and relation and relation.state == "matched":
        raise AppError(
            "matched_plaid_field_locked",
            "Matched Plaid date, description, amount, status, source, and account cannot be edited",
            422,
        )
    raise AppError(
        "transaction_edit_not_allowed", "This transaction cannot edit those fields", 422
    )


def project_rows(
    db: Session, transactions: Iterable[Transaction], *,
    relationships: dict[int, RowRelationship],
    lookups: ProjectionContext,
    include_token: bool = False,
):
    transactions = list(transactions)
    if include_token:
        _load_token_payloads(db, ((row, relationships[row.id]) for row in transactions))
    partner_ids = {
        relationships[row.id].anchor.transfer_partner_id for row in transactions
    } - {None}
    partners = [
        partner
        for batch in batched(partner_ids, SQL_ID_BATCH_SIZE)
        for partner in db.scalars(select(Transaction).where(Transaction.id.in_(batch))).all()
    ]
    lookups.partners.extend(partners)
    partner_relationships = resolve_relationships(db, partners, now=lookups.now)
    lookups.partner_relationships.update(partner_relationships)
    account_ids = {row.account_id for row in transactions}
    account_sources = select(Transaction.id).where(Transaction.account_id.in_(account_ids))
    records = db.scalars(select(AutomaticTransferLink).where(AutomaticTransferLink.state == "active", or_(
        AutomaticTransferLink.outflow_transaction_id.in_(account_sources), AutomaticTransferLink.inflow_transaction_id.in_(account_sources),
    )).options(defer(AutomaticTransferLink.handoff))).all()
    original_ids = {identifier for record in records for identifier in (record.outflow_transaction_id, record.inflow_transaction_id)}
    originals = {row.id: row for batch in batched(original_ids, SQL_ID_BATCH_SIZE) for row in db.scalars(select(Transaction).where(Transaction.id.in_(batch)).options(defer(Transaction.plaid_raw))).all()}
    for record in records:
        for identifier in (record.outflow_transaction_id, record.inflow_transaction_id):
            representative = current_representative(db, originals[identifier])
            if representative is not None:
                lookups.automatic_links[representative.id] = record
    owners = {
        field_owner(row, relationships[row.id].relation, "category").id
        for row in transactions
    }
    rows_by_transaction = allocations.load(db, owners)
    result = {}
    for transaction in transactions:
        relationship = relationships[transaction.id]
        result[transaction.id] = (
            transaction,
            relationship,
            _row(
                db, transaction, relationship, lookups.payees, lookups.categories,
                rows_by_transaction, transaction.account_id in lookups.linked_account_ids,
                include_token=include_token, partner_relationships=partner_relationships, context=lookups,
            ),
        )
    return result


def payee_assignment_counts(db: Session, *, now: datetime | None = None) -> dict[int, int]:
    rows, relationships = _ledger_rows_and_relationships(
        db, None, row_type="deferred", now=now or datetime.now(),
    )
    counts = {}
    for row in rows:
        payee_id = field_owner(row, relationships[row.id].relation, "payee").payee_id
        counts[payee_id] = counts.get(payee_id, 0) + 1
    return counts


def parent_projection(
    db: Session, account_ids: set[int] | None, *, scope: str = "active",
    lookups: ProjectionContext | None = None,
):
    lookups = lookups if lookups is not None else projection_lookups(db)
    rows, relationships = _ledger_rows_and_relationships(db, account_ids, scope, now=lookups.now)
    by_account: dict[int, list[Transaction]] = {account_id: [] for account_id in lookups.accounts}
    for row in rows:
        by_account[row.account_id].append(row)
    transactions = [row for account_rows in by_account.values() for row in account_rows]
    return project_rows(db, transactions, relationships=relationships, lookups=lookups)


def _load_token_payloads(db: Session, rows) -> None:
    sources = {
        source.id: source
        for transaction, relationship in rows
        for source in (transaction, field_owner(transaction, relationship.relation, "category"))
    }
    payload_ids = {
        identifier for identifier, source in sources.items()
        if "plaid_raw" not in inspect(source).dict
    }
    for batch in batched(payload_ids, SQL_ID_BATCH_SIZE):
        db.scalars(
            select(Transaction).options(load_only(Transaction.id, Transaction.plaid_raw))
            .where(Transaction.id.in_(batch))
        ).all()


def fill_tokens(
    db: Session, projection, shown: list[dict], *, lookups: ProjectionContext | None = None,
) -> None:
    selected = [projection[item["id"]] for item in shown]
    if not selected:
        return
    if lookups is None:
        _held_rows = hold_account_and_category_rows(db)
        lookups = projection_lookups(db)
    _load_token_payloads(db, ((transaction, relationship) for transaction, relationship, _ in selected))
    owners = {
        field_owner(transaction, relationship.relation, "category").id
        for transaction, relationship, _ in selected
    }
    rows_by_transaction = allocations.load(db, owners)
    for transaction, relationship, projected in selected:
        effective = field_owner(transaction, relationship.relation, "category")
        projected["edit_token"] = edit_token(
            db, transaction, effective, relationship.relation,
            allocations.snapshot(effective, rows_by_transaction[effective.id]),
            relationship.anchor,
            context=lookups,
        )


def selected_targets(
    db: Session, targets: list[Target], eligible, *, scope: str = "active",
    lookups: ProjectionContext | None = None,
):
    account_ids = {
        account_id
        for batch in batched((target.id for target in targets), SQL_ID_BATCH_SIZE)
        for account_id in db.scalars(select(Transaction.account_id).where(Transaction.id.in_(batch))).all()
    }
    projection = parent_projection(db, account_ids, scope=scope, lookups=lookups)
    shown = [projection[target.id][2] for target in targets if target.id in projection]
    fill_tokens(db, projection, shown, lookups=lookups)
    rejected, result = [], []
    for target in targets:
        item = projection.get(target.id)
        if item is None:
            rejected.append({"id": target.id, "reason": "missing or hidden"})
        elif item[2]["edit_token"] != target.edit_token:
            rejected.append({"id": target.id, "reason": "changed"})
        elif not eligible(item[2]):
            rejected.append({"id": target.id, "reason": "not eligible"})
        else:
            result.append(item)
    if rejected:
        raise AppError("bulk_selection_changed", "Selected transactions changed. Review them again.", 409, {"rejected": rejected})
    return result


def selected_snapshots(
    db: Session,
    targets: list[Target],
    editable_fields: set[str],
    *,
    require_review: bool = False,
    require_clearance: bool = False,
    require_manual_clearance: bool = False,
    lookups: ProjectionContext | None = None,
):
    return selected_targets(
        db, targets,
        lambda item: (
            not editable_fields
            or (
                "edit" in item["allowed_actions"]
                and editable_fields <= set(item["editable_fields"])
            )
        )
        and (not require_review or "review" in item["allowed_actions"])
        and (not require_clearance or "clearance" in item["allowed_actions"])
        and (not require_manual_clearance or "manual_clearance" in item["allowed_actions"]),
        lookups=lookups,
    )


def _range_bounds(value: str, today: date) -> tuple[date | None, date | None]:
    if value == "this_month":
        start = today.replace(day=1)
        end = (today.replace(day=28) + timedelta(days=4)).replace(day=1)
        return start, end - timedelta(days=1)
    if value == "latest_3_months":
        month, year = today.month - 2, today.year
        while month <= 0:
            month += 12
            year -= 1
        return date(year, month, 1), _range_bounds("this_month", today)[1]
    if value == "this_year":
        return date(today.year, 1, 1), date(today.year, 12, 31)
    return None, None


def contains_text(value: str | None, term: str | None) -> bool:
    return not term or term.casefold() in (value or "").casefold()


def _matches_filters(
    transaction: Transaction,
    relationship: RowRelationship,
    filters: LedgerFilter,
    lookups: ProjectionContext,
    rows_by_transaction,
    *,
    start: date | None,
    end: date | None,
    payee_ids: set[int],
    category_values: set[int | str],
    statuses: set[str],
) -> bool:
    if start and transaction.date < start or end and transaction.date > end:
        return False
    if filters.needs_review and transaction.approved:
        return False
    if statuses:
        status = "unmatched" if _pinned(
            transaction, relationship, transaction.account_id in lookups.linked_account_ids,
        ) else transaction.status
        if status not in statuses:
            return False
    if filters.source is not None and transaction.source != filters.source:
        return False
    if filters.amount_min_cents is not None and transaction.amount_cents < filters.amount_min_cents:
        return False
    if filters.amount_max_cents is not None and transaction.amount_cents > filters.amount_max_cents:
        return False
    if not any((payee_ids, filters.description, category_values, filters.memo, filters.needs_review)):
        return True
    snapshot, facts = _filter_facts(
        transaction, relationship, lookups.payees, rows_by_transaction,
        transaction.account_id in lookups.linked_account_ids, lookups.now,
    )
    if filters.needs_review and facts["missing_pending"]:
        return False
    if payee_ids and (facts["payee_id"] in payee_ids) != (filters.payee_mode == "include"):
        return False
    if not contains_text(facts["description"], filters.description):
        return False
    if category_values:
        lines = snapshot["allocations"]
        if filters.category_mode == "exclude" and "unassigned" in category_values and any(line["unassigned"] for line in lines):
            return False
        keys = [
            "unassigned" if line["unassigned"] else line["category_id"] if line["category_id"] is not None else "none"
            for line in lines
        ] if lines else [snapshot["category_id"] if snapshot["category_id"] is not None else "none"]
        if not any((key in category_values) == (filters.category_mode == "include") for key in keys):
            return False
    if not contains_text(facts["memo"], filters.memo) and not any(
        contains_text(line["memo"], filters.memo) for line in snapshot["allocations"]
    ):
        return False
    return True


def scope_account_ids(context: ProjectionContext, account_id: int | None, group_name: str | None) -> set[int] | None:
    if account_id is not None and group_name is not None:
        raise AppError("invalid_account_scope", "Choose one account or one group, not both.", 422)
    if account_id is not None:
        if account_id not in context.accounts:
            raise AppError("account_not_found", "Account not found", 404)
        return {account_id}
    if group_name is None:
        return None
    return {account.id for account in context.accounts.values() if not account.closed and account.group_name == group_name}


def _filtered_transactions(
    db: Session,
    filters: LedgerFilter,
    lookups: ProjectionContext,
):
    account_ids = scope_account_ids(lookups, filters.account_id, filters.group_name)
    account = lookups.accounts.get(filters.account_id)
    start, end = _range_bounds(filters.range, date.today())
    all_sources, relationships = _ledger_rows_and_relationships(
        db, account_ids,
        scope="all_sources", row_type="deferred", now=lookups.now,
    )
    scope_counts = tuple(
        sum(_in_scope(transaction, relationships[transaction.id], scope, lookups.now) for transaction in all_sources)
        for scope in ("active", "excluded")
    )
    all_rows = [
        transaction for transaction in all_sources
        if _in_scope(transaction, relationships[transaction.id], filters.scope, lookups.now)
    ]
    account_order = {identifier: index for index, identifier in enumerate(lookups.accounts)}
    all_rows.sort(key=lambda transaction: (account_order[transaction.account_id], transaction.id))
    rows_by_transaction = allocations.load(db, {
        field_owner(transaction, relationships[transaction.id].relation, "category").id
        for transaction in all_rows
    }) if filters.category_values or filters.memo else {}
    payee_ids = set(filters.payee_ids)
    category_values = set(filters.category_values)
    statuses = set(filters.statuses)
    filtered = [
        item
        for item in all_rows
        if _matches_filters(item, relationships[item.id], filters, lookups, rows_by_transaction,
                            start=start, end=end, payee_ids=payee_ids, category_values=category_values, statuses=statuses)
    ]
    return account, scope_counts, relationships, all_rows, filtered


def _context_facts(db: Session, account_id: int | None, group_name: str | None):
    lookups = projection_lookups(db)
    rows, relationships = _ledger_rows_and_relationships(
        db, scope_account_ids(lookups, account_id, group_name),
        scope="all_sources", row_type="deferred", now=lookups.now,
    )
    rows_by_transaction = allocations.load(db, {
        field_owner(transaction, relationships[transaction.id].relation, "category").id for transaction in rows
    })
    for transaction in rows:
        yield _filter_facts(
            transaction, relationships[transaction.id], lookups.payees, rows_by_transaction,
            transaction.account_id in lookups.linked_account_ids, lookups.now,
        )


def filter_choices(db: Session, account_id: int | None, group_name: str | None) -> dict:
    payee_ids, category_values = set(), set()
    for snapshot, facts in _context_facts(db, account_id, group_name):
        payee_ids.add(facts["payee_id"])
        lines = snapshot["allocations"] or [{"unassigned": False, "category_id": snapshot["category_id"]}]
        category_values.update(
            "unassigned" if line["unassigned"] else "none" if line["category_id"] is None else str(line["category_id"])
            for line in lines
        )
    return {"payee_ids": sorted(payee_ids), "category_values": sorted(category_values)}


def filter_suggestions(db: Session, account_id: int | None, group_name: str | None, field_name: Literal["description", "memo"], term: str) -> list[str]:
    counts: dict[str, int] = {}
    for snapshot, facts in _context_facts(db, account_id, group_name):
        values = [facts[field_name]] + ([line["memo"] for line in snapshot["allocations"]] if field_name == "memo" else [])
        for value in {value.strip() for value in values if value and value.strip()}:
            if contains_text(value, term):
                counts[value] = counts.get(value, 0) + 1
    return sorted(counts, key=lambda value: (-counts[value], value.casefold()))[:8]


def read_selection(db: Session, filters: LedgerFilter) -> list[dict]:
    lookups = projection_lookups(db)
    _, _, relationships, _, filtered = _filtered_transactions(db, filters, lookups)
    projection = project_rows(db, filtered, relationships=relationships, lookups=lookups, include_token=True)
    shown = [item[2] for item in projection.values()]
    for item in shown:
        item["running_balance_cents"] = None
    return shown


def read_page(
    db: Session,
    filters: LedgerFilter,
    *,
    page_size: int = 200,
    before_date: date | None = None,
    before_id: int | None = None,
    before_order: int | None = None,
    include_pinned: bool = True,
    through_date: date | None = None,
) -> dict:
    if not 1 <= page_size <= 200:
        raise AppError("invalid_page_size", "Page size must be between 1 and 200", 422)
    before = chronology_cursor(before_date, before_id, before_order)
    if through_date is not None and (before_date is not None or not include_pinned):
        raise AppError("invalid_cursor", "A loaded-window read must include pinned rows and cannot use a before cursor", 422)
    lookups = projection_lookups(db)
    account, scope_counts, relationships, all_rows, filtered = _filtered_transactions(db, filters, lookups)
    projected_balances = {}
    if account is not None and not account_requires_initialization(db, filters.account_id, context=lookups):
        projected_balances = {
            item["id"]: item["running_balance_cents"]
            for item in running_balance_projection([
                {
                    "id": transaction.id, "date": transaction.date, "source": transaction.source,
                    "amount_cents": transaction.amount_cents,
                    "missing_pending": missing_pending(transaction, lookups.now),
                    "excluded": transaction.plaid_excluded_at is not None,
                }
                for transaction in all_rows
            ])
        }
    active_count, excluded_count = scope_counts
    pinned, history = [], []
    for item in filtered:
        retain = _pinned(item, relationships[item.id], item.account_id in lookups.linked_account_ids) or (
            item.source == "plaid" and item.status == "pending"
        )
        (pinned if retain else history).append(item)
    history.sort(key=lambda item: chronology_key(item.date, item.amount_cents, item.id, item.source), reverse=True)
    if before_date is not None:
        history = [
            item
            for item in history
            if chronology_key(item.date, item.amount_cents, item.id, item.source) < before
        ]
    limit = page_size if not include_pinned else max(0, page_size - len(pinned))
    if include_pinned and before_date is None and history and limit == 0:
        limit = 1
    if through_date is not None:
        limit = max(limit, sum(item.date >= through_date for item in history))
    page_history = history[:limit]
    has_more = len(history) > limit
    oldest = page_history[-1] if page_history else None
    page_history.reverse()
    shown = page_history
    if include_pinned:
        shown += sorted(pinned, key=lambda item: chronology_key(item.date, item.amount_cents, item.id, item.source))
    projection = project_rows(db, shown, relationships=relationships, lookups=lookups)
    shown = [item[2] for item in projection.values()]
    for item in shown:
        item["running_balance_cents"] = projected_balances.get(item["id"])
    fill_tokens(db, projection, shown, lookups=lookups)
    return {
        "rows": shown,
        "all_count": len(all_rows),
        "active_count": active_count,
        "excluded_count": excluded_count,
        "filtered_count": len(filtered),
        "has_more": has_more,
        "next_before_date": oldest.date if oldest else None,
        "next_before_id": oldest.id if oldest else None,
        "next_before_order": chronology_rank(oldest.amount_cents, oldest.source) if oldest else None,
    }


def require_transaction(db: Session, identifier: int) -> Transaction:
    value = db.get(Transaction, identifier)
    if value is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    return value


def read_transaction(db: Session, transaction_id: int) -> dict:
    txn = require_transaction(db, transaction_id)
    if txn not in visible_rows(db, txn.account_id):
        raise AppError("transaction_not_found", "Transaction not found", 404)
    return row(db, txn)


MISSING_PENDING_GRACE_DAYS = 14


SOURCE_FIELDS = (
    "payee_source",
    "transfer_source",
    "description_source",
    "category_source",
    "memo_source",
    "flag_source",
)


def within_missing_pending_grace(
    txn: Transaction | _BalanceSource, now: datetime | None = None
) -> bool:
    removed_at = txn.plaid_removed_at
    if removed_at is not None and removed_at.tzinfo is not None:
        removed_at = removed_at.astimezone(timezone.utc).replace(tzinfo=None)
    now = now or datetime.now()
    if now.tzinfo is not None:
        now = now.astimezone(timezone.utc).replace(tzinfo=None)
    return (
        txn.status == "pending"
        and removed_at is not None
        and removed_at >= now - timedelta(days=MISSING_PENDING_GRACE_DAYS)
    )


def missing_pending(txn: Transaction | _BalanceSource, now: datetime | None = None) -> bool:
    return (
        txn.status == "pending"
        and txn.pending_replacement_id is not None
    ) or within_missing_pending_grace(txn, now)


def plaid_visible(txn: Transaction | _BalanceSource, now: datetime | None = None) -> bool:
    return txn.plaid_removed_at is None or missing_pending(txn, now)


def uses_plaid_workflow(session: Session, account_id: int) -> bool:
    return (
        session.scalar(
            select(PlaidAccountLink.id)
            .where(PlaidAccountLink.account_id == account_id)
            .limit(1)
        )
        is not None
    )


def active_match_for(session: Session, txn: Transaction) -> TransactionMatch | None:
    return session.scalar(
        select(TransactionMatch).where(
            TransactionMatch.state == "matched",
            or_(
                TransactionMatch.feed_transaction_id == txn.id,
                TransactionMatch.history_transaction_id == txn.id,
            ),
        )
    )


def active_matches_for(session: Session, transactions: list[Transaction]) -> dict[int, TransactionMatch]:
    relations = _stored_relationships(session, (row.id for row in transactions), ("matched",))
    return {
        identifier: relation
        for relation in relations
        for identifier in (relation.feed_transaction_id, relation.history_transaction_id)
    }
