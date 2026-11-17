import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import Account, Payee, PlaidAccountLink, Transaction, TransactionMatch
from app.services import payee_identity, ledger_projection, payees, transfer_links
from app.services import transaction_allocations as allocations
from app.services import transaction_matching as matching

PENDING_ROW_FIELDS = (
    "id", "account_id", "date", "description", "amount_cents",
    "status", "manually_cleared", "approved", "source", "plaid_txn_id",
    "plaid_raw", "feed_replacement_id", "plaid_removed_at", "pending_resolved", "pending_replacement_id", "payee_id", "transfer_account_id", "transfer_payee_confirmed",
    "category_id", "category_assigned", "memo", "flag", "transfer_partner_id",
)
PENDING_TRANSFER_FIELDS = (
    "id", "account_id", "transfer_account_id", "category_id", "category_assigned", "amount_cents",
    "manually_cleared", "transfer_partner_id",
)
PENDING_OWNER_FIELDS = (
    "id", "account_id", "date", "description", "payee_id", "transfer_account_id", "transfer_payee_confirmed",
    "category_id", "category_assigned", "memo", "amount_cents", "status",
    "manually_cleared", "approved", "flag", "transfer_partner_id",
)


def _pair(db: Session, pending_id: int, cleared_id: int | None = None):
    pending = db.get(Transaction, pending_id)
    if pending is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    if pending.source != "plaid" or pending.feed_replacement_id is not None or not ledger_projection.missing_pending(pending):
        raise AppError(
            "pending_lifecycle_not_available",
            "This transaction is not a missing pending Plaid row",
            422,
        )
    if cleared_id is None and pending.pending_replacement_id is not None:
        cleared_id = pending.pending_replacement_id
    if cleared_id is None:
        return pending, None
    cleared = db.get(Transaction, cleared_id)
    if cleared is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    if (
        cleared.id == pending.id
        or cleared.feed_replacement_id is not None
        or cleared.source != "plaid"
        or cleared.account_id != pending.account_id
        or cleared.status not in ("cleared", "reconciled")
        or not ledger_projection.plaid_visible(cleared)
    ):
        raise AppError(
            "pending_lifecycle_invalid_pair",
            "Choose a visible cleared or reconciled Plaid transaction in this account",
            422,
        )
    return pending, cleared


@dataclass(frozen=True)
class _CandidateGraph:
    posted: dict[int, Transaction]
    facts: dict[int, matching.MatchingFacts]
    evidence: dict[tuple[int, int], matching.MatchEvidence]
    pending_edges: dict[int, tuple[int, ...]]
    posted_edges: dict[int, tuple[int, ...]]


def _posted_available(row: Transaction) -> bool:
    from app.services import bank_continuity

    return (row.status in ("cleared", "reconciled") and not row.pending_resolved
            and row.feed_replacement_id is None and bank_continuity.available_bank_row(row, datetime.now()))


def _pending_competitor(row: Transaction, now: datetime) -> bool:
    from app.services import bank_continuity

    return row.status == "pending" and row.feed_replacement_id is None and bank_continuity.available_bank_row(row, now)


def _candidate_graph(
    db: Session,
    account_id: int,
    seeds: list[Transaction],
    now: datetime | None = None,
) -> _CandidateGraph:
    now = now or datetime.now()
    if not seeds:
        return _CandidateGraph({}, {}, {}, {}, {})
    amounts = {row.amount_cents for row in seeds}
    earliest = min(row.date for row in seeds) - timedelta(
        days=matching.SUGGESTION_DATE_TOLERANCE_DAYS * 2
    )
    latest = max(row.date for row in seeds) + timedelta(
        days=matching.SUGGESTION_DATE_TOLERANCE_DAYS * 2
    )
    rows = list(
        db.scalars(
            select(Transaction).where(
                Transaction.account_id == account_id,
                Transaction.source == "plaid",
                Transaction.amount_cents.in_(amounts),
                Transaction.date >= earliest,
                Transaction.date <= latest,
            )
        ).all()
    )
    by_id = {row.id: row for row in rows}
    by_id.update({row.id: row for row in seeds})
    claimed_posted_ids = set(
        db.scalars(
            select(Transaction.pending_replacement_id).where(
                Transaction.account_id == account_id,
                Transaction.source == "plaid",
                Transaction.status == "pending",
                Transaction.pending_replacement_id.is_not(None),
                Transaction.feed_replacement_id.is_(None),
                Transaction.provider_lifecycle_detached_at.is_(None),
            )
        ).all()
    )
    posted = {
        row.id: row
        for row in by_id.values()
        if _posted_available(row)
        and row.id not in claimed_posted_ids
    }
    pending = {
        row.id: row
        for row in by_id.values()
        if _pending_competitor(row, now)
    }
    relevant = {**posted, **pending}
    facts = {
        row.id: matching.matching_facts(
            row, ledger_projection.effective_facts(db, row)["payee_id"]
        )
        for row in relevant.values()
    }
    evidence = {}
    pending_edges = {row_id: [] for row_id in pending}
    posted_edges = {row_id: [] for row_id in posted}
    for pending_row in pending.values():
        for posted_row in posted.values():
            distance = matching.candidate_distance(
                facts[pending_row.id], facts[posted_row.id]
            )
            if (
                distance is None
                or distance > matching.SUGGESTION_DATE_TOLERANCE_DAYS
            ):
                continue
            pair = matching.candidate_evidence(
                facts[pending_row.id], facts[posted_row.id]
            )
            evidence[(pending_row.id, posted_row.id)] = pair
            pending_edges[pending_row.id].append(posted_row.id)
            posted_edges[posted_row.id].append(pending_row.id)
    return _CandidateGraph(
        posted=posted,
        facts=facts,
        evidence=evidence,
        pending_edges={key: tuple(value) for key, value in pending_edges.items()},
        posted_edges={key: tuple(value) for key, value in posted_edges.items()},
    )


def _recommend(db: Session, pending: Transaction) -> tuple[Transaction | None, str]:
    if pending.pending_replacement_id is not None:
        linked = db.get(Transaction, pending.pending_replacement_id)
        if linked is not None:
            return (
                linked,
                "Provider linked this pending transaction to the cleared transaction.",
            )
    graph = _candidate_graph(db, pending.account_id, [pending])
    candidates = graph.pending_edges.get(pending.id, ())
    if not candidates:
        return None, ""
    if len(candidates) > 1:
        return None, "More than one cleared transaction is a possible replacement."
    candidate_id = candidates[0]
    if len(graph.posted_edges[candidate_id]) > 1:
        return None, "Another pending transaction could also match this cleared transaction."
    resolver = payees.load_evaluator(db)
    evidence = matching.candidate_evidence(
        graph.facts[pending.id], graph.facts[candidate_id], resolver
    )
    return graph.posted[candidate_id], "; ".join(evidence.reasons) + "."


def _token(db: Session, pending: Transaction, cleared: Transaction | None) -> str:
    def snapshot(row: Transaction | None):
        if row is None:
            return None
        effective = ledger_projection.effective_facts(db, row)
        facts = ledger_projection.relationship_facts(db, row, effective)
        owner_rows = {owner.id: owner for owner in effective["owners"].values()}
        anchor = db.get(Transaction, facts["transfer"]["anchor_id"])
        partner = (
            db.get(Transaction, facts["transfer"]["partner_id"])
            if facts["transfer"]["partner_id"] is not None
            else None
        )
        relation_ids = {row.id, *owner_rows, anchor.id}
        if partner is not None:
            relation_ids.add(partner.id)
        relations = db.scalars(
            select(TransactionMatch)
            .where(
                (TransactionMatch.feed_transaction_id.in_(relation_ids))
                | (TransactionMatch.history_transaction_id.in_(relation_ids))
            )
            .order_by(TransactionMatch.id)
        ).all()
        destination = facts["transfer"]["destination"]
        return (
            {
                field: getattr(row, field)
                for field in PENDING_ROW_FIELDS
            }
            | {
                "effective": {
                    "payee_id": facts["effective"]["payee_id"],
                    "transfer_account_id": facts["effective"]["transfer_account_id"],
                    "category": facts["effective"]["category"],
                    "memo": facts["effective"]["memo"],
                    "flag": facts["effective"]["flag"],
                    "owners": {
                        field: facts["owners"][field] for field in effective["owners"]
                    },
                    "owner_facts": {
                        identifier: {
                            field: getattr(owner, field)
                            for field in PENDING_OWNER_FIELDS
                        }
                        | {
                            "allocations": allocations.snapshot(
                                owner,
                                allocations.load(db, [owner.id])[owner.id],
                            )
                        }
                        for identifier, owner in owner_rows.items()
                    },
                }
            }
            | {
                "anchor": {
                    field: getattr(anchor, field)
                    for field in PENDING_TRANSFER_FIELDS
                },
                "partner": (
                    {
                        field: getattr(partner, field)
                        for field in PENDING_TRANSFER_FIELDS
                    }
                    if partner is not None
                    else None
                ),
                "target": (
                    {"id": destination[0], "name": destination[1], "closed": destination[2]}
                    if destination is not None
                    else None
                ),
            }
            | {
                "relations": [
                    ledger_projection.match_relation_facts(relation)
                    for relation in relations
                ]
            }
        )

    return hashlib.sha256(
        json.dumps(
            {"pending": snapshot(pending), "cleared": snapshot(cleared)},
            default=str,
            sort_keys=True,
        ).encode()
    ).hexdigest()


def transfer_policy(
    db: Session, pending: Transaction, cleared: Transaction | None
) -> dict:
    pending_effective = ledger_projection.effective_facts(db, pending)
    if cleared is None:
        return {
            "transfer": False,
            "owner": None,
            "targets_conflict": False,
            "blocking_reason": None,
            "blocking_code": None,
            "blocking_status": None,
            "pending_effective": pending_effective,
            "cleared_effective": None,
        }
    cleared_effective = ledger_projection.effective_facts(db, cleared)
    pending_payee = db.get(Payee, pending_effective["payee_id"])
    cleared_payee = db.get(Payee, cleared_effective["payee_id"])
    preferred_payee = "cleared" if pending_payee.kind in ("unknown", "starting_balance") and cleared_payee.kind in ("ordinary", "myself") else "pending"
    facts = payee_identity.combination_facts(db, pending_effective, cleared_effective)
    transfer = facts["has_transfer"]
    pending_anchor = pending_effective["relationship"].anchor
    cleared_anchor = cleared_effective["relationship"].anchor
    owner = "pending" if pending_anchor.transfer_partner_id is not None else "cleared" if cleared_anchor.transfer_partner_id is not None else None
    result = {
        "transfer": transfer,
        "owner": owner if transfer else None,
        "targets_conflict": facts["targets_conflict"],
        "blocking_reason": None,
        "blocking_code": None,
        "blocking_status": None,
        "pending_effective": pending_effective,
        "cleared_effective": cleared_effective,
        "preferred_payee": preferred_payee,
    }
    if not transfer:
        return result
    if facts["has_split"]:
        result.update(
            blocking_reason="Split transactions cannot be resolved with a transfer.",
            blocking_code="lifecycle_transfer_split",
            blocking_status=422,
        )
    else:
        if (
            pending_anchor.transfer_partner_id is not None
            and cleared_anchor.transfer_partner_id is not None
            and pending_anchor.transfer_partner_id != cleared_anchor.transfer_partner_id
        ):
            result.update(
                blocking_reason="The transfer partners conflict.",
                blocking_code="lifecycle_transfer_partner_conflict",
                blocking_status=409,
            )
        for source, anchor, effective in (("pending", pending_anchor, pending_effective), ("cleared", cleared_anchor, cleared_effective)):
            if anchor.transfer_partner_id is not None:
                partner = db.get(Transaction, anchor.transfer_partner_id)
                if partner is None or effective["transfer_account_id"] != partner.account_id:
                    result.update(blocking_reason="The transfer target must match its linked partner.", blocking_code="lifecycle_transfer_target_conflict", blocking_status=409)
    return result


def require_transfer_policy(policy: dict) -> None:
    if policy["blocking_code"] is not None:
        raise AppError(
            policy["blocking_code"],
            policy["blocking_reason"],
            policy["blocking_status"],
        )


def disappearance_message(db: Session, pending: Transaction) -> str:
    anchor = ledger_projection.transfer_anchor(db, pending)
    if pending.transfer_partner_id is not None:
        return (
            "This removes the missing pending transaction and unlinks the other "
            "account's transfer."
        )
    if anchor.id != pending.id and anchor.transfer_partner_id is not None:
        return (
            "This removes the missing pending bank transaction. The surviving "
            "manual transfer remains linked."
        )
    return "This removes the missing pending transaction."


def default_selections(policy: dict):
    pending_effective = policy["pending_effective"]
    if policy["cleared_effective"] is None:
        return {"payee": "pending", "transfer": "pending", "category": "pending", "memo": "pending", "flag": "pending"}
    cleared_effective = policy["cleared_effective"]
    if policy["transfer"]:
        owner = policy["owner"] or ("pending" if pending_effective["transfer_account_id"] is not None else "cleared")
        return {"payee": policy["preferred_payee"], "transfer": owner, "category": "pending" if pending_effective["category"]["category_assigned"] or pending_effective["category"]["allocations"] else "cleared", "memo": "pending" if pending_effective["memo"] else "cleared", "flag": "pending" if pending_effective["flag"] is not None else "cleared"}
    return {
        "payee": policy["preferred_payee"],
        "transfer": "pending" if pending_effective["transfer_account_id"] is not None else "cleared",
        "category": "pending" if pending_effective["category"]["category_assigned"] else "cleared",
        "memo": "pending" if pending_effective["memo"] else "cleared",
        "flag": "pending" if pending_effective["flag"] is not None else "cleared",
    }


def account_inference_ready(db: Session, account_id: int) -> bool:
    account = db.get(Account, account_id)
    if account is None or account.plaid_history_imported_at is None:
        return False
    return (
        db.scalar(
            select(PlaidAccountLink.id)
            .where(PlaidAccountLink.account_id == account_id)
            .limit(1)
        )
        is not None
    )


def reconcile_inferred(db: Session, account_ids: set[int]) -> int:
    from app.services import bank_continuity

    return bank_continuity.reconcile(db, account_ids)


def _resolve(
    db: Session,
    pending_id: int,
    cleared_id: int,
    token: str,
    selections: dict[str, str],
    row_edits=None,
) -> Transaction:
    pending, cleared = _pair(db, pending_id, cleared_id)
    if _token(db, pending, cleared) != token:
        raise AppError(
            "lifecycle_context_stale",
            "The pending lifecycle context changed. Reopen it and review again.",
            409,
        )
    if any(
        selections.get(field) not in ("pending", "cleared")
        for field in ("payee_source", "transfer_source", "category_source", "memo_source", "flag_source")
    ):
        raise AppError(
            "invalid_lifecycle_source",
            "Each editable field must select pending or cleared",
            422,
        )
    policy = transfer_policy(db, pending, cleared)
    require_transfer_policy(policy)
    pending_effective = policy["pending_effective"]
    cleared_effective = policy["cleared_effective"]

    if policy["owner"] is not None:
        owner = policy["owner"]
        if selections["transfer_source"] != owner:
            raise AppError("lifecycle_transfer_fields_fixed", "Transfer target choice is fixed.", 422)
    from app.services import bank_continuity

    values = row_edits.model_dump(exclude_unset=True) if row_edits is not None else {}
    for field in values:
        name = "payee" if field == "payee_id" else "category" if field == "category_id" else field
        if selections[f"{name}_source"] != "cleared":
            raise AppError("lifecycle_edit_source", "An edited field must use Cleared.", 422)
    if "category_id" in values and (pending_effective["category"]["allocations"] or cleared_effective["category"]["allocations"]):
        raise AppError("lifecycle_split_edit", "Edit the split breakdown in the ledger after resolution.", 422)
    return bank_continuity.associate(db, pending, cleared, "explicit", selections)


def resolve(
    db: Session,
    pending_id: int,
    cleared_id: int,
    token: str,
    selections: dict[str, str],
    row_edits=None,
) -> Transaction:
    transaction = _resolve(db, pending_id, cleared_id, token, selections, row_edits)
    db.flush()
    reconcile_inferred(db, {transaction.account_id})
    db.flush()
    matching.reconcile(db, {transaction.account_id}, allow_automatic=True, expire_stale=True, transaction_ids={transaction.id})
    from app.services import ledger

    ledger.apply_comparison_edits(db, transaction, row_edits)
    transaction.approved = True
    db.flush()
    return transaction


def disappear(
    db: Session, pending_id: int, token: str, cleared_id: int | None = None
) -> None:
    pending, cleared = _pair(db, pending_id, cleared_id)
    candidate = cleared or _recommend(db, pending)[0]
    if _token(db, pending, candidate) != token:
        raise AppError(
            "lifecycle_context_stale",
            "The pending lifecycle context changed. Reopen it and review again.",
            409,
        )

    for relation in db.scalars(
        select(TransactionMatch).where(
            (TransactionMatch.feed_transaction_id == pending.id)
            | (TransactionMatch.history_transaction_id == pending.id)
        )
    ).all():
        db.delete(relation)
    if pending.transfer_partner_id is not None:
        transfer_links.unlink(db, pending)
    account_id = pending.account_id
    db.delete(pending)
    db.flush()
    reconcile_inferred(db, {account_id})
    db.flush()
    matching.reconcile(db, {account_id}, allow_automatic=True, expire_stale=True, transaction_ids={cleared.id} if cleared else set())
    db.flush()


def read_context(
    db: Session,
    pending_transaction_id: int,
    cleared_transaction_id: int | None = None,
) -> dict:
    pending, cleared = _pair(db, pending_transaction_id, cleared_transaction_id)
    rationale = ""
    if cleared is None:
        cleared, rationale = _recommend(db, pending)
    plaid_ids = [pending.id]
    if cleared is not None:
        plaid_ids.append(cleared.id)
    relationships = ledger_projection.resolve_relationships(db, [pending] + ([cleared] if cleared else []))
    displayed_relations = [
        relationships[plaid_id].relation
        for plaid_id in plaid_ids
        if relationships[plaid_id].relation is not None
    ]
    pending_row = ledger_projection.row(db, pending)
    cleared_row = ledger_projection.row(db, cleared) if cleared else None
    policy = transfer_policy(db, pending, cleared)
    defaults = default_selections(policy)
    return {
        "fixed_fields": ["transfer"] if policy["owner"] is not None else [],
        "blocking_reason": policy["blocking_reason"],
        "disappearance_message": disappearance_message(db, pending),
        "pending": pending_row,
        "cleared": cleared_row,
        "rationale": rationale,
        "context_token": _token(db, pending, cleared),
        "selections": defaults,
        "history_relations": [
            {
                "id": relation.id,
                "context_token": matching.context_token(db, relation.feed_transaction, relation.history_transaction),
                "state": relation.state,
                "feed_transaction_id": relation.feed_transaction_id,
                "history": ledger_projection.row(db, relation.history_transaction),
            }
            for relation in displayed_relations
        ],
    }
