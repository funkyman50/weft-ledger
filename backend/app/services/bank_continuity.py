import hashlib
import json
from bisect import bisect_left, bisect_right
from collections import Counter
from datetime import datetime, timedelta
from itertools import batched

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.db import SQL_ID_BATCH_SIZE
from app.errors import AppError
from app.models import Account, AutomaticTransferLink, BankContinuity, Transaction, TransactionMatch
from app.services import ledger_projection, transfer_links
from app.services import transaction_allocations as allocations
from app.services.ledger_history import record_lifecycle

FIELDS = ("payee", "transfer", "category", "memo", "flag")


def _records(db, identifiers, states=("active",)):
    return list(db.scalars(select(BankContinuity).where(
        or_(BankContinuity.source_transaction_id.in_(identifiers), BankContinuity.target_transaction_id.in_(identifiers)),
        BankContinuity.state.in_(states),
    )).all())


def members(db, transaction_id):
    identifiers = {transaction_id}
    for _ in range(2):
        identifiers.update(identifier for record in _records(db, identifiers)
                           for identifier in (record.source_transaction_id, record.target_transaction_id))
    return identifiers


def rejected(db, source, target, *, provider=False):
    first, second = members(db, source.id), members(db, target.id)
    return any(
        (record.source_transaction_id in first and record.target_transaction_id in second)
        or (record.target_transaction_id in first and record.source_transaction_id in second)
        for record in _records(db, first | second, ("rejected", "inactive"))
        if record.state == "rejected" or (not provider and (record.handoff or {}).get("provider_contradiction"))
    )


def select_representative_fields(transaction, fields):
    association = transaction.bank_continuity
    if association is not None:
        for field in fields:
            setattr(association, f"{field}_source", "target")


def _match(db, transaction):
    return db.scalar(select(TransactionMatch).where(TransactionMatch.feed_transaction_id == transaction.id, TransactionMatch.state == "matched"))


def _match_image(relation):
    return {field: getattr(relation, field) for field in ("feed_transaction_id", "history_transaction_id", "matched_by", *ledger_projection.SOURCE_FIELDS)}


def _refresh(db, *rows):
    db.flush()
    for row in rows:
        db.expire(row, ["bank_continuity"])


def withdraw(db, association, *, reason, reject=False, source_ids=None):
    from app.services import transfers

    source, target = association.source_transaction, association.target_transaction
    transfers.withdraw_automatic(db, source_ids if source_ids is not None else {source.id, target.id}, reason=reason, exact=source_ids is not None)
    restoration_conflict = False
    if source.feed_replacement_id == target.id:
        source.feed_replacement_id = None
    handoff = association.handoff or {}
    saved = handoff.get("match")
    if saved:
        relation = db.get(TransactionMatch, saved["id"])
        if relation and relation.state == "matched" and _match_image(relation) == saved["applied"]:
            for field, value in saved["before"].items():
                setattr(relation, field, value)
            relation.feed_transaction = source
        else:
            source.approved = target.approved = False
            restoration_conflict = True
    saved = handoff.get("anchor")
    if saved and not saved.get("automatic"):
        if target.transfer_partner_id == saved["partner_id"] and source.transfer_partner_id is None:
            transfer_links.rehome_anchor(db, target, source)
        else:
            source.approved = target.approved = False
            restoration_conflict = True
    if not reject:
        target.approved = False
    association.state = "rejected" if reject else "inactive"
    _refresh(db, source, target)
    if restoration_conflict:
        for row in (source, target):
            representative = ledger_projection.current_representative(db, row)
            if representative is not None:
                representative.approved = False
    record_lifecycle(db, "bank_continuity", "rejected" if reject else "withdrawn", "user_rejected" if reject else reason, account_id=source.account_id, transaction_id=source.id, candidate_id=target.id, relationship_id=association.id, association_kind=association.kind)


def before_provider_update(db, transaction, raw):
    outgoing = db.scalar(select(BankContinuity).where(BankContinuity.source_transaction_id == transaction.id, BankContinuity.state == "active"))
    if outgoing is not None and outgoing.kind.startswith("inferred_") and (
        transaction.plaid_removed_at is not None or not raw.get("pending", False)
    ):
        withdraw(db, outgoing, reason="source_returned" if transaction.plaid_removed_at is not None else "source_posted")
        outgoing.handoff = {**outgoing.handoff, "provider_contradiction": True}


def before_amount_change(db, transaction, amount_cents):
    if amount_cents == transaction.amount_cents:
        return
    association = db.scalar(select(BankContinuity).where(BankContinuity.source_transaction_id == transaction.id, BankContinuity.state == "active"))
    if association is None:
        return
    target = association.target_transaction
    owner = ledger_projection.field_owner(target, None, "category")
    changed = False
    if owner.id == transaction.id and allocations.load(db, [owner.id])[owner.id]:
        allocations.copy(db, owner, target)
        association.category_source = "target"
        changed = True
    if amount_cents == 0 and ledger_projection.effective_facts(db, target)["transfer_account_id"] is not None:
        changed = True
    if changed:
        visible = ledger_projection.current_representative(db, target)
        target.approved = False
        if visible is not None:
            visible.approved = False
        db.flush()
        record_lifecycle(db, "bank_continuity", "corrected", "hidden_amount_change", account_id=transaction.account_id, transaction_id=transaction.id, candidate_id=target.id, representative_id=visible.id if visible else target.id, relationship_id=association.id, amount_changed=True)


def associate(db, source, target, kind, selections=None):
    from app.services import pending_lifecycle, ledger_projection

    if source.id == target.id or source.account_id != target.account_id:
        raise AppError("lifecycle_invalid_pair", "Choose two distinct bank records in the same account.", 422)
    outgoing = db.scalar(select(BankContinuity).where(BankContinuity.source_transaction_id == source.id, BankContinuity.state == "active"))
    if outgoing is not None:
        if outgoing.target_transaction_id == target.id:
            if kind == "provider":
                if outgoing.kind != "provider":
                    record_lifecycle(db, "bank_continuity", "upgraded", "provider", account_id=source.account_id, transaction_id=source.id, candidate_id=target.id, relationship_id=outgoing.id)
                outgoing.kind = "provider"
                target.pending_resolved = True
            return target
        if kind != "provider" or not outgoing.kind.startswith("inferred_"):
            raise AppError("lifecycle_relationship_conflict", "This bank record already has a successor.", 409)
        withdraw(db, outgoing, reason="authoritative_successor")
    incoming = db.scalar(select(BankContinuity).where(BankContinuity.target_transaction_id == target.id, BankContinuity.state == "active"))
    if incoming is not None:
        if kind != "provider" or not incoming.kind.startswith("inferred_"):
            raise AppError("lifecycle_relationship_conflict", "This bank record already has a predecessor.", 409)
        withdraw(db, incoming, reason="authoritative_predecessor")
    if target.id in members(db, source.id) or len(members(db, source.id)) > 2:
        raise AppError("lifecycle_chain_limit", "This bank association needs explicit review.", 409)
    if kind != "explicit" and rejected(db, source, target, provider=kind == "provider"):
        record_lifecycle(db, "bank_continuity", "blocked", "negative_decision", account_id=source.account_id, transaction_id=source.id, candidate_id=target.id, association_kind=kind)
        return None
    policy = pending_lifecycle.transfer_policy(db, source, target)
    pending_lifecycle.require_transfer_policy(policy)
    first, second = policy["pending_effective"], policy["cleared_effective"]
    if kind != "explicit" and policy["targets_conflict"]:
        raise AppError("lifecycle_transfer_target_conflict", "Review the conflicting transfer targets before continuing.", 409)
    source_match, target_match = _match(db, source), _match(db, target)
    if source_match and target_match and source_match.history_transaction_id != target_match.history_transaction_id:
        raise AppError("lifecycle_planned_match_conflict", "Unmatch one planned transaction before resolving this lifecycle.", 409)
    selected = selections or {f"{field}_source": choice for field, choice in pending_lifecycle.default_selections(policy).items()}
    if kind == "inferred_pending":
        selected = {f"{field}_source": "cleared" for field in FIELDS}
        selected["transfer_source"] = pending_lifecycle.default_selections(policy)["transfer"]
    if kind != "explicit" and kind != "inferred_pending":
        if (first["category"]["category_assigned"] and second["category"]["category_assigned"]
            and allocations.semantic(first["category"]) != allocations.semantic(second["category"])):
            record_lifecycle(db, "bank_continuity", "blocked", "category_conflict", account_id=source.account_id, transaction_id=source.id, candidate_id=target.id, association_kind=kind)
            return None
        if any(first[field] and second[field] and first[field] != second[field] for field in ("memo", "flag")):
            record_lifecycle(db, "bank_continuity", "blocked", "metadata_conflict", account_id=source.account_id, transaction_id=source.id, candidate_id=target.id, association_kind=kind)
            return None
    first, second = ledger_projection.effective_facts(db, source), ledger_projection.effective_facts(db, target)
    if source.transfer_partner_id is not None:
        partner = db.get(Transaction, source.transfer_partner_id)
        if target.transfer_partner_id is not None or partner is None or partner.transfer_partner_id != source.id:
            raise AppError("lifecycle_transfer_partner_conflict", "The transfer partner changed. Reopen the lifecycle review.", 409)
    record = db.scalar(select(BankContinuity).where(BankContinuity.source_transaction_id == source.id, BankContinuity.target_transaction_id == target.id))
    record = record or BankContinuity(source_transaction_id=source.id, target_transaction_id=target.id, kind=kind, state="active")
    record.kind, record.state = kind, "active"
    handoff = {}
    relation = source_match or target_match
    if source_match:
        handoff["match"] = {"id": source_match.id, "before": _match_image(source_match)}
        duplicate = db.scalar(select(TransactionMatch).where(TransactionMatch.feed_transaction_id == target.id, TransactionMatch.history_transaction_id == source_match.history_transaction_id))
        if duplicate is not None and duplicate.id != source_match.id:
            db.delete(duplicate)
            db.flush()
        source_match.feed_transaction_id = target.id
        source_match.feed_transaction = target
    for field in FIELDS:
        choice = selected[f"{field}_source"]
        facts = first if choice == "pending" else second
        owner = facts["owners"][field]
        setattr(record, f"{field}_source", "source" if choice == "pending" else "target")
        if relation and selections is not None:
            setattr(relation, f"{field}_source", "history" if owner.id == relation.history_transaction_id else "feed")
    if relation and selections is not None:
        relation.description_source = "feed"
    if source_match:
        handoff["match"]["applied"] = _match_image(source_match)
    if source.transfer_partner_id is not None:
        handoff["anchor"] = {"partner_id": source.transfer_partner_id, "automatic": ledger_projection.active_automatic_transfer(db, source) is not None}
        transfer_links.rehome_anchor(db, source, target)
    record.handoff = handoff
    db.add(record)
    source.feed_replacement_id = target.id
    source.pending_replacement_id = None
    if target.status != "pending":
        target.manually_cleared = False
    if kind != "inferred_pending":
        source.manually_cleared = False
        target.approved = source.approved and source.amount_cents == target.amount_cents
    if kind in ("provider", "explicit"):
        target.pending_resolved = True
    _refresh(db, source, target)
    category_owner = ledger_projection.field_owner(target, relation, "category")
    if allocations.load(db, [category_owner.id])[category_owner.id] and source.amount_cents != target.amount_cents:
        allocations.copy(db, category_owner, target)
        record.category_source = "target"
        if relation:
            relation.category_source = "feed"
        allocations.reconcile_bank_difference(db, target)
        target.approved = False
    if kind == "explicit":
        target.approved = True
    _refresh(db, source, target)
    record_lifecycle(db, "bank_continuity", "associated", kind, account_id=source.account_id, transaction_id=source.id, candidate_id=target.id, relationship_id=record.id, date_distance=abs((source.date - target.date).days), amount_equal=source.amount_cents == target.amount_cents, transaction_status=target.status, **{f"{field}_source": getattr(record, f"{field}_source") for field in FIELDS})
    return target


def available_bank_row(row, now, *, retained=False):
    return (row.source == "plaid" and row.feed_historical_at is None
            and row.provider_lifecycle_detached_at is None and row.plaid_excluded_at is None
            and row.pending_replacement_id is None
            and ((row.status == "pending" and (row.plaid_removed_at is None or ledger_projection.within_missing_pending_grace(row, now) or retained))
                 or (row.status in ("cleared", "reconciled") and row.plaid_removed_at is None)))


def _attention_only(db, source, target):
    facts = ledger_projection.effective_facts_for_rows(db, [source, target])
    first, second = facts[source.id], facts[target.id]
    if any(value["category"]["allocations"] or value["relationship"].anchor.transfer_partner_id is not None or (value["relationship"].relation is not None and value["relationship"].relation.state == "matched") for value in (first, second)):
        return False
    if any(first[field] != second[field] for field in ("payee_id", "memo", "flag")) or allocations.semantic(first["category"]) != allocations.semantic(second["category"]):
        return False
    if first["transfer_account_id"] is not None or second["transfer_account_id"] is not None:
        return False
    for field in ("name", "merchant_name"):
        left, right = (source.plaid_raw or {}).get(field), (target.plaid_raw or {}).get(field)
        if left and right and str(left).strip().casefold() != str(right).strip().casefold():
            return False
    return True


def _merchant_pairs(db, pool, active, now):
    components, settled, complex_members = {}, set(), set()
    for record in active:
        component = components.get(record.source_transaction_id)
        if component is None:
            component = members(db, record.source_transaction_id)
            components.update((identifier, component) for identifier in component)
        if record.kind in ("provider", "explicit"):
            settled.update(component)
        elif record.kind == "inferred_pending" or len(component) > 2:
            complex_members.update(component)
    context = [row for row in pool if row.id not in settled and not row.pending_resolved
               and (row.feed_replacement_id is None or row.id in components)
               and available_bank_row(row, now, retained=True)]
    merchants = {row.id: str((row.plaid_raw or {}).get("merchant_name") or "").strip().casefold() for row in context}
    by_amount = {}
    for row in context:
        by_amount.setdefault(row.amount_cents, []).append(row)
    for rows in by_amount.values():
        rows.sort(key=lambda row: row.date)
    checked, pairs = {}, set()
    for source in context:
        if source.status != "pending" or not merchants[source.id]:
            continue
        rows = by_amount[source.amount_cents]
        distance = timedelta(days=4 if source.plaid_removed_at is not None else 0)
        start = bisect_left(rows, source.date - distance, key=lambda row: row.date)
        stop = bisect_right(rows, source.date + distance, key=lambda row: row.date)
        for target in rows[start:stop]:
            if target.status == "pending" or merchants[source.id] != merchants[target.id]:
                continue
            window_start = bisect_left(rows, min(source.date, target.date) - timedelta(days=7), key=lambda row: row.date)
            window_stop = bisect_right(rows, max(source.date, target.date) + timedelta(days=7), key=lambda row: row.date)
            groups = {}
            for row in rows[window_start:window_stop]:
                merchant = merchants[row.id]
                if not merchant or row.id in complex_members:
                    break
                groups.setdefault(merchant, []).append(row)
            else:
                for group in groups.values():
                    pending = [row for row in group if row.status == "pending"]
                    posted = [row for row in group if row.status != "pending"]
                    if len(pending) != 1 or len(posted) != 1:
                        break
                    pending_row, posted_row = pending[0], posted[0]
                    key = pending_row.id, posted_row.id
                    if key not in checked:
                        checked[key] = (abs((pending_row.date - posted_row.date).days) <= (4 if pending_row.plaid_removed_at is not None else 0)
                                        and not rejected(db, pending_row, posted_row))
                    if not checked[key]:
                        break
                else:
                    pairs.add((source.id, target.id))
    return frozenset(pairs)


def _pair_block_reason(db, source, target, kind, now):
    continuing = source.feed_replacement_id == target.id
    forwarded = target.feed_replacement_id is not None
    if source.amount_cents != target.amount_cents:
        return "amount_changed"
    if not available_bank_row(source, now, retained=continuing) or not available_bank_row(target, now, retained=continuing and forwarded):
        return "bank_record_unavailable"
    distance = abs((source.date - target.date).days)
    if kind == "inferred_pending":
        if source.plaid_removed_at is None:
            return "source_not_removed"
        if target.status == "pending":
            if target.plaid_removed_at is not None and not (continuing and forwarded):
                return "target_removed"
            if distance != 0:
                return "date_window"
        elif not continuing or not target.pending_resolved:
            return "posting_not_confirmed"
        elif distance > 4:
            return "date_window"
        if not continuing and not _attention_only(db, source, target):
            return "attention_conflict"
    elif target.status == "pending" or source.status != "pending":
        return "stage_mismatch"
    elif distance > (4 if source.plaid_removed_at is not None else 0):
        return "date_window"
    return "negative_decision" if rejected(db, source, target) else None


def _block_reason(db, source, target, kind, pool, now, *, merchant_pairs):
    reason = _pair_block_reason(db, source, target, kind, now)
    if reason is not None:
        return reason
    component = members(db, target.id) | members(db, source.id)
    component.update((source.id, target.id))
    peers = [row for row in pool if row.id not in component and row.feed_replacement_id is None and not row.pending_resolved and available_bank_row(row, now) and row.amount_cents == source.amount_cents]
    if (any(abs((row.date - source.date).days) <= 7 or abs((row.date - target.date).days) <= 7 for row in peers)
        and not (kind == "inferred_posted" and (source.id, target.id) in merchant_pairs)):
        return "competing_bank_record"
    return None


def reconcile(db: Session, account_ids: set[int]) -> int:
    from app.services import pending_lifecycle

    now, count = datetime.now(), 0
    for account_id in account_ids:
        if not pending_lifecycle.account_inference_ready(db, account_id):
            record_lifecycle(db, "bank_continuity", "blocked", "inference_not_ready", account_id=account_id)
            continue
        seeds = list(db.scalars(select(Transaction).where(Transaction.account_id == account_id, Transaction.source == "plaid", Transaction.status == "pending")).all())
        active = _records(db, {row.id for row in seeds})
        seed_rows = {row.id: row for row in seeds if row.feed_replacement_id is None and available_bank_row(row, now)}
        for record in active:
            seed_rows[record.source_transaction_id] = record.source_transaction
            seed_rows[record.target_transaction_id] = record.target_transaction
        if not seed_rows:
            continue
        neighborhoods = {(row.amount_cents, row.date - timedelta(days=14), row.date + timedelta(days=14)) for row in seed_rows.values()}
        pool = dict(seed_rows)
        for batch in batched(neighborhoods, SQL_ID_BATCH_SIZE):
            pool.update((row.id, row) for row in db.scalars(select(Transaction).where(
                Transaction.account_id == account_id, Transaction.source == "plaid",
                or_(*(and_(Transaction.amount_cents == amount, Transaction.date >= first, Transaction.date <= last) for amount, first, last in batch)),
            )).all())
        pool = list(pool.values())
        neighborhood_counts = Counter(row.amount_cents for row in pool)
        for association in active:
            if association.kind in ("inferred_posted", "inferred_pending"):
                reason = _pair_block_reason(db, association.source_transaction, association.target_transaction, association.kind, now)
                if reason is not None:
                    withdraw(db, association, reason=reason)
        active = [association for association in active if association.state == "active"]
        merchant_pairs = _merchant_pairs(db, pool, active, now)
        for kind in ("inferred_posted", "inferred_pending"):
            for association in active:
                if association.state == "active" and association.kind == kind:
                    reason = _block_reason(db, association.source_transaction, association.target_transaction, kind, pool, now, merchant_pairs=merchant_pairs)
                    if reason is not None:
                        withdraw(db, association, reason=reason)
            db.flush()
            for source in pool:
                if source.feed_replacement_id is not None or source.status != "pending" or not available_bank_row(source, now):
                    continue
                for target in pool:
                    if target.id == source.id or target.feed_replacement_id is not None or target.pending_resolved or not available_bank_row(target, now):
                        continue
                    if (target.status == "pending") != (kind == "inferred_pending"):
                        continue
                    reason = _block_reason(db, source, target, kind, pool, now, merchant_pairs=merchant_pairs)
                    if reason is None:
                        try:
                            if associate(db, source, target, kind) is not None:
                                count += 1
                                break
                        except AppError as error:
                            if not error.code.startswith(("lifecycle_", "match_")):
                                raise
                            record_lifecycle(db, "bank_continuity", "blocked", error.code, account_id=account_id, transaction_id=source.id, candidate_id=target.id, association_kind=kind)
                    elif source.amount_cents == target.amount_cents and abs((source.date - target.date).days) <= 7:
                        record_lifecycle(db, "bank_continuity", "blocked", reason, account_id=account_id, transaction_id=source.id, candidate_id=target.id, association_kind=kind, amount_equal=True, date_distance=abs((source.date - target.date).days), neighborhood_count=neighborhood_counts[source.amount_cents])
    return count


def _cut(records, selected):
    source_side = {selected.source_transaction_id}
    for _ in range(2):
        source_side.update(identifier for record in records if record.id != selected.id
                           and {record.source_transaction_id, record.target_transaction_id} & source_side
                           for identifier in (record.source_transaction_id, record.target_transaction_id))
    identifiers = {identifier for record in records for identifier in (record.source_transaction_id, record.target_transaction_id)}
    return source_side, identifiers - source_side


def _edge_action(db, record, records, now):
    from app.services import transfers

    source, target = record.source_transaction, record.target_transaction
    source_side, _ = _cut(records, record)
    if source.plaid_removed_at is None:
        consequence = "The separated bank source becomes visible and contributes to the balance."
    elif ledger_projection.within_missing_pending_grace(source, now):
        consequence = "The separated source returns as Pending? and contributes zero."
    else:
        consequence = "The separated source remains hidden because its bank-removal grace has expired."
    saved = (record.handoff or {}).get("match")
    if saved:
        relation = db.get(TransactionMatch, saved["id"])
        if relation and relation.state == "matched" and _match_image(relation) == saved["applied"]:
            consequence += " Its unchanged manual match returns to the separated bank source."
            if source.plaid_removed_at is not None and not ledger_projection.plaid_visible(source, now):
                consequence += " That match then expires under the existing removal rules, revealing the manual entry."
            elif source.plaid_removed_at is not None:
                consequence += " That match can expire when the missing-pending grace ends."
            if source.plaid_removed_at is not None:
                consequence += " After expiry, a later edit or sync can automatically match the manual entry again."
        else:
            consequence += " The saved manual match has changed; later relationships remain and surviving entries need review."
    elif _match(db, target):
        consequence += " The current manual match stays on the surviving side."
    anchor = (record.handoff or {}).get("anchor")
    if anchor and not anchor.get("automatic"):
        if target.transfer_partner_id == anchor["partner_id"] and source.transfer_partner_id is None:
            consequence += " The unchanged bank-owned transfer connection returns with the separated source."
        else:
            consequence += " The bank-owned transfer connection has changed; later connections remain and surviving entries need review."
    automatic = db.scalars(select(AutomaticTransferLink).where(
        AutomaticTransferLink.state == "active",
        or_(AutomaticTransferLink.outflow_transaction_id.in_(source_side), AutomaticTransferLink.inflow_transaction_id.in_(source_side)),
    )).all()
    if automatic:
        consequence += " Dependent automatic transfers are disconnected; unchanged automatic classifications are restored and later edits are kept."
    consequence += " Other bank associations remain. This change accepts no new manual match."
    evidence = {
        "provider": "The bank provided this pending-to-posted link.",
        "explicit": "You associated these bank records.",
        "inferred_pending": "The removed and live pending records had the same cents, date and saved details, with no competing record.",
        "inferred_posted": "Exact cents and unique nearby bank records or complete one-to-one bank merchant groups supported this pending-to-posted association.",
    }[record.kind]
    return {
        "kind": "bank", "id": record.id,
        "source_id": source.id, "target_id": target.id,
        "source_label": transfers.relationship_label(source, now), "target_label": transfers.relationship_label(target, now),
        "context_token": "", "evidence": evidence, "consequence": consequence,
    }


def _context(db, transaction):
    from app.services import transfers

    representative = ledger_projection.row(db, transaction)
    if "inspect_connections" not in representative["allowed_actions"]:
        raise AppError("connections_not_available", "This transaction has no available connections to inspect.", 409)
    transfer = transfers.inspect_relationship(db, transaction)
    identifiers = members(db, transaction.id)
    records = sorted(_records(db, identifiers), key=lambda record: record.id)
    if not records and transfer is None:
        raise AppError("connections_not_available", "The connections changed. Reopen the transaction and inspect again.", 409)
    now = datetime.now()
    rows = [db.get(Transaction, identifier) for identifier in sorted(identifiers)]
    facts = [ledger_projection.source_row(db, row, retained=True) for row in rows]
    record_facts = [{
        "id": record.id,
        "source_transaction_id": record.source_transaction_id,
        "target_transaction_id": record.target_transaction_id,
        "kind": record.kind,
        **{f"{field}_source": getattr(record, f"{field}_source") for field in FIELDS},
    } for record in records]
    actions = [_edge_action(db, record, records, now) for record in records]
    token = hashlib.sha256(json.dumps({
        "records": [{**fact, "state": record.state, "handoff": record.handoff} for fact, record in zip(record_facts, records)],
        "rows": [row["edit_token"] for row in facts],
        "grace": [ledger_projection.within_missing_pending_grace(row, now) for row in rows],
        "relationships": [transfers._token(db, row, None) for row in rows],
        "actions": actions,
        "representative": representative["edit_token"],
    }, sort_keys=True).encode()).hexdigest()
    for action in actions:
        action["context_token"] = token
    return {"account_name": db.get(Account, transaction.account_id).name, "transaction_id": transaction.id, "context_token": token, "records": record_facts, "sources": facts, "representative": representative, "representative_id": transaction.id, "actions": actions, "transfer": transfer}


def read_connections(db, transaction_id):
    return _context(db, ledger_projection.require_transaction(db, transaction_id))


def reject(db, transaction_id, record_id, token):
    transaction = ledger_projection.require_transaction(db, transaction_id)
    context = _context(db, transaction)
    ledger_projection.require_action(db, transaction, "bank_continuity")
    if context["context_token"] != token:
        raise AppError("bank_continuity_context_stale", "The bank association changed. Reopen it and review again.", 409)
    records = [db.get(BankContinuity, record["id"]) for record in context["records"]]
    selected = next((record for record in records if record.id == record_id), None)
    if selected is None:
        raise AppError("bank_continuity_record_stale", "That bank association is no longer in this transaction. Reopen it and review again.", 409)
    source_side, target_side = _cut(records, selected)
    withdraw(db, selected, reason="user_rejected", reject=True, source_ids=source_side)
    for source_id in source_side:
        for target_id in target_side:
            record = db.scalar(select(BankContinuity).where(BankContinuity.source_transaction_id == source_id, BankContinuity.target_transaction_id == target_id))
            target = db.get(Transaction, target_id)
            record = record or BankContinuity(source_transaction_id=source_id, target_transaction_id=target_id, kind="inferred_pending" if target.status == "pending" else "inferred_posted", handoff={})
            record.state = "rejected"
            db.add(record)
    from app.services import transaction_matching
    transaction_matching.reconcile(db, {transaction.account_id}, allow_automatic=False, expire_stale=True)
    db.flush()
    return {"account_id": transaction.account_id}
