from collections.abc import Iterable
from itertools import batched
from typing import TypedDict

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import SQL_ID_BATCH_SIZE
from app.errors import AppError
from app.models import Transaction, TransactionAllocation
from app.services import categories


class AllocationSnapshot(TypedDict):
    id: int
    category_id: int | None
    memo: str
    amount_cents: int
    unassigned: bool


class CategorySnapshot(TypedDict):
    category_assigned: bool
    category_id: int | None
    allocations: list[AllocationSnapshot]


def load(
    db: Session, transaction_ids: Iterable[int]
) -> dict[int, list[TransactionAllocation]]:
    identifiers = list(dict.fromkeys(transaction_ids))
    loaded = {identifier: [] for identifier in identifiers}
    for batch in batched(identifiers, SQL_ID_BATCH_SIZE):
        rows = db.scalars(
            select(TransactionAllocation)
            .where(TransactionAllocation.transaction_id.in_(batch))
            .order_by(TransactionAllocation.transaction_id, TransactionAllocation.position)
        ).all()
        for row in rows:
            loaded[row.transaction_id].append(row)
    return loaded


def snapshot(transaction: Transaction, rows: list[TransactionAllocation]) -> CategorySnapshot:
    if rows:
        return {
            "category_assigned": transaction.category_assigned,
            "category_id": None,
            "allocations": [
                {
                    "id": row.id,
                    "category_id": row.category_id,
                    "memo": row.memo,
                    "amount_cents": row.amount_cents,
                    "unassigned": row.unassigned,
                }
                for row in rows
            ],
        }
    return {
        "category_assigned": transaction.category_assigned,
        "category_id": transaction.category_id,
        "allocations": [],
    }


def semantic(snapshot_value: dict) -> tuple:
    return (
        snapshot_value["category_assigned"],
        snapshot_value["category_id"],
        tuple(
            (
                row["category_id"],
                row["memo"],
                row["amount_cents"],
                row["unassigned"],
            )
            for row in snapshot_value["allocations"]
        ),
    )


def requested(payload) -> dict:
    if payload.kind == "single":
        return {
            "category_assigned": True,
            "category_id": payload.category_id,
            "allocations": [],
        }
    return {
        "category_assigned": True,
        "category_id": None,
        "allocations": [item.model_dump() for item in payload.allocations],
    }


def _validate_category(db: Session, category_id: int | None, *, retained: bool, split_from_single: bool) -> None:
    if category_id is not None and not retained and not split_from_single:
        categories.require_assignable(db, category_id)


def replace(
    db: Session,
    transaction: Transaction,
    payload,
    existing: list[TransactionAllocation],
) -> bool:
    desired = requested(payload)
    current = snapshot(transaction, existing)
    if payload.kind == "single":
        _validate_category(
            db,
            payload.category_id,
            retained=payload.category_id == transaction.category_id,
            split_from_single=False,
        )
        if semantic(current) == semantic(desired):
            return False
        for row in existing:
            db.delete(row)
        transaction.category_id = payload.category_id
        transaction.category_assigned = True
        return True

    if transaction.transfer_account_id is not None:
        raise AppError("transfer_split_not_allowed", "Transfers cannot use split allocations", 422)
    rows_by_id = {row.id: row for row in existing}
    seen: set[int] = set()
    total = 0
    for index, item in enumerate(desired["allocations"]):
        identifier = item.get("id")
        if identifier is not None:
            if identifier in seen or identifier not in rows_by_id:
                raise AppError(
                    "allocation_id_invalid",
                    "An allocation line no longer belongs to this transaction",
                    422,
                )
            seen.add(identifier)
        if item["amount_cents"] == 0:
            raise AppError(
                "split_amount_invalid", "Each split amount must be nonzero", 422
            )
        total += item["amount_cents"]
        old = rows_by_id.get(identifier)
        if item["unassigned"]:
            if (
                old is None
                or not old.unassigned
                or item["category_id"] is not None
                or item["amount_cents"] != old.amount_cents
                or item["memo"] != old.memo
            ):
                raise AppError(
                    "unassigned_split_invalid",
                    "Only the current bank difference line can remain unassigned",
                    422,
                )
        retained = old is not None and old.category_id == item["category_id"]
        _validate_category(
            db,
            item["category_id"],
            retained=retained,
            split_from_single=(
                not existing
                and index == 0
                and transaction.category_id == item["category_id"]
            ),
        )
    if len(desired["allocations"]) < 2 or total != transaction.amount_cents:
        raise AppError(
            "split_not_balanced",
            "Split allocations must have at least two lines and equal the transaction total",
            422,
        )
    if semantic(current) == semantic(desired):
        return False
    for row in existing:
        row.position += 1_000_000
    db.flush()
    for row in existing:
        if row.id not in seen:
            db.delete(row)
    db.flush()
    for position, item in enumerate(desired["allocations"]):
        row = rows_by_id.get(item.get("id"))
        if row is None:
            row = TransactionAllocation(
                transaction_id=transaction.id, position=position
            )
            db.add(row)
        row.position = position
        row.category_id = item["category_id"]
        row.memo = item["memo"]
        row.amount_cents = item["amount_cents"]
        row.unassigned = item["unassigned"]
    transaction.category_id = None
    transaction.category_assigned = True
    db.flush()
    return True


def copy(db: Session, source: Transaction, target: Transaction) -> None:
    source_rows = load(db, [source.id])[source.id]
    target_rows = load(db, [target.id])[target.id]
    for row in target_rows:
        db.delete(row)
    db.flush()
    target.category_id = source.category_id
    target.category_assigned = source.category_assigned
    for position, row in enumerate(source_rows):
        db.add(
            TransactionAllocation(
                transaction_id=target.id,
                position=position,
                category_id=row.category_id,
                memo=row.memo,
                amount_cents=row.amount_cents,
                unassigned=row.unassigned,
            )
        )
    db.flush()


def reconcile_bank_difference(db: Session, transaction: Transaction) -> None:
    rows = load(db, [transaction.id])[transaction.id]
    if not rows:
        return
    system = next((row for row in rows if row.unassigned), None)
    ordinary_total = sum(row.amount_cents for row in rows if not row.unassigned)
    difference = transaction.amount_cents - ordinary_total
    if difference == 0:
        if system is not None:
            db.delete(system)
            db.flush()
        return
    if system is None:
        db.add(
            TransactionAllocation(
                transaction_id=transaction.id,
                position=max(row.position for row in rows) + 1,
                category_id=None,
                memo="",
                amount_cents=difference,
                unassigned=True,
            )
        )
    else:
        system.amount_cents = difference
    transaction.category_id = None
    transaction.category_assigned = True
    db.flush()
