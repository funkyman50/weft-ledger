import hashlib
import json
from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import Account, Category, Payee, PayeeRule, ScheduledTransaction, Transaction
from app.schemas import (
    SingleCategorization,
    Target,
    TransactionBulkApply,
    TransactionCreate,
    TransactionReview,
    TransactionUpdate,
)
from app.services import categories, ledger_projection, transfer_links, payee_identity
from app.services import payees as payee_service
from app.services import transaction_allocations as allocations
from app.services import transaction_matching as matching

METADATA_FIELDS = frozenset(("payee_id", "transfer_account_id", "categorization", "memo", "flag"))
MATCH_SOURCE_FIELDS = {
    "payee_id": "payee_source",
    "transfer_account_id": "transfer_source",
    "categorization": "category_source",
    "memo": "memo_source",
    "flag": "flag_source",
}


def validate_metadata_values(db: Session, values: dict) -> None:
    if "payee_id" in values:
        payee_service.require_assignable(db, values["payee_id"])
    if "transfer_account_id" in values and values["transfer_account_id"] is not None and db.get(Account, values["transfer_account_id"]) is None:
        raise AppError("account_not_found", "Transfer account not found", 422)


def _transfer_change_policy(db, transaction, projected, values) -> None:
    current_id = projected["transfer_account_id"]
    final_id = values.get("transfer_account_id", current_id)
    current_target = payee_identity.target(db, current_id)
    requested_target = payee_identity.target(db, final_id)
    linked = ledger_projection.transfer_anchor(db, transaction).transfer_partner_id is not None
    if linked and (final_id != current_id or ("amount_cents" in values and ledger_projection.amount_partner(db, transaction) is None)):
        raise AppError("linked_transfer_locked", "Unlink this transfer before changing its amount or target.", 422)
    if final_id is None:
        return
    payload = values.get("categorization")
    if projected["allocations"] or (payload is not None and payload.kind == "split"):
        raise AppError("transfer_split_not_allowed", "Transfers must be whole transactions.", 422)
    if transaction.source == "starting_balance":
        raise AppError("transfer_not_available", "Starting balances cannot be transfers.", 422)
    if values.get("amount_cents", transaction.amount_cents) == 0:
        raise AppError("transfer_not_available", "Transfers require a nonzero amount.", 422)
    if requested_target is not None:
        if final_id != current_id:
            ledger_projection.require_account_initialized(db, requested_target.id)
        if requested_target.id == transaction.account_id:
            raise AppError("transfer_self_not_allowed", "A transfer cannot target its own account.", 422)
        if requested_target.closed and requested_target != current_target:
            raise AppError("transfer_target_closed", "Closed accounts cannot receive a new transfer.", 422)


def validate_transfer_assignment(db, transaction, projected, transfer_account_id: int, values: dict):
    target = payee_identity.target(db, transfer_account_id)
    if target is None:
        raise AppError("transfer_not_classified", "Choose a transfer account first.", 422)
    values["transfer_account_id"] = transfer_account_id
    _transfer_change_policy(db, transaction, projected, values)
    return target


def apply_metadata_values(
    db, transaction, relation, projected, values, *, allocation_rows=None
):
    from app.services import bank_continuity

    _transfer_change_policy(db, transaction, projected, values)
    if transaction.source == "manual" and any(field in values and values[field] != projected[field] for field in ("amount_cents", "payee_id", "transfer_account_id")):
        transaction.match_tolerance_cents = 0
    accepted = relation if relation and relation.state == "matched" else None
    payload = values.get("categorization")
    for field in ("payee_id", "transfer_account_id", "memo", "flag"):
        if field in values and projected[field] != values[field]:
            setattr(transaction, field, values[field])
            bank_continuity.select_representative_fields(transaction, ["transfer" if field == "transfer_account_id" else field.removesuffix("_id")])
            if transaction.source == "plaid" and accepted:
                setattr(accepted, MATCH_SOURCE_FIELDS[field], "feed")
    if "categorization" not in values:
        return False
    effective = ledger_projection.field_owner(transaction, relation, "category")
    effective_rows = (
        allocation_rows[effective.id]
        if allocation_rows is not None
        else allocations.load(db, [effective.id])[effective.id]
    )
    current = allocations.snapshot(effective, effective_rows)
    payload = values["categorization"]
    if effective is not transaction and payload.kind == "split":
        by_id = {row.id: row for row in effective_rows}
        seen = set()
        for line in payload.allocations:
            if line.id is not None and (line.id in seen or line.id not in by_id):
                raise AppError(
                    "allocation_id_invalid",
                    "An allocation line no longer belongs to the effective transaction",
                    422,
                )
            if line.id is not None:
                seen.add(line.id)
            if line.unassigned:
                old = by_id.get(line.id)
                if (
                    old is None
                    or not old.unassigned
                    or line.category_id is not None
                    or line.memo != old.memo
                    or line.amount_cents != old.amount_cents
                ):
                    raise AppError(
                        "unassigned_split_invalid",
                        "Only the current bank difference line can remain unassigned",
                        422,
                    )
    if effective is not transaction and allocations.semantic(
        current
    ) == allocations.semantic(allocations.requested(payload)):
        return False
    if effective is not transaction and payload.kind == "split":
        allocations.copy(db, effective, transaction)
        target_rows = allocations.load(db, [transaction.id])[transaction.id]
        identifiers = {old.id: new.id for old, new in zip(effective_rows, target_rows)}
        payload = payload.model_copy(
            update={
                "allocations": [
                    line.model_copy(update={"id": identifiers.get(line.id)})
                    for line in payload.allocations
                ]
            }
        )
        replacement_rows = allocations.load(db, [transaction.id])[transaction.id]
    else:
        replacement_rows = (
            allocation_rows[transaction.id]
            if allocation_rows is not None
            else allocations.load(db, [transaction.id])[transaction.id]
        )
    changed = allocations.replace(
        db, transaction, payload, replacement_rows
    ) or effective.id != transaction.id
    if changed:
        bank_continuity.select_representative_fields(transaction, ["category"])
    if changed and transaction.source == "plaid" and accepted:
        accepted.category_source = "feed"
    return changed


def apply_comparison_edits(db: Session, transaction: Transaction, edits) -> None:
    values = edits.model_dump(exclude_unset=True) if edits is not None else {}
    projected = ledger_projection.row(db, transaction)
    if values:
        if "category_id" in values and projected["allocations"]:
            raise AppError("comparison_split_edit", "Edit the split breakdown in the ledger after linking or resolution.", 422)
        relationship = ledger_projection.resolve_relationship(db, transaction)
        ledger_projection.validate_edit_values(
            transaction, relationship.relation, values,
            projected["allowed_actions"], projected["editable_fields"],
        )
        validate_metadata_values(db, values)
        if "payee_id" not in values:
            payee_service.require_assignable(db, projected["payee_id"])
        if "category_id" in values:
            values["categorization"] = SingleCategorization(kind="single", category_id=values.pop("category_id"))
        apply_metadata_values(db, transaction, relationship.relation, projected, values)
    facts = ledger_projection.effective_facts(db, transaction)
    identity = db.get(Payee, facts["payee_id"])
    transaction.transfer_payee_confirmed = facts["transfer_account_id"] is not None and identity.kind in ("ordinary", "myself")


def apply_payee_default(
    db: Session, transaction: Transaction, payee_id: int
) -> bool:
    category = payee_service.default_category(db, payee_id)
    if category is None:
        return False
    relation = ledger_projection.resolve_relationship(db, transaction).relation
    projected = ledger_projection.row(db, transaction)
    if projected["payee_id"] != payee_id or not _untouched_category(projected):
        return False
    return apply_metadata_values(
        db,
        transaction,
        relation,
        projected,
        {"categorization": SingleCategorization(kind="single", category_id=category.id)},
    )


def materialize_transfer_completion(db: Session, transaction: Transaction, transfer_account_id: int) -> None:
    if payee_identity.target(db, transfer_account_id) is None:
        raise AppError("transfer_not_classified", "Choose a transfer account first.", 422)
    effective = ledger_projection.effective_facts(db, transaction)
    if transaction.source == "manual" and transaction.transfer_account_id != transfer_account_id:
        transaction.match_tolerance_cents = 0
    transaction.transfer_account_id = transfer_account_id
    from app.services import bank_continuity

    bank_continuity.select_representative_fields(transaction, ["transfer"])
    relation = effective["relationship"].relation
    if transaction.source == "plaid" and relation is not None and relation.state == "matched":
        relation.transfer_source = "feed"


def assign_payee_to_sources(db, transaction, relation, payee_id: int, *, context=None) -> None:
    for source in ledger_projection.payee_assignment_sources(db, transaction, relation, context=context):
        if source.payee_id != payee_id:
            source.payee_id = payee_id
            if source.source == "manual":
                source.match_tolerance_cents = 0


def bulk_apply(
    db: Session, payload: TransactionBulkApply, *, assign_payee_sources: bool = False
) -> dict:
    lookups = ledger_projection.projection_lookups(db)
    changes = payload.changes.model_dump(exclude_unset=True)
    editable = {field for field in changes if field in {"payee_id", "transfer_account_id", "memo", "flag", "category_id"}}
    targets = ledger_projection.selected_snapshots(
        db,
        payload.targets,
        editable,
        require_review="approved" in changes,
        require_clearance="clearance" in changes,
        require_manual_clearance="manual_clearance" in changes,
        lookups=lookups,
    )
    if "category_id" in changes:
        if any(item["allocations"] for _, _, item in targets):
            raise AppError(
                "bulk_split_category_not_allowed",
                "Bulk category changes cannot include split transactions",
                422,
            )
        if changes["category_id"] is not None:
            categories.require_assignable(db, changes["category_id"])
    if changes.get("transfer_account_id") is not None:
        raise AppError("bulk_transfer_target_review_required", "Use transfer review to assign a transfer account.", 422)
    metadata = {
        field: value
        for field, value in changes.items()
        if field in {"payee_id", "transfer_account_id", "memo", "flag"}
    }
    validate_metadata_values(db, metadata)
    if "memo" in changes:
        overwrites = sum(projected["memo"] != "" and projected["memo"] != changes["memo"] for _, _, projected in targets)
        if overwrites and not payload.memo_overwrite_confirmed:
            raise AppError(
                "bulk_memo_confirmation_required",
                "Confirm replacing existing memos before applying this batch",
                422,
                {"overwrite_count": overwrites},
            )
    allocation_rows = None
    if "category_id" in changes:
        allocation_rows = allocations.load(
            db,
            {
                item.id
                for transaction, relationship, _ in targets
                for item in (transaction, ledger_projection.field_owner(transaction, relationship.relation, "category"))
            },
        )
    for transaction, relationship, projected in targets:
        relation = relationship.relation
        values = dict(metadata)
        if "category_id" in changes:
            values["categorization"] = SingleCategorization(
                kind="single", category_id=changes["category_id"]
            )
        apply_metadata_values(
            db, transaction, relation, projected, values,
            allocation_rows=allocation_rows,
        )
        if assign_payee_sources:
            assign_payee_to_sources(db, transaction, relation, changes["payee_id"], context=lookups)
        if (
            "payee_id" in changes
            and changes["payee_id"] is not None
            and changes["payee_id"] != projected["payee_id"]
            and "category_id" not in changes
        ):
            apply_payee_default(db, transaction, changes["payee_id"])
        if editable:
            payee_service.require_assignable(db, ledger_projection.effective_facts(db, transaction)["payee_id"])
        if "payee_id" in changes or "transfer_account_id" in changes:
            transaction.transfer_payee_confirmed = ledger_projection.effective_facts(db, transaction)["transfer_account_id"] is not None
        if "approved" in changes:
            transaction.approved = changes["approved"]
        if "clearance" in changes:
            transaction.status = changes["clearance"]
        if "manual_clearance" in changes:
            transaction.manually_cleared = changes["manual_clearance"]
    db.flush()
    target_accounts = {transaction.account_id for transaction, _, _ in targets}
    refreshed = ledger_projection.parent_projection(db, target_accounts)
    rows = [refreshed[transaction.id][2] for transaction, _, _ in targets]
    ledger_projection.fill_tokens(db, refreshed, rows)
    return {"status": "ok", "rows": rows}


def assigned_payee_projection(db: Session, payee_id: int):
    account_ids = set(
        db.scalars(
            select(Transaction.account_id)
            .where(Transaction.payee_id == payee_id)
            .distinct()
        ).all()
    )
    if not account_ids:
        return {}
    return {
        identifier: item
        for identifier, item in ledger_projection.parent_projection(db, account_ids).items()
        if item[2]["payee_id"] == payee_id
    }


def preview_payee_replacement(db: Session, payee_id: int, destination_payee_id: int, offset: int = 0) -> dict:
    payee_service.require_ordinary(db, payee_id)
    destination = payee_service.require_ordinary(db, destination_payee_id)
    if payee_id == destination_payee_id:
        raise AppError("payee_replacement_invalid", "Choose a different payee.", 422)
    preview = payee_service.references(db, payee_id, offset)
    preview["destination"] = payee_service.out(db, destination)
    preview["preview_token"] = hashlib.sha256(json.dumps(
        [preview["preview_token"], preview["destination"], destination.category_streak_ids],
        sort_keys=True,
    ).encode()).hexdigest()
    return preview


def replace_payee(db: Session, payee_id: int, payload) -> None:
    preview = preview_payee_replacement(db, payee_id, payload.destination_payee_id)
    if preview["preview_token"] != payload.preview_token:
        raise AppError("payee_replacement_stale", "Payee references or preferences changed. Review the replacement again.", 409)
    for transaction in db.scalars(select(Transaction).where(Transaction.payee_id == payee_id)).all():
        transaction.payee_id = payload.destination_payee_id
        if transaction.source == "manual":
            transaction.match_tolerance_cents = 0
    for schedule in db.scalars(select(ScheduledTransaction).where(ScheduledTransaction.payee_id == payee_id)).all():
        schedule.payee_id = payload.destination_payee_id
    for rule in db.scalars(select(PayeeRule).where(PayeeRule.payee_id == payee_id)).all():
        rule.payee_id = payload.destination_payee_id
    db.flush()
    db.delete(db.get(Payee, payee_id))


def _delete_payee_references(db: Session, previews: list[dict]) -> None:
    if any(preview["displayed_transaction_count"] or preview["schedule_count"] for preview in previews):
        raise AppError("payee_in_use", "Displayed transactions or saved schedules still use this payee.", 409)
    changes = {}
    for preview in previews:
        for group in preview["groups"]:
            for record in group["records"]:
                if record["source"] == "starting_balance":
                    raise AppError("payee_in_use", "Starting Balance records cannot be reassigned.", 409)
                changes[record["id"]] = group["transaction"]["payee_id"] if group["transaction"] else None
    unknown_id = payee_service.system_payee(db, "unknown").id if None in changes.values() else None
    for identifier, destination in changes.items():
        transaction = db.get(Transaction, identifier)
        transaction.payee_id = destination if destination is not None else unknown_id
        if transaction.source == "manual":
            transaction.match_tolerance_cents = 0
    db.flush()
    for preview in previews:
        db.delete(db.get(Payee, preview["payee"]["id"]))
    db.flush()


def delete_payee(db: Session, payee_id: int, expected: str) -> None:
    payee = payee_service.require_ordinary(db, payee_id)
    preview = payee_service.reference_previews(db, [payee])[0]
    if preview["preview_token"] != expected:
        raise AppError("payee_deletion_stale", "Payee references changed. Review the deletion again.", 409)
    _delete_payee_references(db, [preview])


def delete_unused_payees(db: Session, expected: str) -> None:
    plan = payee_service.unused_deletion_plan(db)
    if payee_service.unused_deletion_preview(plan)["preview_token"] != expected:
        raise AppError("payee_deletion_stale", "Unused payees changed. Review the deletion again.", 409)
    _delete_payee_references(db, plan)


def _untouched_category(projected: dict) -> bool:
    return (
        projected["category_id"] is None
        and not projected["category_assigned"]
        and not projected["allocations"]
        and projected["transfer_account_id"] is None
    )


def _default_target_eligible(projected: dict) -> bool:
    return (
        _untouched_category(projected)
        and "edit" in projected["allowed_actions"]
        and "category_id" in projected["editable_fields"]
    )


def preview_default_category(db: Session, payee_id: int, category_id: int, expected_category_id: int | None) -> dict:
    payee = db.get(Payee, payee_id)
    if payee is None:
        raise AppError("payee_not_found", "Payee not found", 404)
    payee_service.validate_default_category_save(
        db, payee, category_id, expected_category_id
    )
    projection = assigned_payee_projection(db, payee_id)
    shown = [projected for _, _, projected in projection.values()]
    ledger_projection.fill_tokens(db, projection, shown)
    return {
        "targets": [
            {"id": transaction.id, "edit_token": projected["edit_token"]}
            for transaction, _, projected in projection.values()
            if _default_target_eligible(projected)
        ]
    }


def save_default_category(db: Session, payee_id: int, payload) -> Payee:
    if payload.category_id is None and payload.targets:
        raise AppError(
            "payee_default_category_targets_invalid",
            "Choose a default category before updating transactions.",
            422,
        )
    payee = db.get(Payee, payee_id)
    if payee is None:
        raise AppError("payee_not_found", "Payee not found", 404)
    payee_service.validate_default_category_save(
        db,
        payee,
        payload.category_id,
        payload.expected_default_category_id,
    )
    projection = assigned_payee_projection(db, payee_id)
    selected = [projection[target.id][2] for target in payload.targets if target.id in projection]
    ledger_projection.fill_tokens(db, projection, selected)
    rejected = [
        {"id": target.id, "reason": "missing or changed"}
        for target in payload.targets
        if target.id not in projection
        or projection[target.id][2]["edit_token"] != target.edit_token
        or not _default_target_eligible(projection[target.id][2])
    ]
    if rejected:
        raise AppError(
            "payee_default_category_targets_stale",
            "Selected transactions changed. Review them again.",
            409,
            {"rejected": rejected},
        )
    payee = payee_service.set_default_category(
        payee,
        payload.category_id,
    )
    if payload.targets:
        bulk_apply(
            db,
            TransactionBulkApply(
                targets=payload.targets,
                changes={"category_id": payload.category_id},
            ),
        )
    return payee


def default_category_suggestion(
    db: Session, payee_id: int, transaction_id: int, category_id: int
) -> dict | None:
    payee = db.get(Payee, payee_id)
    if (
        payee is None
        or payee.default_category_id is not None
        or payee.default_category_prompt_dismissed
    ):
        return None
    try:
        payee_service.require_default_category(db, category_id)
    except AppError:
        return None
    projection = assigned_payee_projection(db, payee_id)
    origin = projection.get(transaction_id)
    if origin is None:
        return None
    _, _, origin_row = origin
    if origin_row["category_id"] != category_id or not origin_row["category_assigned"] or not _category_memory_eligible(origin_row):
        return None
    identifiers = category_streak(db, payee)
    if payee.remembered_category_id != category_id or transaction_id not in identifiers or len(identifiers) < 3:
        return None
    return {"payee_id": payee_id, "category_id": category_id, "transaction_count": len(identifiers)}


def _category_memory_eligible(projected: dict) -> bool:
    return (
        projected["payee_id"] is not None and not projected["allocations"]
        and projected["transfer_account_id"] is None and projected["payee_kind"] == "ordinary" and not projected["excluded"]
        and not projected["missing_pending"] and projected["source"] != "starting_balance"
    )


def category_streak(db: Session, payee: Payee) -> list[int]:
    identifiers = []
    for identifier in payee.category_streak_ids:
        transaction = db.get(Transaction, identifier)
        if transaction is None:
            continue
        current = ledger_projection.resolve_relationship(db, transaction).parent or transaction
        projected = ledger_projection.row(db, current)
        if (
            current.id not in identifiers and projected["payee_id"] == payee.id
            and projected["category_id"] == payee.remembered_category_id
            and _category_memory_eligible(projected) and current.plaid_removed_at is None
        ):
            identifiers.append(current.id)
    return identifiers


def remember_entry_category(db: Session, projected: dict) -> dict | None:
    if not _category_memory_eligible(projected):
        return None
    payee = db.get(Payee, projected["payee_id"])
    category_id = projected["category_id"]
    if category_id is not None and payee_service.active_category(db, category_id) is None:
        return None
    identifiers = category_streak(db, payee) if payee.remembered_category_id == category_id else []
    payee.remembered_category_id = category_id
    if category_id is not None and projected["id"] not in identifiers:
        identifiers.append(projected["id"])
    payee.category_streak_ids = identifiers[-3:] if category_id is not None else []
    return {"payee_id": payee.id, "remembered_category_id": category_id}


def _command_targets(db: Session, targets: list[Target], action: str, *, scope: str = "active"):
    return ledger_projection.selected_targets(db, targets, lambda item: action in item["allowed_actions"], scope=scope)


def manual_clearance(db: Session, target: Target, intent: str) -> dict:
    transaction, _, _ = _command_targets(db, [target], "manual_clearance")[0]
    transaction.manually_cleared = intent == "clear"
    db.flush()
    return ledger_projection.row(db, transaction)


def bulk_move(db: Session, targets: list[Target], destination_account_id: int) -> None:
    _command_rows = ledger_projection.hold_account_and_category_rows(db)
    destination = db.get(Account, destination_account_id)
    if destination is None:
        raise AppError("account_not_found", "Account not found", 422)
    ledger_projection.require_account_initialized(db, destination.id)
    if destination.closed:
        raise AppError("transaction_move_closed_account", "Closed accounts cannot receive moved transactions", 422)
    selected = _command_targets(db, targets, "move")
    source_accounts = {transaction.account_id for transaction, _, _ in selected}
    if any(transaction.account_id == destination.id for transaction, _, _ in selected):
        raise AppError("transaction_move_same_account", "Choose a different destination account", 422)
    destination_uses_plaid_workflow = ledger_projection.uses_plaid_workflow(db, destination.id)
    if destination.id and destination_uses_plaid_workflow and any(transaction.status in ("cleared", "reconciled") for transaction, _, _ in selected):
        raise AppError("transaction_move_plaid_clearance", "Cleared transactions can't be moved into a Plaid-connected account; mark uncleared first", 422)
    for transaction, relationship, projected in selected:
        if relationship.anchor.transfer_partner_id is not None:
            raise AppError("linked_transfer_locked", "Unlink this transfer before moving it.", 422)
        target = payee_identity.target(db, projected["transfer_account_id"])
        if target is not None and target.id == destination.id:
            raise AppError("transfer_move_target", "A transfer cannot move into its target account.", 422)
        transaction.account_id = destination.id
        transaction.match_tolerance_cents = 0
        if destination_uses_plaid_workflow:
            transaction.status = "uncleared"
            if transaction.source == "manual":
                transaction.feed_historical_at = None
    db.flush()
    account_ids = source_accounts | {destination.id}
    matching.reconcile(db, account_ids, allow_automatic=True, expire_stale=True, transaction_ids={transaction.id for transaction, _relation, _row in selected})


def bulk_delete(db: Session, targets: list[Target]) -> None:

    selected = _command_targets(db, targets, "delete")
    account_ids = {transaction.account_id for transaction, _, _ in selected}
    for transaction, _, _ in selected:
        matching.assert_deletable(db, transaction)
        transfer_links.unlink(db, transaction)
        db.delete(transaction)
    db.flush()
    matching.reconcile(db, account_ids, allow_automatic=True, expire_stale=True, transaction_ids={transaction.id for transaction, _relation, _row in selected})


def exclude(db: Session, target: Target) -> dict:
    transaction, relationship, _ = _command_targets(db, [target], "exclude")[0]
    relation = relationship.relation
    if relation is not None and relation.state == "suggested":
        db.delete(relation)
    transaction.plaid_excluded_at = datetime.now()
    transaction.plaid_excluded_amount_cents = transaction.amount_cents
    db.flush()
    result = ledger_projection.row(db, transaction)
    return result


def restore(db: Session, targets: list[Target]) -> None:
    selected = _command_targets(db, targets, "restore", scope="excluded")
    for transaction, _, projected in selected:
        excluded_amount = transaction.plaid_excluded_amount_cents
        transaction.plaid_excluded_at = None
        transaction.plaid_excluded_amount_cents = None
        if projected["allocations"] and excluded_amount != transaction.amount_cents:
            matching.bank_amount_changed(db, transaction, excluded_amount)
    db.flush()


def payee_history(db: Session, query: str, account_id: int | None, payee_id: int | None, exclude_payee_id: int | None, before_date: date | None, before_id: int | None, before_order: int | None = None) -> dict:
    if account_id is not None and db.get(Account, account_id) is None:
        raise AppError("account_not_found", "Account not found", 404)
    visible = ledger_projection.parent_projection(
        db,
        {account_id} if account_id is not None else None,
    )
    items = [
        item[2]
        for item in visible.values()
        if (ledger_projection.contains_text(item[2]["rule_description"], query) or ledger_projection.contains_text(item[2]["payee_name"], query))
        and (payee_id is None or item[2]["payee_id"] == payee_id)
        and (exclude_payee_id is None or item[2]["payee_id"] != exclude_payee_id)
    ]
    items.sort(key=lambda item: ledger_projection.chronology_key(item["date"], item["amount_cents"], item["id"], item["source"]), reverse=True)
    total_count = len(items)
    before = ledger_projection.chronology_cursor(before_date, before_id, before_order)
    if before is not None:
        items = [item for item in items if ledger_projection.chronology_key(item["date"], item["amount_cents"], item["id"], item["source"]) < before]
    page = items[:100]
    ledger_projection.fill_tokens(db, visible, page)
    tail = page[-1] if page else None
    return {"rows": page, "total_count": total_count, "has_more": len(items) > len(page), "next_before_date": tail["date"] if len(items) > len(page) and tail else None, "next_before_id": tail["id"] if len(items) > len(page) and tail else None, "next_before_order": ledger_projection.chronology_rank(tail["amount_cents"], tail["source"]) if len(items) > len(page) and tail else None}


def _rule_facts(transaction: Transaction, projected: dict) -> tuple:
    raw = transaction.plaid_raw if transaction.source == "plaid" and isinstance(transaction.plaid_raw, dict) else {}
    return projected["account_id"], projected["amount_cents"], transaction.description, raw.get("merchant_name")


def _rule_rows(db: Session, projection):
    pending = {
        account.id for account in db.scalars(select(Account)).all()
        if account.starting_balance_initialized_at is None and ledger_projection.uses_plaid_workflow(db, account.id)
    }
    for transaction, _, projected in projection.values():
        if transaction.source == "starting_balance":
            continue
        if projected["account_id"] in pending:
            blocked = "account_not_initialized"
        elif "edit" not in projected["allowed_actions"] or "payee_id" not in projected["editable_fields"]:
            blocked = "not_editable"
        else:
            blocked = None
        yield transaction, projected, blocked


def rule_collection(db: Session) -> dict:
    rules = payee_service.stored_rules(db)
    evaluator = payee_service.load_evaluator(db)
    counts = {rule.id: [0, 0] for rule in rules}
    evaluation_error = None
    try:
        for transaction, projected, _ in _rule_rows(db, ledger_projection.parent_projection(db, None)):
            facts = _rule_facts(transaction, projected)
            reached = False
            for item in evaluator.items:
                if evaluator.matches(item, *facts):
                    counts[item["id"]][0] += 1
                    if not reached:
                        counts[item["id"]][1] += 1
                        reached = True
    except payee_service.RuleEvaluationError as error:
        counts = {rule.id: [None, None] for rule in rules}
        evaluation_error = f"Rule counts are unavailable. {error.message} You can still edit or delete rules."
    return {"rules": [{**payee_service.rule_data(rule, index + 1), "matching_count": counts[rule.id][0], "deciding_count": counts[rule.id][1]} for index, rule in enumerate(rules)], "rules_token": payee_service.rules_token(rules), "evaluation_error": evaluation_error}


def rule_trace(db: Session, transaction_id: int) -> dict:
    transaction = ledger_projection.require_transaction(db, transaction_id)
    visible = ledger_projection.resolve_relationship(db, transaction).parent
    if visible is None:
        raise AppError("transaction_not_found", "Transaction not found", 404)
    projected = ledger_projection.row(db, visible)
    facts = _rule_facts(visible, projected)
    evaluator = payee_service.load_evaluator(db)
    matching = [item["id"] for item in evaluator.items if evaluator.matches(item, *facts)]
    result = evaluator.resolve(*facts)
    raw = visible.plaid_raw if visible.source == "plaid" and isinstance(visible.plaid_raw, dict) else None
    effective_payee_id = result["payee_id"]
    if effective_payee_id is None and raw is not None:
        fallback = payee_service.fallback_name(raw)
        saved = db.scalar(select(Payee).where(Payee.name_key == payee_service.name_key(fallback))) if fallback else None
        effective_payee_id = saved.id if saved else None
    category_id = result["category_id"]
    if category_id is None and effective_payee_id is not None:
        category = payee_service.default_category(db, effective_payee_id)
        category_id = category.id if category else None
    return {
        "transaction": projected,
        "merchant_name": facts[3],
        "matching_rule_ids": matching,
        "deciding_rule_id": result["rule_id"],
        "payee_id": effective_payee_id,
        "category_id": category_id,
        "fallback_name": payee_service.fallback_name(raw) if raw is not None and result["payee_id"] is None else None,
    }


def _payee_preview_evaluation(db: Session, payload) -> dict:
    evaluator, selected = payee_service.preview_evaluator(db, payload.rule, payload.expected_rules_token)
    selected_index = evaluator.items.index(selected)
    lookups = ledger_projection.projection_lookups(db)
    projection = ledger_projection.parent_projection(db, None, lookups=lookups)
    items, decisions = [], {}
    for transaction, projected, blocked in _rule_rows(db, projection):
        facts = _rule_facts(transaction, projected)
        if not evaluator.matches(selected, *facts):
            continue
        earlier = next((item for item in evaluator.items[:selected_index] if evaluator.matches(item, *facts)), None)
        rule_result = evaluator.result_for_item(selected)
        payee_id = selected["payee_id"]
        category_id = rule_result["category_id"]
        if category_id is None and projected["transfer_account_id"] is None:
            category = payee_service.default_category(db, payee_id)
            category_id = category.id if category else None
        changes_category = category_id is not None and not projected["allocations"]
        changes_payee = projected["payee_id"] != payee_id
        relation = projection[transaction.id][1].relation
        changes_retained_payee = any(
            source.payee_id != payee_id
            for source in ledger_projection.payee_assignment_sources(db, transaction, relation, context=lookups)
            if source is not transaction or not changes_payee
        )
        eligible = changes_payee or changes_retained_payee or changes_category and projected["category_id"] != category_id
        eligible = eligible and blocked is None and (not changes_category or "category_id" in projected["editable_fields"])
        items.append(projected)
        decisions[str(projected["id"])] = {
            "earlier_rule_id": earlier["id"] if earlier else None,
            "payee_id": payee_id,
            "category_id": category_id,
            "changes_category": changes_category,
            "changes_retained_payee": changes_retained_payee,
            "eligible": eligible,
            "blocked": blocked,
        }
    items.sort(key=lambda item: ledger_projection.chronology_key(item["date"], item["amount_cents"], item["id"], item["source"]), reverse=True)
    ledger_projection.fill_tokens(db, projection, items, lookups=lookups)
    identity = {
        "rules": payload.expected_rules_token, "draft": selected,
        "outcomes": [(item["id"], item["edit_token"], decisions[str(item["id"])]) for item in items],
        "payee": payee_service.out(db, db.get(Payee, selected["payee_id"])),
        "categories": [(item.id, item.parent_id, item.archived, item.name) for item in db.scalars(select(Category).order_by(Category.id)).all()],
    }
    token = hashlib.sha256(json.dumps(identity, sort_keys=True, default=str).encode()).hexdigest()
    return {"projection": projection, "items": items, "decisions": decisions, "preview_token": token, "counts": {"matching": len(items), "decides": sum(value["earlier_rule_id"] is None for value in decisions.values()), "earlier": sum(value["earlier_rule_id"] is not None for value in decisions.values()), "blocked": sum(value["blocked"] is not None for value in decisions.values()), "applicable": sum(_applicable(value) for value in decisions.values())}}


def payee_preview(db: Session, payload) -> dict:
    evaluated = _payee_preview_evaluation(db, payload)
    items = evaluated["items"]
    before = ledger_projection.chronology_cursor(payload.before_date, payload.before_id, payload.before_order)
    if before is not None:
        items = [item for item in items if ledger_projection.chronology_key(item["date"], item["amount_cents"], item["id"], item["source"]) < before]
    page = items[:100]
    tail = page[-1] if page else None
    return {"rows": page, "total_count": evaluated["counts"]["matching"], "has_more": len(items) > len(page), "next_before_date": tail["date"] if len(items) > len(page) and tail else None, "next_before_id": tail["id"] if len(items) > len(page) and tail else None, "next_before_order": ledger_projection.chronology_rank(tail["amount_cents"], tail["source"]) if len(items) > len(page) and tail else None, "counts": evaluated["counts"], "decisions": {str(item["id"]): evaluated["decisions"][str(item["id"])] for item in page}, "preview_token": evaluated["preview_token"]}


def _applicable(decision: dict) -> bool:
    return decision["eligible"] and decision["earlier_rule_id"] is None


def _evaluate_for_apply(db: Session, payload, preview_token: str) -> dict:
    evaluated = _payee_preview_evaluation(db, payload)
    if evaluated["preview_token"] != preview_token:
        raise AppError("payee_preview_stale", "Rules or preview results changed. Review and select again.", 409)
    return evaluated


def apply_payee_rule(db: Session, payload) -> dict:
    _held_rows = ledger_projection.hold_account_and_category_rows(db)
    evaluated = _evaluate_for_apply(db, payload, payload.preview_token)
    return _apply_rule_decisions(db, evaluated, payload.targets)


def save_and_apply_payee_rule(db: Session, payload) -> None:
    _held_rows = ledger_projection.hold_account_and_category_rows(db)
    evaluated = _evaluate_for_apply(db, payload, payload.apply_preview_token)
    targets = [Target(id=item["id"], edit_token=item["edit_token"]) for item in evaluated["items"] if _applicable(evaluated["decisions"][str(item["id"])])]
    _apply_rule_decisions(db, evaluated, targets)
    payee_service.save_rule(db, payload.rule, payload.expected_rules_token)


def _apply_rule_decisions(db: Session, evaluated: dict, targets) -> dict:
    lookups = ledger_projection.projection_lookups(db)
    selected = ledger_projection.selected_snapshots(db, targets, {"payee_id"}, lookups=lookups)
    for transaction, relationship, projected in selected:
        decision = evaluated["decisions"].get(str(transaction.id))
        if decision is None or not decision["eligible"]:
            raise AppError("payee_preview_stale", "A selected row is no longer eligible.", 409)
        values = {"payee_id": decision["payee_id"]}
        if decision["changes_category"]:
            values["categorization"] = SingleCategorization(kind="single", category_id=decision["category_id"])
        ledger_projection.validate_edit_values(transaction, relationship.relation, values, projected["allowed_actions"], projected["editable_fields"])
        apply_metadata_values(db, transaction, relationship.relation, projected, values)
        if decision["changes_retained_payee"]:
            assign_payee_to_sources(db, transaction, relationship.relation, decision["payee_id"], context=lookups)
        if transaction.source == "manual":
            payee_service.require_assignable(db, ledger_projection.effective_facts(db, transaction)["payee_id"])
    db.flush()
    return {"status": "ok", "rows": [ledger_projection.row(db, transaction) for transaction, _, _ in selected]}


def duplicate_description(db: Session, source_id: int | None, account_id: int) -> str:
    if source_id is None:
        return ""
    source = ledger_projection.read_transaction(db, source_id)
    if "duplicate" not in source["allowed_actions"] or source["account_id"] != account_id:
        raise AppError("duplicate_source_unavailable", "Choose an eligible transaction in this account to duplicate.", 422)
    return source["description"]


def create_manual_transaction(db: Session, payload: TransactionCreate, *, approved: bool = True, description: str | None = None) -> Transaction:
    values = payload.model_dump(exclude={"categorization", "duplicate_source_id"})
    values["description"] = description if description is not None else duplicate_description(db, payload.duplicate_source_id, payload.account_id)
    categorization = payload.categorization
    if db.get(Account, values["account_id"]) is None:
        raise AppError("account_not_found", "Account not found", 422)
    validate_metadata_values(db, values)
    ledger_projection.require_account_initialized(db, values["account_id"])
    txn = Transaction(**values, source="manual", approved=approved, status="uncleared")
    db.add(txn)
    db.flush()
    apply_metadata_values(db, txn, None, ledger_projection.row(db, txn), {"payee_id": txn.payee_id, **({"categorization": categorization} if categorization is not None else {})})
    destination = payee_identity.target(db, txn.transfer_account_id)
    if destination is not None:
        if destination.closed:
            raise AppError("transfer_target_closed", "Closed accounts cannot receive a new transfer.", 422)
        ledger_projection.require_account_initialized(db, destination.id)
    db.flush()
    return txn


def create_transaction(db: Session, payload: TransactionCreate) -> dict:
    if payload.transfer_account_id is not None:
        raise AppError("transfer_review_required", "Review the transfer before saving.", 422)
    txn = create_manual_transaction(db, payload)
    matching.reconcile(db, {txn.account_id}, allow_automatic=True, expire_stale=True, transaction_ids={txn.id})
    db.flush()
    visible = ledger_projection.resolve_relationship(db, txn).parent
    result = ledger_projection.row(db, visible)
    if payload.categorization is not None and payload.categorization.kind == "single":
        result["payee_category_memory"] = remember_entry_category(db, result)
    return result


def edit_transaction(db: Session, transaction_id: int, payload: TransactionUpdate) -> dict:
    txn, values = ledger_projection.require_transaction(db, transaction_id), payload.model_dump(exclude_unset=True)
    review_after_edit = values.pop("review_after_edit", False)
    if "categorization" in values:
        values["categorization"] = payload.categorization
    projected = ledger_projection.row(db, txn)
    if values.get("transfer_account_id") != projected["transfer_account_id"] and values.get("transfer_account_id") is not None:
        raise AppError("transfer_review_required", "Review the transfer before saving.", 422)
    requested_transfer = values.get("transfer_account_id", projected["transfer_account_id"]) is not None
    if projected["allocations"] or projected["transfer"] or requested_transfer or (
        "categorization" in values and values["categorization"].kind == "split"
    ):
        if values.pop("expected_edit_token", None) != projected["edit_token"]:
            raise AppError(
                "transaction_edit_stale",
                "The transaction changed. Reload it before saving.",
                409,
            )
    else:
        values.pop("expected_edit_token", None)
    relation = ledger_projection.resolve_relationship(db, txn).relation
    ledger_projection.validate_edit_values(
        txn,
        relation,
        values,
        projected["allowed_actions"],
        projected["editable_fields"],
    )
    validate_metadata_values(db, values)
    for field, value in values.items():
        if field not in METADATA_FIELDS:
            setattr(txn, field, value)
    if (
        "amount_cents" in values
        and projected["allocations"]
        and "categorization" not in values
    ):
        raise AppError(
            "split_rebalance_required",
            "Changing a split total requires a balanced categorization.",
            422,
        )
    apply_metadata_values(db, txn, relation, projected, values)
    partner = ledger_projection.amount_partner(db, txn) if "amount_cents" in values and projected["transfer"] else None
    if partner is not None:
        transfer_links.set_partner_amount(partner, -txn.amount_cents)
    txn.transfer_payee_confirmed = ledger_projection.effective_facts(db, txn)["transfer_account_id"] is not None
    review_changed = (
        review_after_edit
        and txn.source == "plaid"
        and not projected["approved"]
        and "review" in projected["allowed_actions"]
        and (
            any(field in values and projected[field] != values[field] for field in ("payee_id", "memo"))
            or (
                "categorization" in values
                and allocations.semantic(projected) != allocations.semantic(allocations.requested(values["categorization"]))
            )
        )
    )
    payee_service.require_assignable(db, ledger_projection.effective_facts(db, txn)["payee_id"])
    changed = [txn] if partner is None else [txn, partner]
    matching.reconcile(db, {row.account_id for row in changed}, allow_automatic=True, expire_stale=True, transaction_ids={row.id for row in changed})
    db.flush()
    visible = ledger_projection.resolve_relationship(db, txn).parent
    if review_changed and visible is not None and visible.source == "plaid" and (
        visible.id == txn.id or "review" in ledger_projection.row(db, visible)["allowed_actions"]
    ):
        visible.approved = True
        db.flush()
    result = ledger_projection.row(db, visible)
    if "categorization" in values and values["categorization"].kind == "single" and any(projected.get(field) != result.get(field) for field in ("date", "payee_id", "category_id", "category_assigned", "memo", "amount_cents", "flag")):
        result["payee_category_memory"] = remember_entry_category(db, result)
    return result


def set_clearance(db: Session, transaction_id: int, intent: str) -> dict:
    txn = ledger_projection.require_transaction(db, transaction_id)
    ledger_projection.require_action(db, txn, "clearance")
    txn.status = intent
    db.flush()
    return ledger_projection.row(db, txn)


def review_transactions(db: Session, payload: TransactionReview) -> None:
    txns = [ledger_projection.require_transaction(db, identifier) for identifier in payload.ids]
    for txn in txns:
        ledger_projection.require_action(db, txn, "review")
        txn.approved = payload.approved
    db.flush()
