from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Account, Payee


def target(db: Session, transfer_account_id: int | None) -> Account | None:
    return db.get(Account, transfer_account_id) if transfer_account_id is not None else None


def names(db: Session) -> dict[int, str]:
    return {identifier: identity.name for identifier, identity in identities(db).items()}


class Identity(NamedTuple):
    name: str
    kind: str


def identities(db: Session) -> dict[int, Identity]:
    return {payee.id: Identity(payee.name, payee.kind) for payee in db.scalars(select(Payee)).all()}


def suggested_payee_id(db: Session, account_id: int, target_id: int, amount: int, draft_date) -> int | None:
    from app.services import ledger_projection

    projection = ledger_projection.parent_projection(db, {account_id})
    candidates = [
        (row["date"], transaction.id, row["payee_id"])
        for transaction, relationship, row in projection.values()
        if (transaction.transfer_payee_confirmed or (
            (owner := ledger_projection.field_owner(transaction, relationship.relation, "payee")).transfer_payee_confirmed
            and owner.transfer_account_id == row["transfer_account_id"]
        ))
        and row["transfer_account_id"] == target_id
        and row["date"] <= draft_date
        and (row["amount_cents"] > 0) == (amount > 0)
        and row["payee_kind"] in ("ordinary", "myself")
    ]
    return max(candidates)[2] if candidates else None


def combination_facts(db: Session, first, second):
    first_transfer, second_transfer = [target(db, facts["transfer_account_id"]) for facts in (first, second)]
    return {
        "first_transfer": first_transfer,
        "second_transfer": second_transfer,
        "has_transfer": first_transfer is not None or second_transfer is not None,
        "has_split": bool(first["category"]["allocations"] or second["category"]["allocations"]),
        "targets_conflict": first_transfer is not None and second_transfer is not None and first_transfer.id != second_transfer.id,
    }
