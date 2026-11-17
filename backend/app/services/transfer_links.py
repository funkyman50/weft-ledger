from sqlalchemy.orm import Session

from app.errors import AppError
from app.models import Transaction


def link(source: Transaction, partner: Transaction) -> None:
    source.transfer_partner_id = partner.id
    partner.transfer_partner_id = source.id


def set_partner_amount(partner: Transaction, amount_cents: int) -> None:
    partner.amount_cents = amount_cents
    partner.match_tolerance_cents = 0


def unlink(db: Session, transaction: Transaction) -> None:
    partner = db.get(Transaction, transaction.transfer_partner_id) if transaction.transfer_partner_id else None
    if partner is not None and partner.transfer_partner_id == transaction.id:
        partner.transfer_partner_id = None
    transaction.transfer_partner_id = None


def rehome_anchor(db: Session, donor: Transaction, survivor: Transaction) -> None:
    if donor.transfer_partner_id is None:
        return
    partner = db.get(Transaction, donor.transfer_partner_id)
    if partner is None or partner.transfer_partner_id != donor.id:
        raise AppError("transfer_partner_conflict", "The transfer partner changed. Reopen the lifecycle review.", 409)
    unlink(db, donor)
    # Release both unique partner references before assigning the survivor.
    db.flush()
    link(survivor, partner)
