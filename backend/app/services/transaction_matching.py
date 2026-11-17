import hashlib
import json
from collections import Counter
from dataclasses import dataclass
from datetime import date
from itertools import batched

from sqlalchemy import exists, func, or_, select
from sqlalchemy.orm import Session, contains_eager

from app.db import SQL_ID_BATCH_SIZE
from app.errors import AppError
from app.models import Account, BankContinuity, Payee, Transaction, TransactionMatch
from app.schemas import TransactionMatchContext, TransactionMatchCreate
from app.services import (
    candidate_paging,
    payee_identity,
    ledger_history,
    ledger_projection,
    transfer_links,
)
from app.services import transaction_allocations as allocations
from app.services.ledger_history import record_lifecycle

AUTOMATIC_DATE_TOLERANCE_DAYS = 6
SUGGESTION_DATE_TOLERANCE_DAYS = 7


@dataclass(frozen=True)
class MatchingFacts:
    id: int
    account_id: int
    date: date
    amount_cents: int
    payee_id: int | None
    description: str
    merchant_name: str | None


@dataclass(frozen=True)
class MatchEvidence:
    date_distance: int
    saved_payee_state: str
    reasons: tuple[str, ...]


def matching_facts(
    transaction: Transaction,
    saved_payee_id: int | None,
) -> MatchingFacts:
    raw = transaction.plaid_raw if isinstance(transaction.plaid_raw, dict) else {}
    merchant_name = raw.get("merchant_name")
    return MatchingFacts(
        id=transaction.id,
        account_id=transaction.account_id,
        date=transaction.date,
        amount_cents=transaction.amount_cents,
        payee_id=saved_payee_id,
        description=transaction.description,
        merchant_name=(
            merchant_name.strip()
            if isinstance(merchant_name, str) and merchant_name.strip()
            else None
        ),
    )


def candidate_evidence(
    left: MatchingFacts,
    right: MatchingFacts,
    resolver=None,
    *,
    allow_amount_difference: bool = False,
) -> MatchEvidence | None:
    distance = candidate_distance(left, right, allow_amount_difference=allow_amount_difference)
    if distance is None:
        return None
    if left.payee_id is not None and right.payee_id is not None:
        saved_payee_state = "same" if left.payee_id == right.payee_id else "conflict"
    else:
        saved_payee_state = "unresolved"
    rule_agreement = False
    rule_evidence_unavailable = False
    if resolver is not None and saved_payee_state != "same":
        from app.services.payees import RuleEvaluationError

        try:
            left_resolution = resolver.resolve(left.account_id, left.amount_cents, left.description, left.merchant_name)
            right_resolution = resolver.resolve(right.account_id, right.amount_cents, right.description, right.merchant_name)
            rule_agreement = (
                left_resolution["payee_id"] is not None
                and left_resolution["payee_id"] == right_resolution["payee_id"]
            )
        except RuleEvaluationError:
            rule_evidence_unavailable = True
    reasons = ["Within scheduled +/- Match" if left.amount_cents != right.amount_cents else "Exact amount", f"dates are {distance} days apart"]
    if saved_payee_state == "same":
        reasons.append("matching saved payee")
    elif saved_payee_state == "conflict":
        reasons.append("saved payees conflict")
    else:
        reasons.append("saved payee is unresolved")
    if rule_agreement:
        reasons.append("current payee rules suggest the same payee")
    if rule_evidence_unavailable:
        reasons.append("current payee rule evidence is unavailable; review the rules in Payees")
    return MatchEvidence(
        date_distance=distance,
        saved_payee_state=saved_payee_state,
        reasons=tuple(reasons),
    )


def candidate_distance(
    left: MatchingFacts,
    right: MatchingFacts,
    *,
    allow_amount_difference: bool = False,
) -> int | None:
    if (
        left.account_id != right.account_id
        or (left.amount_cents != right.amount_cents and not allow_amount_difference)
    ):
        return None
    return abs((left.date - right.date).days)


def amounts_match(session: Session, bank: Transaction, plan: Transaction, *, facts: dict[int, dict] | None = None) -> bool:
    if bank.amount_cents == plan.amount_cents:
        return True
    if (
        bank.source != "plaid" or plan.source != "manual"
        or bank.feed_historical_at is not None or plan.feed_historical_at is not None
        or plan.match_tolerance_cents <= 0
        or bank.amount_cents * plan.amount_cents <= 0
        or abs(bank.amount_cents - plan.amount_cents) > plan.match_tolerance_cents
    ):
        return False
    facts = facts if facts is not None else {}
    for transaction in (bank, plan):
        if transaction.id not in facts:
            facts[transaction.id] = ledger_projection.effective_facts(session, transaction)
    bank_facts, plan_facts = facts[bank.id], facts[plan.id]
    if (
        bank_facts["payee_id"] != plan_facts["payee_id"]
        or bank_facts["transfer_account_id"] not in (None, plan_facts["transfer_account_id"])
        or bank.transfer_partner_id is not None
        or (plan.transfer_partner_id is not None and ledger_projection.amount_partner(session, plan) is None)
    ):
        return False
    payee = session.get(Payee, plan_facts["payee_id"])
    return payee is not None and payee.kind in ("ordinary", "myself")


def default_sources(db: Session, planned: Transaction) -> dict[str, str]:


    return default_sources_from_facts(ledger_projection.effective_facts(db, planned))


def default_sources_from_facts(facts: dict) -> dict[str, str]:
    category = facts["category"]
    return {
        "payee_source": "history",
        "transfer_source": "history" if facts["transfer_account_id"] is not None else "feed",
        "description_source": "feed",
        "category_source": "history" if category["category_assigned"] or category["allocations"] else "feed",
        "memo_source": "history" if facts["memo"] else "feed",
        "flag_source": "history" if facts["flag"] is not None else "feed",
    }


def _unique_closest_keys(edges: list[dict], endpoint: str) -> set[str]:
    groups = {}
    for edge in edges:
        groups.setdefault(edge[endpoint], []).append(edge)
    selected = set()
    for group in groups.values():
        distance = min(edge["distance"] for edge in group)
        closest = [edge for edge in group if edge["distance"] == distance]
        if len(closest) == 1:
            selected.add(closest[0]["key"])
    return selected


def mutual_closest_edge_keys(edges: list[dict]) -> set[str]:
    return _unique_closest_keys(edges, "feed_id") & _unique_closest_keys(edges, "history_id")


def deterministic_edge_keys(edges: list[dict]) -> set[str]:
    remaining = [edge for edge in edges if edge["automatic_eligible"]]
    selected: set[str] = set()
    while remaining:
        unique = mutual_closest_edge_keys(remaining)
        candidates = [edge for edge in remaining if edge["key"] in unique]
        if not candidates:
            break
        selected.update(unique)
        used_feed = {edge["feed_id"] for edge in candidates}
        used_history = {edge["history_id"] for edge in candidates}
        remaining = [
            edge for edge in remaining
            if edge["feed_id"] not in used_feed and edge["history_id"] not in used_history
        ]
    return selected


@dataclass(frozen=True)
class Decision:
    outcome: str


def _eligible(
    session: Session, account_id: int
) -> list[tuple[Transaction, Transaction, MatchEvidence]]:


    active_planned = exists(
        select(TransactionMatch.id).where(
            TransactionMatch.state == "matched",
            TransactionMatch.history_transaction_id == Transaction.id,
        )
    )
    active_plaid = exists(
        select(TransactionMatch.id).where(
            TransactionMatch.state == "matched",
            TransactionMatch.feed_transaction_id == Transaction.id,
        )
    )
    planned = list(
        session.scalars(
            select(Transaction).where(
                Transaction.account_id == account_id,
                Transaction.source == "manual",
                Transaction.feed_historical_at.is_(None),
                ~active_planned,
            )
        ).all()
    )
    plaid = list(
        session.scalars(
            select(Transaction).where(
                Transaction.account_id == account_id,
                Transaction.source == "plaid",
                Transaction.feed_historical_at.is_(None),
                ~active_plaid,
            )
        ).all()
    )
    plaid_facts = {row.id: matching_facts(row, row.payee_id) for row in plaid}
    planned_facts = {row.id: matching_facts(row, row.payee_id) for row in planned}
    planned_by_amount: dict[int, list[Transaction]] = {}
    tolerant = [plan for plan in planned if plan.match_tolerance_cents > 0]
    effective = {}
    for plan in planned:
        planned_by_amount.setdefault(plan.amount_cents, []).append(plan)
    pairs = []
    for bank in plaid:
        if not ledger_projection.source_visible(bank) or ledger_projection.missing_pending(bank):
            continue
        candidates = [*planned_by_amount.get(bank.amount_cents, []), *(plan for plan in tolerant if plan.amount_cents != bank.amount_cents)]
        for plan in candidates:
            distance = candidate_distance(
                plaid_facts[bank.id], planned_facts[plan.id], allow_amount_difference=True
            )
            if distance is None or distance > SUGGESTION_DATE_TOLERANCE_DAYS or not amounts_match(session, bank, plan, facts=effective):
                continue
            bank_evidence, plan_evidence = plaid_facts[bank.id], planned_facts[plan.id]
            if bank.amount_cents != plan.amount_cents:
                bank_evidence = matching_facts(bank, effective[bank.id]["payee_id"])
                plan_evidence = matching_facts(plan, effective[plan.id]["payee_id"])
            evidence = candidate_evidence(bank_evidence, plan_evidence, allow_amount_difference=True)
            pairs.append((bank, plan, evidence))
    return pairs


def _pair(
    session: Session, plaid: Transaction, planned: Transaction
) -> TransactionMatch:
    relation = session.scalar(
        select(TransactionMatch).where(
            TransactionMatch.feed_transaction_id == plaid.id,
            TransactionMatch.history_transaction_id == planned.id,
        )
    )
    if relation is None:
        relation = TransactionMatch(
            feed_transaction=plaid, history_transaction=planned
        )
        session.add(relation)
        session.flush()
    return relation


def transfer_match_policy(
    session: Session,
    feed_facts: dict,
    history_facts: dict,
    feed_partner_id: int | None,
    history_partner_id: int | None,
) -> dict:
    facts = payee_identity.combination_facts(session, feed_facts, history_facts)
    if not facts["has_transfer"]:
        return {"has_transfer": False, "fixed_owner": None, "targets_conflict": False}
    if facts["has_split"]:
        raise AppError("transfer_match_split", "Split transactions cannot be combined with a transfer.", 422)
    if feed_partner_id is not None and history_partner_id is not None:
        raise AppError("transfer_match_partner_conflict", "Both transactions already have transfer partners.", 409)
    owner = None
    if feed_partner_id is not None and history_partner_id is None:
        owner = "feed"
    if history_partner_id is not None and feed_partner_id is None:
        owner = "history"
    partner_id = feed_partner_id if owner == "feed" else history_partner_id if owner == "history" else None
    if partner_id is not None:
        partner = session.get(Transaction, partner_id)
        chosen = feed_facts if owner == "feed" else history_facts
        if partner is None or chosen["transfer_account_id"] != partner.account_id:
            raise AppError("transfer_match_target_conflict", "The transfer target must match its linked partner.", 409)
    return {"has_transfer": True, "fixed_owner": owner, "targets_conflict": facts["targets_conflict"]}


def transfer_fixed_owner(session: Session, plaid: Transaction, planned: Transaction) -> str | None:


    plaid_facts, planned_facts = ledger_projection.effective_facts(session, plaid), ledger_projection.effective_facts(session, planned)
    plaid_anchor = plaid_facts["relationship"].anchor
    planned_anchor = planned_facts["relationship"].anchor
    feed_partner_id, history_partner_id = plaid_anchor.transfer_partner_id, planned_anchor.transfer_partner_id
    if plaid_anchor.id == planned_anchor.id:
        if plaid_anchor.id == plaid.id:
            history_partner_id = None
        else:
            feed_partner_id = None
    policy = transfer_match_policy(
        session,
        plaid_facts,
        planned_facts,
        feed_partner_id,
        history_partner_id,
    )
    relation = plaid_facts["relationship"].relation
    if (
        policy["has_transfer"]
        and feed_partner_id is None
        and history_partner_id is None
        and relation is not None
        and relation.state == "matched"
        and relation.feed_transaction_id == plaid.id
        and relation.history_transaction_id == planned.id
        and relation.transfer_source in ("feed", "history")
    ):
        return relation.transfer_source
    return policy["fixed_owner"]


def context_token(session: Session, plaid: Transaction, planned: Transaction) -> str:


    relation = session.scalar(select(TransactionMatch).where(TransactionMatch.feed_transaction_id == plaid.id, TransactionMatch.history_transaction_id == planned.id))
    fields = ("id", "account_id", "date", "description", "amount_cents", "match_tolerance_cents", "payee_id", "transfer_account_id", "transfer_payee_confirmed", "category_id", "category_assigned", "memo", "flag", "transfer_partner_id", "status", "manually_cleared", "approved", "plaid_raw", "plaid_removed_at", "plaid_excluded_at", "plaid_excluded_amount_cents", "source", "plaid_txn_id", "feed_historical_at", "provider_lifecycle_detached_at", "feed_replacement_id", "pending_replacement_id")

    def snapshot(row: Transaction):
        facts = ledger_projection.relationship_facts(session, row)
        active = ledger_projection.active_match_for(session, row)
        retained_description = active.history_transaction.description if active and active.feed_transaction_id == row.id else row.description
        partner_id = facts["transfer"]["partner_id"]
        partner = session.get(Transaction, partner_id) if partner_id else None
        return {
            "row": {field: getattr(row, field) for field in fields},
            "active_relation": facts["relation"],
            "retained_description": retained_description,
            "effective": {
                **{name: facts["effective"][name] for name in ("payee_id", "transfer_account_id", "category", "memo", "flag")},
                "owners": {name: facts["owners"][name] for name in ("payee", "transfer", "category", "memo", "flag")},
            },
            "transfer": {
                "anchor_id": facts["transfer"]["anchor_id"],
                "partner": {field: getattr(partner, field) for field in fields} if partner else None,
                "destination": facts["transfer"]["destination"],
            },
        }

    value = {"feed": snapshot(plaid), "history": snapshot(planned), "relation": ledger_projection.match_relation_facts(relation)}
    return hashlib.sha256(json.dumps(value, default=str, sort_keys=True).encode()).hexdigest()


def _dismissed_pairs(session: Session, account_id: int) -> dict:
    relations = session.scalars(select(TransactionMatch).join(
        Transaction, TransactionMatch.feed_transaction_id == Transaction.id,
    ).where(Transaction.account_id == account_id, TransactionMatch.state == "dismissed")).all()
    associations = session.scalars(select(BankContinuity).join(
        Transaction, BankContinuity.source_transaction_id == Transaction.id,
    ).where(Transaction.account_id == account_id, BankContinuity.state == "active")).all()
    neighbors = {}
    for record in associations:
        neighbors.setdefault(record.source_transaction_id, set()).add(record.target_transaction_id)
        neighbors.setdefault(record.target_transaction_id, set()).add(record.source_transaction_id)
    result = {}
    for relation in relations:
        members = {relation.feed_transaction_id}
        for _ in range(2):
            members.update(other for identifier in tuple(members) for other in neighbors.get(identifier, ()))
        for identifier in members:
            key = (identifier, relation.history_transaction_id)
            if key not in result or relation.matched_by is not None:
                result[key] = relation
    return result


def match_context(session: Session, plaid: Transaction, planned: Transaction, relation: TransactionMatch | None = None) -> TransactionMatchContext:


    relation = relation or session.scalar(select(TransactionMatch).where(
        TransactionMatch.feed_transaction_id == plaid.id,
        TransactionMatch.history_transaction_id == planned.id,
    ))
    try:
        owner = transfer_fixed_owner(session, plaid, planned)
        blocking_reason = None
    except AppError as error:
        owner, blocking_reason = None, error.message
    defaults = default_sources(session, planned)
    selections = {
        field.removesuffix("_source"): (getattr(relation, field, None) or defaults[field])
        for field in ledger_projection.SOURCE_FIELDS
    }
    if owner is not None:
        selections["transfer"] = owner
    from app.services import transfers

    representative = ledger_projection.current_representative(session, plaid) or plaid
    token = context_token(session, plaid, planned)
    return TransactionMatchContext(
        representative=ledger_projection.row(session, representative),
        transfer=transfers.inspect_relationship(session, representative),
        unmatch_action={
            "kind": "match", "id": relation.id,
            "source_id": plaid.id, "target_id": planned.id,
            "source_label": transfers.relationship_label(plaid), "target_label": "Manual" if planned.source == "manual" else "Yours",
            "context_token": token,
            "evidence": "Automatically matched bank and manual entries." if relation.matched_by == "automatic" else "You matched these entries.",
            "consequence": (
                "This separates the entries and preserves their own fields, clearance and transfer connections. "
                + ("The manual entry will not automatically match again until a later successful Plaid sync. " if planned.source == "manual" else "")
                + "This pair remains rejected unless you explicitly match it."
            ),
        } if relation and relation.state == "matched" else None,
        context_token=token,
        fixed_fields=["transfer"] if owner is not None else [],
        blocking_reason=blocking_reason,
        id=relation.id if relation else None,
        selections=selections,
        feed=ledger_projection.source_row(session, plaid),
        history=history_comparison_row(session, planned) if not relation or relation.state != "matched" else ledger_projection.source_row(session, planned),
        rationale=(
            "This accepted match presents Plaid date, amount, status, and source."
            + (" " + tolerance_rationale(plaid, planned) if plaid.amount_cents != planned.amount_cents else "")
            if relation and relation.state == "matched"
            else matching_rationale(session, plaid, planned)
        ),
    )


def provider_transfer_evidence(bank: Transaction, account_types: tuple[str, str]) -> bool:
    raw = bank.plaid_raw or {}
    pfc = raw.get("personal_finance_category") if isinstance(raw, dict) else None
    if not isinstance(pfc, dict):
        return False
    primary, detailed = pfc.get("primary"), pfc.get("detailed")
    inbound = {"TRANSFER_IN_ACCOUNT_TRANSFER", "TRANSFER_IN_SAVINGS", "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS"}
    outbound = {"TRANSFER_OUT_ACCOUNT_TRANSFER", "TRANSFER_OUT_SAVINGS", "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS"}
    if bank.amount_cents > 0 and primary == "TRANSFER_IN" and detailed in inbound:
        return True
    if bank.amount_cents < 0 and primary == "TRANSFER_OUT" and detailed in outbound:
        return True
    if primary != "LOAN_PAYMENTS" or detailed != "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT":
        return False
    return "credit" in account_types


def _handoff_planned_clearance(bank: Transaction, planned: Transaction) -> None:
    if planned.source == "manual" and planned.feed_historical_at is None and planned.status == "cleared":
        planned.status = "uncleared"
        if bank.status == "pending":
            bank.manually_cleared = True


def reconcile(
    session: Session,
    account_ids: set[int],
    *,
    allow_automatic: bool,
    expire_stale: bool,
    discover_transfers: bool = True,
    transaction_ids: set[int] | None = None,
    release_unmatch_holds: bool = False,
) -> list[Decision]:
    decisions: list[Decision] = []
    mirrored: list[Transaction] = []
    # Dismissed accepted matches hold their manual entry until provider sync clears the acceptance origin.
    if release_unmatch_holds:
        for batch in batched(account_ids, SQL_ID_BATCH_SIZE):
            for relation in session.scalars(select(TransactionMatch).join(
                Transaction, TransactionMatch.feed_transaction_id == Transaction.id,
            ).where(Transaction.account_id.in_(batch), TransactionMatch.state == "dismissed", TransactionMatch.matched_by.is_not(None))).all():
                relation.matched_by = None
        session.flush()
    if expire_stale:
        expire_stale_matches(session, account_ids=account_ids)
    for account_id in account_ids:
        pairs = _eligible(session, account_id)
        dismissed = _dismissed_pairs(session, account_id)
        held = {relation.history_transaction_id for relation in dismissed.values() if relation.matched_by is not None}
        edge_keys = deterministic_edge_keys([
            {
                "key": f"{bank.id}:{plan.id}",
                "feed_id": bank.id,
                "history_id": plan.id,
                "distance": evidence.date_distance,
                "automatic_eligible": (bank.id, plan.id) not in dismissed,
            }
            for bank, plan, evidence in pairs
            if bank.amount_cents == plan.amount_cents
        ])
        exact = [(bank, plan) for bank, plan, _ in pairs if bank.amount_cents == plan.amount_cents and (bank.id, plan.id) not in dismissed]
        exact_banks, exact_plans = {bank.id for bank, _ in exact}, {plan.id for _, plan in exact}
        tolerant = [(bank, plan) for bank, plan, _ in pairs if bank.amount_cents != plan.amount_cents and (bank.id, plan.id) not in dismissed]
        tolerant_counts = Counter(bank.id for bank, _ in tolerant)
        tolerant_peers = Counter(plan.id for _, plan in tolerant)
        edge_keys.update(
            f"{bank.id}:{plan.id}" for bank, plan in tolerant
            if bank.id not in exact_banks and plan.id not in exact_plans
            and tolerant_counts[bank.id] == 1 and tolerant_peers[plan.id] == 1
        )
        candidate_counts = Counter(bank.id for bank, plan, _ in pairs if bank.amount_cents == plan.amount_cents)
        peer_counts = Counter(plan.id for bank, plan, _ in pairs if bank.amount_cents == plan.amount_cents)
        for bank, plan, evidence in pairs:
            count = candidate_counts[bank.id] if bank.amount_cents == plan.amount_cents else tolerant_counts[bank.id]
            peers = peer_counts[plan.id] if bank.amount_cents == plan.amount_cents else tolerant_peers[plan.id]
            reason = None
            if (bank.id, plan.id) in dismissed:
                reason = "negative_decision"
            elif f"{bank.id}:{plan.id}" not in edge_keys:
                if bank.amount_cents == plan.amount_cents:
                    reason = "not_mutual_closest"
                elif bank.id in exact_banks or plan.id in exact_plans:
                    reason = "exact_candidate"
                else:
                    reason = "tolerant_ambiguity"
            if reason is not None:
                record_lifecycle(session, "manual_matching", "blocked", reason, account_id=account_id, transaction_id=bank.id, candidate_id=plan.id, date_distance=evidence.date_distance, candidate_count=count, peer_count=peers, amount_equal=bank.amount_cents == plan.amount_cents)
        unique = [
            (bank, plan, evidence)
            for bank, plan, evidence in pairs
            if f"{bank.id}:{plan.id}" in edge_keys
        ]
        for bank, plan, evidence in unique:
            count = candidate_counts[bank.id] if bank.amount_cents == plan.amount_cents else tolerant_counts[bank.id]
            peers = peer_counts[plan.id] if bank.amount_cents == plan.amount_cents else tolerant_peers[plan.id]
            relation = session.scalar(
                select(TransactionMatch).where(
                    TransactionMatch.feed_transaction_id == bank.id,
                    TransactionMatch.history_transaction_id == plan.id,
                )
            )
            created = relation is None
            relation = relation or _pair(session, bank, plan)
            if relation.state == "dismissed":
                continue
            transfer_valid = True
            try:
                fixed_owner = transfer_fixed_owner(session, bank, plan)
                if payee_identity.combination_facts(session, ledger_projection.effective_facts(session, bank), ledger_projection.effective_facts(session, plan))["targets_conflict"]:
                    transfer_valid = False
            except AppError:
                transfer_valid = False
                fixed_owner = None
            if (
                allow_automatic
                and plan.id not in held
                and evidence.date_distance <= AUTOMATIC_DATE_TOLERANCE_DAYS
                and transfer_valid
            ):
                relation.state, relation.matched_by = "matched", "automatic"
                sources = default_sources(session, plan)
                if fixed_owner is not None:
                    sources["transfer_source"] = fixed_owner
                for field, source in sources.items():
                    setattr(relation, field, source)
                clearance_handoff = plan.source == "manual" and plan.feed_historical_at is None and plan.status == "cleared"
                _handoff_planned_clearance(bank, plan)
                bank.approved = plan.approved
                if bank.amount_cents != plan.amount_cents:
                    mirrored.extend(filter(None, [_mirror_partner(session, plan, bank.amount_cents)]))
                    session.flush()
                    bank_amount_changed(session, bank, plan.amount_cents)
                    sources["category_source"] = relation.category_source
                decisions.append(Decision("automatic"))
                record_lifecycle(session, "manual_matching", "matched", "mutual_closest" if bank.amount_cents == plan.amount_cents else "schedule_tolerance", account_id=account_id, transaction_id=bank.id, candidate_id=plan.id, relationship_id=relation.id, date_distance=evidence.date_distance, candidate_count=count, peer_count=peers, amount_equal=bank.amount_cents == plan.amount_cents, clearance_handoff=clearance_handoff, **sources)
            elif created or relation.state != "suggested":
                relation.state, relation.matched_by = "suggested", None
                decisions.append(Decision("suggested"))
                record_lifecycle(session, "manual_matching", "suggested", "unmatch_hold" if plan.id in held else "transfer_conflict" if not transfer_valid else "date_window" if evidence.date_distance > AUTOMATIC_DATE_TOLERANCE_DAYS else "manual_review", account_id=account_id, transaction_id=bank.id, candidate_id=plan.id, relationship_id=relation.id, date_distance=evidence.date_distance, candidate_count=count, peer_count=peers, amount_equal=bank.amount_cents == plan.amount_cents)
        for relation in session.scalars(
            select(TransactionMatch)
            .join(Transaction, TransactionMatch.feed_transaction_id == Transaction.id)
            .where(
                Transaction.account_id == account_id,
                TransactionMatch.state == "suggested",
            )
        ).all():
            if (relation.feed_transaction_id, relation.history_transaction_id) not in {
                (a.id, b.id) for a, b, _evidence in unique
            }:
                session.delete(relation)
    if mirrored:
        session.flush()
        decisions += reconcile(session, {row.account_id for row in mirrored}, allow_automatic=allow_automatic, expire_stale=expire_stale, discover_transfers=False, transaction_ids={row.id for row in mirrored})
    if allow_automatic and discover_transfers:
        from app.services import transfers

        session.flush()
        transfers.reconcile_automatic(session, account_ids, transaction_ids=transaction_ids)
    return decisions


def bank_amount_changed(session: Session, bank: Transaction, old_amount: int) -> None:
    relation = ledger_projection.active_match_for(session, bank)
    if bank.amount_cents == old_amount:
        return
    if bank.amount_cents == 0 and ledger_projection.effective_facts(session, bank)["transfer_account_id"] is not None:
        bank.approved = False
    if relation and relation.history_transaction_id == bank.id and relation.category_source == "history":
        allocations.copy(session, bank, relation.feed_transaction)
        relation.category_source = "feed"
        session.flush()
    owner = ledger_projection.field_owner(bank, relation, "category")
    if owner.id != bank.id and allocations.load(session, [owner.id])[owner.id]:
        allocations.copy(session, owner, bank)
        from app.services import bank_continuity

        bank_continuity.select_representative_fields(bank, ["category"])
        if relation and relation.feed_transaction_id == bank.id:
            relation.category_source = "feed"
    bank_rows = allocations.load(session, [bank.id])[bank.id]
    effective_rows = bank_rows
    if (
        relation
        and relation.feed_transaction_id == bank.id
        and relation.category_source == "history"
    ):
        planned_rows = allocations.load(session, [relation.history_transaction_id])[
            relation.history_transaction_id
        ]
        planned = relation.history_transaction
        if planned_rows:
            effective_rows = planned_rows
            allocations.copy(session, planned, bank)
            relation.category_source = "feed"
    if effective_rows:
        allocations.reconcile_bank_difference(session, bank)
        bank.approved = False


def history_comparison_description(history: Transaction, relation: TransactionMatch | None) -> str:
    if relation and relation.feed_transaction_id == history.id:
        return relation.history_transaction.description
    return history.description


def history_comparison_row(session: Session, history: Transaction) -> dict:


    result = ledger_projection.row(session, history)
    result["description"] = history_comparison_description(history, ledger_projection.active_match_for(session, history))
    return result


def replace_bank_side(session: Session, retired: Transaction, bank: Transaction, choices: dict | None = None) -> TransactionMatch | None:


    relation = ledger_projection.active_match_for(session, retired)
    if relation is None or relation.feed_transaction_id != retired.id:
        raise AppError("match_conflict", "The retained bank relationship changed.", 409)
    facts = ledger_projection.effective_facts(session, retired)
    collapse = relation.history_transaction_id == bank.id
    choices = dict(choices) if choices is not None else {field: "history" for field in ledger_projection.SOURCE_FIELDS}
    for name, field in (("payee", "payee_id"), ("transfer", "transfer_account_id"), ("category", "category_id"), ("memo", "memo"), ("flag", "flag")):
        owner = facts["owners"][name]
        if choices[name + "_source"] == "history" and (collapse or owner.id != relation.history_transaction_id):
            if name == "category":
                if owner.id != bank.id:
                    allocations.copy(session, owner, bank)
            else:
                setattr(bank, field, getattr(owner, field))
            choices[name + "_source"] = "feed"
    if retired.transfer_partner_id is not None:
        transfer_links.rehome_anchor(session, retired, bank)
    retired.feed_replacement_id = bank.id
    if collapse:
        bank.approved = retired.approved
        session.delete(relation)
        session.flush()
        return None
    duplicate = session.scalar(select(TransactionMatch).where(
        TransactionMatch.feed_transaction_id == bank.id,
        TransactionMatch.history_transaction_id == relation.history_transaction_id,
    ))
    if duplicate is not None and duplicate.id != relation.id:
        if duplicate.state == "matched":
            raise AppError("match_conflict", "A transaction is already matched.", 409)
        session.delete(duplicate)
        session.flush()
    relation.feed_transaction_id = bank.id
    relation.feed_transaction = bank
    for field in ledger_projection.SOURCE_FIELDS:
        setattr(relation, field, choices[field])
    session.flush()
    return relation


def promote_returning_identity(session: Session, identity: Transaction, replacement: Transaction | None = None) -> int:
    if replacement is not None:
        identity.feed_replacement_id = None
        relation = ledger_projection.active_match_for(session, replacement)
        if relation is not None:
            replace_bank_side(session, replacement, identity)
        else:
            identity.payee_id, identity.transfer_account_id, identity.transfer_payee_confirmed, identity.memo, identity.flag = replacement.payee_id, replacement.transfer_account_id, replacement.transfer_payee_confirmed, replacement.memo, replacement.flag
            allocations.copy(session, replacement, identity)
            if replacement.transfer_partner_id is not None:
                transfer_links.rehome_anchor(session, replacement, identity)
            replacement.feed_replacement_id = identity.id
        for field in ("approved", "plaid_excluded_at", "plaid_excluded_amount_cents", "manually_cleared"):
            setattr(identity, field, getattr(replacement, field))
        identity.pending_resolved = identity.pending_resolved or replacement.pending_resolved
        from app.models import BankContinuity

        for record in session.scalars(select(BankContinuity).where(BankContinuity.source_transaction_id == identity.id, BankContinuity.state == "active")).all():
            record.state = "inactive"
        return replacement.amount_cents
    relation = ledger_projection.active_match_for(session, identity)
    previous_amount = identity.amount_cents
    if relation is not None and relation.history_transaction_id == identity.id and relation.feed_transaction.feed_historical_at is not None:
        previous_amount = relation.feed_transaction.amount_cents
        replace_bank_side(session, relation.feed_transaction, identity)
    return previous_amount


def apply_match(session: Session, bank: Transaction, history: Transaction, choices: dict[str, str]) -> TransactionMatch:
    from app.services import ledger

    if ledger_projection.active_match_for(session, bank) is not None:
        raise AppError("match_conflict", "A transaction is already matched.", 409)
    prior = ledger_projection.active_match_for(session, history)
    if prior is not None:
        relation = replace_bank_side(session, history, bank, choices)
    else:
        relation = _pair(session, bank, history)
        for field in ledger_projection.SOURCE_FIELDS:
            setattr(relation, field, choices[field])
        if bank.amount_cents != history.amount_cents:
            _mirror_partner(session, history, bank.amount_cents)
    relation.state, relation.matched_by = "matched", "user"
    _handoff_planned_clearance(bank, history)
    session.flush()
    if bank.amount_cents != history.amount_cents:
        bank_amount_changed(session, bank, history.amount_cents)
    return relation


def _mirror_partner(session: Session, plan: Transaction, amount_cents: int) -> Transaction | None:
    partner = ledger_projection.amount_partner(session, plan)
    if partner is not None:
        transfer_links.set_partner_amount(partner, -amount_cents)
    return partner


def validate_pair(session: Session, plaid: Transaction, planned: Transaction) -> None:
    if plaid.source != "plaid" or plaid.plaid_txn_id is None:
        raise AppError("not_plaid_row", "Transaction must be a Plaid row", 422)


    relationships = ledger_projection.resolve_relationships(session, (plaid, planned))
    workflow = ledger_projection.uses_plaid_workflow(session, plaid.account_id)
    if ledger_projection.match_role(plaid, relationships[plaid.id], workflow) != "feed" or ledger_projection.match_role(planned, relationships[planned.id], workflow) != "history":
        raise AppError("match_target_not_available", "Choose a live bank row and eligible retained history.", 422)
    if plaid.account_id != planned.account_id:
        raise AppError(
            "match_account_mismatch", "Transactions must be in the same account", 422
        )
    if not amounts_match(session, plaid, planned):
        raise AppError(
            "match_amount_mismatch",
            "Transactions must have the same signed amount or meet the entered schedule’s +/- Match permission",
            422,
        )
    if ledger_projection.missing_pending(plaid):
        raise AppError(
            "match_missing_pending",
            "A temporarily missing pending Plaid transaction cannot be newly matched",
            422,
        )



    ledger_projection.require_action(session, plaid, "find_match")
    ledger_projection.require_action(session, planned, "find_match")


def finder_context(session: Session, source_id: int, scope: str, candidate_id: int | None, cursor: str | None) -> dict:
    if scope not in ("nearby", "all"):
        raise AppError("match_scope_invalid", "Choose nearby or all transactions.", 422)

    source = ledger_projection.require_transaction(session, source_id)
    source_row = ledger_projection.row(session, source)
    if "find_match" not in source_row["allowed_actions"]:
        raise AppError("match_source_not_available", "This transaction cannot be matched.", 422)
    other_role = "history" if source_row["match_role"] == "feed" else "feed"
    candidates: list[tuple[int, str, int, Transaction]] = []
    source_facts = matching_facts(source, source.payee_id)
    amount_filter = Transaction.amount_cents == source.amount_cents
    if source_row["match_role"] == "feed":
        amount_filter = or_(amount_filter, (Transaction.source == "manual") & (Transaction.match_tolerance_cents > 0) & (func.abs(Transaction.amount_cents - source.amount_cents) <= Transaction.match_tolerance_cents))
    elif source.source == "manual" and source.feed_historical_at is None and source.match_tolerance_cents > 0:
        amount_filter = Transaction.amount_cents.between(source.amount_cents - source.match_tolerance_cents, source.amount_cents + source.match_tolerance_cents)
    effective = {}
    eligible_rows = session.scalars(select(Transaction).where(
        Transaction.account_id == source.account_id,
        Transaction.source.in_(("manual", "plaid")),
        amount_filter,
    )).all()
    relationships = ledger_projection.resolve_relationships(session, eligible_rows)
    for candidate in eligible_rows:
        if ledger_projection.match_role(candidate, relationships[candidate.id], uses_plaid_workflow=True) != other_role:
            continue
        bank, plan = (source, candidate) if source_row["match_role"] == "feed" else (candidate, source)
        if not amounts_match(session, bank, plan, facts=effective):
            continue
        distance = candidate_distance(
            source_facts, matching_facts(candidate, candidate.payee_id), allow_amount_difference=True
        )
        if distance is None:
            continue
        if (
            scope == "nearby"
            and distance > SUGGESTION_DATE_TOLERANCE_DAYS
        ):
            continue
        candidates.append(
            (
                distance,
                candidate.date.isoformat(),
                candidate.id,
                candidate,
            )
        )
    candidates.sort(key=lambda item: item[:3])
    selected = session.get(Transaction, candidate_id) if candidate_id is not None else None
    if candidate_id is not None and selected is None:
        raise AppError("match_candidate_not_available", "That transaction cannot be matched.", 422)
    if selected is not None and selected not in [item[3] for item in candidates]:
        raise AppError("match_candidate_not_available", "That transaction cannot be matched.", 422)
    dismissed = _dismissed_pairs(session, source.account_id)
    if selected is None and cursor is None:
        if len(candidates) == 1:
            selected = candidates[0][3]
        else:
            for _distance, _when, _id, candidate in candidates:
                plaid, planned = (source, candidate) if source_row["match_role"] == "feed" else (candidate, source)
                if (plaid.id, planned.id) not in dismissed:
                    selected = candidate
                    break
    after = candidate_paging.decode(cursor, source_id=source.id, scope=scope, kind="match") if cursor else None
    remaining = [item for item in candidates if after is None or item[:3] > after]
    page = remaining[:50]
    def candidate_row(candidate: Transaction):
        row = ledger_projection.row(session, candidate)
        plaid, planned = (source, candidate) if source_row["match_role"] == "feed" else (candidate, source)
        relation = dismissed.get((plaid.id, planned.id))
        if relation:
            row["match"] = {"id": relation.id, "state": "dismissed"}
        return row

    rows = [candidate_row(item[3]) for item in page]
    selected_row = next((row for row in rows if row["id"] == selected.id), None) if selected else None
    if selected is not None and selected_row is None:
        selected_row = candidate_row(selected)
    comparison = None
    if selected is not None:
        plaid, planned = (source, selected) if source_row["match_role"] == "feed" else (selected, source)
        comparison = match_context(session, plaid, planned)
    return {
        "source": source_row, "candidates": rows, "candidate": selected_row,
        "comparison": comparison,
        "scope": scope,
        "next_cursor": candidate_paging.encode(page[-1][:3], source_id=source.id, scope=scope, kind="match") if len(remaining) > len(page) else None,
    }


def accept(
    session: Session,
    plaid: Transaction,
    planned: Transaction,
    choices: dict[str, str],
) -> TransactionMatch:
    token = choices.pop("context_token", None)
    if token != context_token(session, plaid, planned):
        raise AppError("match_context_stale", "The match context changed. Reopen it and review again.", 409)
    validate_pair(session, plaid, planned)
    if any(choices.get(field) not in ("feed", "history") for field in ledger_projection.SOURCE_FIELDS):
        raise AppError(
            "invalid_match_source",
            "Each presentation field must select feed or history",
            422,
        )
    owner = transfer_fixed_owner(session, plaid, planned)
    if owner and (
        choices["transfer_source"] != owner
    ):
        raise AppError("transfer_match_fields_fixed", "Transfer target choice is fixed.", 422)
    relation = apply_match(session, plaid, planned, choices)
    plaid.approved = True
    # Flush the accepted state because reconciliation queries run with autoflush disabled.
    session.flush()
    return relation


def unmatch(_session: Session, relation: TransactionMatch) -> TransactionMatch:
    if relation.state != "matched":
        raise AppError("match_not_active", "Match is not active", 422)
    relation.state = "dismissed"
    return relation


def expire_stale_matches(
    session: Session,
    *,
    account_ids: set[int] | None = None,
) -> None:
    query = (
        select(TransactionMatch)
        .join(Transaction, TransactionMatch.feed_transaction_id == Transaction.id)
        .options(contains_eager(TransactionMatch.feed_transaction))
        .where(
            TransactionMatch.state.in_(("suggested", "matched")),
            Transaction.plaid_removed_at.is_not(None),
        )
    )
    queries = [query] if account_ids is None else (
        query.where(Transaction.account_id.in_(batch))
        for batch in batched(account_ids, SQL_ID_BATCH_SIZE)
    )
    for relation in (row for statement in queries for row in session.scalars(statement).all()):
        if (
            relation.feed_transaction.plaid_removed_at is not None
            and not ledger_projection.plaid_visible(relation.feed_transaction)
        ):
            ledger_history.report_expired_match(session, relation.id)
            relation.state = "dismissed"
            relation.matched_by = None


def assert_deletable(session: Session, txn: Transaction) -> None:
    if ledger_projection.active_match_for(session, txn):
        raise AppError(
            "matched_transaction_locked",
            "Unmatch this transaction before deleting it",
            422,
        )


def tolerance_rationale(bank: Transaction, plan: Transaction) -> str:
    difference = abs(bank.amount_cents - plan.amount_cents)
    tolerance = plan.match_tolerance_cents
    return f"The amounts differ by ${difference // 100:,}.{difference % 100:02}; the entered schedule allowed +/- ${tolerance // 100:,}.{tolerance % 100:02}."


def matching_rationale(
    session: Session, plaid: Transaction, planned: Transaction
) -> str:
    from app.services import payees

    unequal = plaid.amount_cents != planned.amount_cents
    evidence = candidate_evidence(
        matching_facts(plaid, ledger_projection.effective_facts(session, plaid)["payee_id"] if unequal else plaid.payee_id),
        matching_facts(planned, ledger_projection.effective_facts(session, planned)["payee_id"] if unequal else planned.payee_id),
        payees.load_evaluator(session),
        allow_amount_difference=amounts_match(session, plaid, planned),
    )
    if evidence is None:
        return "These transactions do not have the same account and signed amount."
    details = list(evidence.reasons)
    if (
        evidence.saved_payee_state == "same"
        and evidence.date_distance > AUTOMATIC_DATE_TOLERANCE_DAYS
    ):
        details[-1] = "matching saved payee is outside the automatic date window"
    return "; ".join(details) + "." + (" " + tolerance_rationale(plaid, planned) if plaid.amount_cents != planned.amount_cents else "")


def read_pair_context(session: Session, feed_transaction_id: int, history_transaction_id: int) -> TransactionMatchContext:

    plaid = ledger_projection.require_transaction(session, feed_transaction_id)
    planned = ledger_projection.require_transaction(session, history_transaction_id)
    validate_pair(session, plaid, planned)
    return match_context(session, plaid, planned)


def read_match_context(session: Session, match_id: int) -> TransactionMatchContext:
    relation = session.get(TransactionMatch, match_id)
    if relation is None:
        raise AppError("match_not_found", "Transaction match not found", 404)
    return match_context(session, relation.feed_transaction, relation.history_transaction, relation)


def create_match(db: Session, payload: TransactionMatchCreate) -> dict:

    plaid, planned = (
        ledger_projection.require_transaction(db, payload.feed_transaction_id),
        ledger_projection.require_transaction(db, payload.history_transaction_id),
    )
    ledger_projection.require_account_initialized(db, plaid.account_id)
    ledger_projection.require_account_initialized(db, planned.account_id)
    accept(
        db,
        plaid,
        planned,
        payload.model_dump(exclude={"feed_transaction_id", "history_transaction_id"}),
    )
    changed = [plaid, planned, *filter(None, [db.get(Transaction, planned.transfer_partner_id) if planned.transfer_partner_id else None])]
    reconcile(db, {row.account_id for row in changed}, allow_automatic=True, expire_stale=True, transaction_ids={row.id for row in changed})
    db.flush()
    return ledger_projection.row(db, plaid)


def dismiss_match(db: Session, match_id: int) -> TransactionMatchContext:

    relation = db.get(TransactionMatch, match_id)
    if relation is None:
        raise AppError("match_not_found", "Transaction match not found", 404)
    ledger_projection.require_account_initialized(db, relation.feed_transaction.account_id)
    ledger_projection.require_account_initialized(db, relation.history_transaction.account_id)
    if relation.state != "suggested":
        raise AppError(
            "match_not_suggested", "Only suggested matches can be dismissed", 422
        )
    relation.state = "dismissed"
    db.flush()
    return match_context(
        db, relation.feed_transaction, relation.history_transaction, relation
    )


def unmatch_match(db: Session, match_id: int, token: str) -> TransactionMatchContext:

    relation = db.get(TransactionMatch, match_id)
    if relation is None:
        raise AppError("match_not_found", "Transaction match not found", 404)
    ledger_projection.require_account_initialized(db, relation.feed_transaction.account_id)
    ledger_projection.require_account_initialized(db, relation.history_transaction.account_id)
    if context_token(db, relation.feed_transaction, relation.history_transaction) != token:
        raise AppError("match_context_stale", "The match changed. Reopen it and review again.", 409)
    ledger_projection.require_action(db, relation.feed_transaction, "unmatch")
    unmatch(db, relation)
    record_lifecycle(db, "manual_matching", "unmatched", "user_unmatched", account_id=relation.feed_transaction.account_id, transaction_id=relation.feed_transaction_id, candidate_id=relation.history_transaction_id, relationship_id=relation.id)
    db.flush()
    bank, plan = relation.feed_transaction, relation.history_transaction
    partner = ledger_projection.amount_partner(db, plan)
    changed = [bank, plan]
    if partner is not None and plan.amount_cents != bank.amount_cents and partner.amount_cents == -bank.amount_cents:
        transfer_links.set_partner_amount(partner, -plan.amount_cents)
        changed.append(partner)
        db.flush()
    reconcile(db, {row.account_id for row in changed}, allow_automatic=False, expire_stale=True, transaction_ids={row.id for row in changed})
    db.flush()
    return match_context(
        db, relation.feed_transaction, relation.history_transaction, relation
    )
